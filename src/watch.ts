/**
 * Background watching for Jules sessions.
 *
 * A Jules session runs for minutes in Google's cloud, so a turn that blocks on
 * one wastes the model's time. `jules_watch` instead registers the wait with
 * `ctx.jobs`: the call returns a job id immediately, the harness keeps polling
 * out of band, and `dsh-tool-jobs` delivers a completion notice to the owning
 * agent when the session finishes, fails, or stops to ask something. The model
 * reads the report with `job_output` on a later step.
 *
 * The session state alone is not a completion signal. Jules can post its final
 * answer as an `agentMessaged` activity and then leave `state` sitting at
 * `IN_PROGRESS` indefinitely, so the watcher treats the append-only activity
 * log as authoritative and settles on what the agent did, not only on what the
 * state field says.
 *
 * @module dsh-plugin-jules/watch
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { JobHooks, JobId, JobOutcome } from '@deepseek-ai/dsh-jobs'
import type {} from '@deepseek-ai/dsh-jobs'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { sleep } from './async.ts'
import { JulesError, JulesNotFoundError } from './client.ts'
import type { JulesClient } from './client.ts'
import type { WatchJournal } from './journal.ts'
import type { Activity } from './types.ts'
import { DEFAULT_WAIT_STATES, needsAttentionState, sessionIdOf, settledState } from './types.ts'
import type { WaitResult } from './views.ts'
import { renderWait, sessionDetail } from './views.ts'

declare module '@deepseek-ai/dsh-jobs' {
  interface JobKindMap {
    jules: 'jules'
  }
}

/** Bounds the watcher applies to its own work. */
export interface JulesWatchConfig {
  /** Delay between two status polls. */
  pollIntervalMs: number
  /** Watch budget used when the caller does not choose one. */
  defaultMs: number
  /** Largest watch budget a caller may request. */
  maxMs: number
  /** Activity pages one report may walk. */
  maxActivityPages: number
  /** End the watch when the agent posts a message, not only on a state change. */
  settleOnMessage: boolean
}

/** Why a watch stopped. */
export type WatchTrigger = 'state' | 'message' | 'completed' | 'failed' | 'timeout'

/** What one finished watch observed. */
export interface WatchOutcome {
  /** Why the watch stopped. */
  trigger: WatchTrigger
  /** Short status detail for the job snapshot status line. */
  detail: string
  /** The full report the model reads back with `job_output`. */
  report: string
  /**
   * The structured result. `jules_wait` returns this directly, so the
   * foreground and background paths can never drift apart in what they decide
   * or in what they report.
   */
  wait: WaitResult
}

/** Polling rules for one watch. */
export type WatchOptions = Pick<JulesWatchConfig, 'pollIntervalMs' | 'maxActivityPages' | 'settleOnMessage'>

/** Attempts allowed for a read that may race session creation. */
const VISIBILITY_ATTEMPTS = 4

/**
 * First delay between visibility attempts, in milliseconds. The wait is short
 * on purpose: the race resolves in about a second in practice, and this same
 * bound is what a genuinely bad session id costs before it reports.
 */
const VISIBILITY_DELAY_MS = 500

/**
 * Read something that may not be visible yet.
 *
 * A session created moments ago answers `Requested entity was not found` for its
 * first read: Jules mints the id before the resource is queryable, which is why
 * the official SDK retries the first request on a 404. Only a not-found is
 * retried, and only while it keeps saying so — a genuinely bad id still reports
 * once the attempts are spent.
 * @param operation - the read to attempt.
 * @param signal - task-owned cancellation signal.
 * @returns the operation's result.
 * @throws the last failure once the attempts are exhausted, or any other error at once.
 */
async function readWhenVisible<T>(operation: () => Promise<T>, signal: AbortSignal): Promise<T> {
  let lastError: unknown
  for (let attempt = 1; attempt <= VISIBILITY_ATTEMPTS; attempt += 1) {
    try {
      return await operation()
    } catch (error) {
      if (!(error instanceof JulesNotFoundError)) throw error
      lastError = error
      if (attempt === VISIBILITY_ATTEMPTS) break
      await sleep(VISIBILITY_DELAY_MS * attempt, signal)
    }
  }
  throw lastError
}

/**
 * Stable identity of one activity, for de-duplicating a re-read page.
 * @param activity - one activity from the log.
 * @returns a key that is stable across reads of the same activity.
 */
function activityKey(activity: Activity): string {
  return activity.id ?? activity.name ?? `${activity.createTime ?? ''}:${activity.originator ?? ''}`
}

/**
 * Read one page without re-recording what an earlier page already produced.
 * @param collected - the running log for this watch, appended in place.
 * @param seen - identities already recorded.
 * @param page - the newest page from the service.
 * @returns only the activities this watch had not seen before.
 */
function absorb(collected: Activity[], seen: Set<string>, page: readonly Activity[]): Activity[] {
  const fresh: Activity[] = []
  for (const activity of page) {
    const key = activityKey(activity)
    if (seen.has(key)) continue
    seen.add(key)
    collected.push(activity)
    fresh.push(activity)
  }
  return fresh
}

/**
 * The newest `createTime` in a set of activities, used as the next cursor.
 * @param activities - activities already collected.
 * @returns the newest timestamp, or undefined when none carries one.
 */
function newestTime(activities: readonly Activity[]): string | undefined {
  let newest: string | undefined
  for (const activity of activities) {
    const time = activity.createTime
    if (time !== undefined && (newest === undefined || time > newest)) newest = time
  }
  return newest
}

/**
 * Poll one session until the agent hands something back, then describe it.
 *
 * Separated from the job adapter so the settling rules — which states end a
 * watch, which activities end it, when the budget expires, and what the report
 * contains — are testable without a live agent owner or a real job registry.
 * @param client - the configured Jules client.
 * @param session - bare session id.
 * @param targets - states that end the watch.
 * @param budgetMs - total watch budget.
 * @param config - polling rules.
 * @param signal - task-owned cancellation signal.
 * @returns why the watch stopped and the rendered report.
 * @throws whatever the client throws, including cancellation.
 */
export async function runWatch(
  client: JulesClient,
  session: string,
  targets: ReadonlySet<string>,
  budgetMs: number,
  config: WatchOptions,
  signal: AbortSignal,
): Promise<WatchOutcome> {
  const started = Date.now()
  let polls = 0
  let trigger: WatchTrigger = 'state'

  // One cursor over an append-only log: the first read establishes it and each
  // later poll asks only for what is new. The cursor is a bandwidth
  // optimisation, so identity de-duplication carries correctness on its own —
  // a rejected or ignored cursor costs requests, never a wrong answer.
  const collected: Activity[] = []
  const seen = new Set<string>()
  absorb(collected, seen, await readWhenVisible(
    () => client.listAllActivities(session, {
      signal,
      maxPages: config.maxActivityPages,
      pageSize: 100,
    }),
    signal,
  ))
  let cursor = newestTime(collected)
  let cursorUsable = true
  let current = await readWhenVisible(() => client.getSession(session, signal), signal)
  polls += 1
  let previousState = current.state ?? 'STATE_UNSPECIFIED'
  // Only what happens after the watch starts is news. The baseline is kept for
  // the report but never settles the watch on its own: the caller who just
  // answered the agent's question does not need it reported back.
  let fresh: Activity[] = []

  for (;;) {
    const state = current.state ?? 'STATE_UNSPECIFIED'
    // Terminal means nothing more will ever arrive, so report it at once even
    // when the watch started after the fact.
    if (settledState(state)) {
      trigger = 'state'
      break
    }
    // An attention state settles the watch only when the session moved into it.
    // Settling on the state it started in would make the ordinary
    // "answer the agent, then watch for its reply" flow return instantly on the
    // stale pre-answer state, which is no news at all.
    if (targets.has(state) && state !== previousState) {
      trigger = 'state'
      break
    }
    // Terminal activities outrank everything: the log is the authority for what
    // actually happened, and a failed session must never wait out its budget.
    if (collected.some(activity => activity.sessionFailed !== undefined)) {
      trigger = 'failed'
      break
    }
    if (collected.some(activity => activity.sessionCompleted !== undefined)) {
      trigger = 'completed'
      break
    }
    // A message posted since the watch began: the agent has handed something
    // back, whether a question or a finished report, and may leave `state`
    // reading IN_PROGRESS while it waits.
    if (config.settleOnMessage && fresh.some(activity => activity.agentMessaged !== undefined)) {
      trigger = 'message'
      break
    }
    const elapsed = Date.now() - started
    if (elapsed >= budgetMs) {
      trigger = 'timeout'
      break
    }
    // Never oversleep past the deadline: a long poll interval must not turn a
    // short budget into a much longer watch.
    previousState = state
    await sleep(Math.min(config.pollIntervalMs, Math.max(250, budgetMs - elapsed)), signal)
    current = await client.getSession(session, signal)
    polls += 1
    let page: Awaited<ReturnType<JulesClient['listActivities']>>
    try {
      page = await client.listActivities(session, {
        signal,
        pageSize: 100,
        ...cursorUsable && cursor !== undefined ? { since: cursor } : {},
      })
    } catch (error) {
      // The cursor form is not in the API reference — the documented
      // `?createTime=` parameter is rejected outright — so a 400 here means this
      // deployment does not take the filter either. Drop the cursor rather than
      // the watch: de-duplication already makes correctness independent of it.
      if (!cursorUsable || !(error instanceof JulesError) || error.status !== 400) throw error
      cursorUsable = false
      page = await client.listActivities(session, { signal, pageSize: 100 })
    }
    fresh = absorb(collected, seen, page.activities ?? [])
    cursor = newestTime(collected) ?? cursor
  }

  const detail = sessionDetail(current, collected)
  const waitedMs = Date.now() - started
  const wait: WaitResult = {
    id: detail.id,
    title: detail.title,
    state: detail.state,
    url: detail.url,
    settled: settledState(detail.state),
    timedOut: trigger === 'timeout',
    needsAttention: needsAttentionState(detail.state),
    waitedMs,
    polls,
    planId: detail.planId,
    planSteps: detail.planSteps,
    pullRequests: detail.pullRequests,
    lastMessage: detail.lastMessage,
    lastProgress: detail.lastProgress,
  }
  return {
    trigger,
    detail: describeWatch(trigger, detail.state, waitedMs),
    report: renderWait(wait),
    wait,
  }
}

/**
 * One short phrase describing why a watch stopped, for the job status line.
 * @param trigger - why the watch stopped.
 * @param state - the session state at settle time.
 * @param waitedMs - how long the watch ran.
 * @returns the status detail.
 */
function describeWatch(trigger: WatchTrigger, state: string, waitedMs: number): string {
  const seconds = Math.round(waitedMs / 1000)
  if (trigger === 'timeout') return `still ${state} after ${seconds}s`
  if (trigger === 'failed') return `session failed (${state})`
  if (trigger === 'completed') return `session completed (${state})`
  // "checkpoint" not "finished": an agent message means the floor is the
  // caller's, and the session may well keep going once they answer.
  if (trigger === 'message') return `checkpoint: agent message (${state})`
  return `session ${state}`
}

/**
 * Register `jules_watch`.
 *
 * Registered through `ctx.inject(['jobs'])` rather than a plugin-level
 * injection, so a composition without the job registry still gets the rest of
 * the tool family instead of holding the whole plugin pending forever.
 * @param ctx - plugin context supplying the job registry.
 * @param client - the configured Jules client.
 * @param config - watch budgets and polling bounds.
 * @param journal - durable record of armed watches, when storage is mounted.
 */
export function registerJulesWatch(
  ctx: Context,
  client: JulesClient,
  config: JulesWatchConfig,
  journal: () => WatchJournal | undefined,
  live: Set<string>,
): void {
  ctx.tools.register(defineTool({
    name: 'jules_watch',
    description: 'Watch a Jules session in the background — this is how you wait for one. Returns a job id immediately and notifies '
      + 'you when the session completes, fails, needs a plan decision, or the agent posts a message; read the report with job_output. '
      + 'Call it once, then END YOUR TURN and do other work. Do not poll jules_status alongside it: the notice is the signal, and nothing '
      + 'you check in the meantime will have changed.',
    parameters: {
      session: { type: 'string', required: true, description: 'Session id, "sessions/<id>", or the session URL.' },
      timeoutMs: {
        type: 'number',
        description: 'How long to keep watching before giving up, in milliseconds. '
          + 'Defaults to the configured watchDefaultMs and is capped by watchMaxMs.',
      },
      until: {
        type: 'array',
        description: 'Session states that end the watch. Defaults to completion, failure, a pending plan, and a question.',
        items: { type: 'string' },
      },
    },
    output: {
      schema: {
        type: 'object', additionalProperties: false,
        properties: {
          kind: { type: 'string', required: true, const: 'background' },
          jobId: { type: 'string', required: true },
        },
      },
      render: (args, value) => [{
        type: 'text',
        text: `Watching Jules session ${args.session} in the background as job ${value.jobId}. `
          + 'You will be notified when it finishes or needs you; read the report with job_output. '
          + 'Do not poll it; continue with other work.',
      }],
    },
    // Read-only against the service: it registers local work and asks Jules for
    // nothing new, so watching several sessions in one turn may overlap.
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const owner: Agent | undefined = exec.agent
      if (owner === undefined) {
        throw new Error('jules_watch requires an agent Session, because the completion notice is delivered to the session that started the watch')
      }
      const session = sessionIdOf(args.session)
      const requested = args.timeoutMs ?? config.defaultMs
      // Floored at 30s: a watch shorter than the poll interval cannot observe
      // anything, so a caller asking for one would pay for a job that reports
      // only the state it already had. Ceilinged by config so a caller cannot
      // pin a poller on this machine indefinitely.
      const budget = Math.max(30_000, Math.min(Math.trunc(requested), config.maxMs))
      const targets = new Set<string>(
        args.until === undefined || args.until.length === 0 ? DEFAULT_WAIT_STATES : args.until,
      )
      const jobId = startWatchJob(ctx, client, owner, session, targets, budget, config, journal, live)
      return { kind: 'background' as const, jobId: String(jobId) }
    },
  }))
}

/**
 * Start the polling job and return its id.
 *
 * The controller is task-owned rather than the tool call's: once the job id is
 * published the model is tracking that work, so a later cancellation of the
 * originating call must not silently kill it. `job_kill`, owner disposal,
 * and service teardown own this lifetime instead.
 * @param ctx - plugin context supplying the job registry.
 * @param client - the configured Jules client.
 * @param owner - the agent that receives the completion notice.
 * @param session - bare session id.
 * @param targets - states that end the watch.
 * @param budgetMs - total watch budget.
 * @param config - polling bounds.
 * @returns the registry-issued job id.
 */
function startWatchJob(
  ctx: Context,
  client: JulesClient,
  owner: Agent,
  session: string,
  targets: ReadonlySet<string>,
  budgetMs: number,
  config: JulesWatchConfig,
  journal: () => WatchJournal | undefined,
  live: Set<string>,
): JobId {
  const controller = new AbortController()
  let cancelled = false
  let settle: (outcome: JobOutcome) => void = () => {}
  const done = new Promise<JobOutcome>((resolve) => { settle = resolve })

  const watch = async (): Promise<void> => {
    try {
      const outcome = await runWatch(client, session, targets, budgetMs, config, controller.signal)
      // The watch itself succeeded. A failed or waiting *session* is reported in
      // the detail and the report, not as a broken job.
      settle({ status: 'completed', detail: outcome.detail, output: outcome.report })
      // It reached its own conclusion, so the journal has nothing left to
      // report. A kill or a teardown deliberately does NOT release: a teardown
      // is precisely the restart this journal exists to survive.
      live.delete(session)
      void journal()?.release(session)
    } catch (error) {
      if (cancelled) {
        settle({ status: 'killed', detail: 'watch cancelled' })
        return
      }
      settle({ status: 'failed', detail: error instanceof Error ? error.message : String(error) })
    }
  }

  const jobId = ctx.jobs.start({
    kind: 'jules',
    label: `session ${session}`,
    owner,
    run: (): JobHooks => {
      void watch()
      return {
        cancel: (reason?: string): void => {
          if (cancelled) return
          cancelled = true
          controller.abort(new Error(reason ?? 'watch cancelled'))
        },
        done,
      }
    },
  })
  // Recorded only once the registry has accepted the job, so a refusal at the
  // concurrency cap leaves no phantom entry behind.
  const opened = journal()
  if (opened !== undefined) {
    const armedAt = Date.now()
    live.add(session)
    void opened.arm({ session, startedAt: armedAt, expiresAt: armedAt + budgetMs })
  }
  return jobId
}
