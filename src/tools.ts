/**
 * The model-facing `jules_*` tool family.
 *
 * Every tool returns a canonical value described by its own output schema and
 * renders that value to text separately, so a caller that needs an id or a
 * state never has to parse the prose.
 *
 * @module dsh-plugin-jules/tools
 */

import type { Context } from '@deepseek-ai/cordis'
import { defineTool, type ValueSchemaSpec } from '@deepseek-ai/dsh-tools'
import { sleep } from './async.ts'
import type { JulesClient } from './client.ts'
import type { Activity } from './types.ts'
import { DEFAULT_WAIT_STATES, sessionIdOf, sourceNameOf } from './types.ts'
import {
  activityRow, latestPatch, patchFiles, renderActivities, renderPatch, renderSessionDetail,
  renderSessionRows, renderSources, renderWait, sessionDetail, sessionRow, sourceRow,
} from './views.ts'
import { runWatch } from './watch.ts'

/** Bounds the tool family applies to its own inputs. */
export interface JulesToolConfig {
  /** Largest unified diff `jules_patch` will return. */
  maxPatchBytes: number
  /** Wait budget `jules_wait` uses when the caller does not choose one. */
  waitDefaultMs: number
  /** Upper bound a caller may raise the wait budget to. */
  waitMaxMs: number
  /** Delay between two status polls inside `jules_wait`. */
  pollIntervalMs: number
  /** Pages of activities a single read may walk. */
  maxActivityPages: number
  /** End a wait or watch when the agent posts a message, not only on a state change. */
  settleOnMessage: boolean
  /** Repository `jules_create` targets when the call omits one, as `owner/repo`. */
  defaultSource: string
}

/** Attempts allowed for an approval to become visible in the log. */
const APPROVAL_CONFIRM_ATTEMPTS = 3

/**
 * First delay between approval-confirmation reads, in milliseconds. Short
 * because the lag is normally sub-second; the total window is the interesting
 * number, and it stays inside a tool call's patience.
 */
const APPROVAL_CONFIRM_DELAY_MS = 750

/**
 * Whether one activity is the plan-approval event.
 * @param activity - one activity from the log.
 * @returns whether the plan was approved.
 */
function isPlanApproved(activity: Activity): boolean {
  return activity.planApproved !== undefined
}

/**
 * The sentence that leads an approval reply.
 *
 * Three outcomes, and they are not interchangeable: confirmed, sent with the
 * event not yet visible, and sent with the log unreadable. Reporting the third
 * as the second would read as a failed approval when nothing is known either way.
 * @param id - session id.
 * @param confirmed - whether the planApproved event was observed.
 * @param logRead - whether the log could be read at all.
 * @returns the leading sentence.
 */
function approvalLead(id: string, confirmed: boolean, logRead: boolean): string {
  if (confirmed) return `Approved the plan for session ${id}; the planApproved event is in the log.`
  if (!logRead) {
    return `Approval sent for session ${id}, but the activity log could not be read, so it could not be verified `
      + 'either way. Check jules_activities rather than assuming it failed.'
  }
  return `Approval sent for session ${id}, but its planApproved event had not appeared after `
    + APPROVAL_CONFIRM_ATTEMPTS + ' reads. That is the service lagging, not a failed approval — '
    + 'confirm with jules_activities before assuming anything.'
}

/** One progress row shared by the session and wait projections. */
const GENERATED_FILE_SCHEMA = {
  type: 'object', additionalProperties: false,
  properties: {
    path: { type: 'string', required: true },
    changeType: { type: 'string', required: true },
    bytes: { type: 'integer', required: true },
  },
} satisfies ValueSchemaSpec

/** The full session projection returned by create, status, approve, and message. */
const SESSION_DETAIL_SCHEMA = {
  type: 'object', additionalProperties: false,
  properties: {
    id: { type: 'string', required: true },
    title: { type: 'string', required: true },
    state: { type: 'string', required: true },
    url: { type: 'string', required: true },
    prompt: { type: 'string', required: true },
    source: { type: 'string', required: true },
    branch: { type: 'string', required: true },
    requirePlanApproval: { type: 'string', required: true, description: 'yes | no | unknown — the service does not echo this create-time input, so unknown beats a fabricated no.' },
    autoCreatePr: { type: 'string', required: true },
    archived: { type: 'boolean', required: true },
    createTime: { type: 'string', required: true },
    updateTime: { type: 'string', required: true },
    planId: { type: 'string', required: true },
    planSteps: { type: 'array', required: true, items: { type: 'string' } },
    planPending: { type: 'boolean', required: true },
    planApproved: { type: 'boolean', required: true },
    pullRequests: { type: 'array', required: true, items: { type: 'string' } },
    generatedFiles: { type: 'array', required: true, items: GENERATED_FILE_SCHEMA },
    latestCommand: { type: 'string', required: true },
    lastMessage: { type: 'string', required: true },
    lastProgress: { type: 'string', required: true },
    unchangedForMs: { type: 'integer', required: true },
    approvalConfirmed: { type: 'boolean', required: true },
    logRead: { type: 'boolean', required: true },
  },
} satisfies ValueSchemaSpec

/** One session row in the `jules_list` projection. */
const SESSION_ROW_SCHEMA = {
  type: 'object', additionalProperties: false,
  properties: {
    id: { type: 'string', required: true },
    title: { type: 'string', required: true },
    state: { type: 'string', required: true },
    url: { type: 'string', required: true },
    source: { type: 'string', required: true },
    branch: { type: 'string', required: true },
    createTime: { type: 'string', required: true },
    updateTime: { type: 'string', required: true },
    pullRequests: { type: 'array', required: true, items: { type: 'string' } },
  },
} satisfies ValueSchemaSpec

/** The `jules_sources` projection. */
const SOURCE_SCHEMA = {
  type: 'object', additionalProperties: false,
  properties: {
    name: { type: 'string', required: true },
    owner: { type: 'string', required: true },
    repo: { type: 'string', required: true },
    isPrivate: { type: 'boolean', required: true },
    defaultBranch: { type: 'string', required: true },
    branches: { type: 'array', required: true, items: { type: 'string' } },
  },
} satisfies ValueSchemaSpec

/** One activity row in the `jules_activities` projection. */
const ACTIVITY_SCHEMA = {
  type: 'object', additionalProperties: false,
  properties: {
    id: { type: 'string', required: true },
    time: { type: 'string', required: true },
    originator: { type: 'string', required: true },
    kind: { type: 'string', required: true },
    summary: { type: 'string', required: true },
    artifacts: { type: 'array', required: true, items: { type: 'string' } },
  },
} satisfies ValueSchemaSpec

/** The `jules_wait` projection. */
const WAIT_SCHEMA = {
  type: 'object', additionalProperties: false,
  properties: {
    id: { type: 'string', required: true },
    title: { type: 'string', required: true },
    state: { type: 'string', required: true },
    url: { type: 'string', required: true },
    settled: { type: 'boolean', required: true },
    timedOut: { type: 'boolean', required: true },
    needsAttention: { type: 'boolean', required: true },
    waitedMs: { type: 'integer', required: true },
    polls: { type: 'integer', required: true },
    planId: { type: 'string', required: true },
    planSteps: { type: 'array', required: true, items: { type: 'string' } },
    pullRequests: { type: 'array', required: true, items: { type: 'string' } },
    lastMessage: { type: 'string', required: true },
    lastProgress: { type: 'string', required: true },
  },
} satisfies ValueSchemaSpec

/** The `jules_patch` projection. */
const PATCH_SCHEMA = {
  type: 'object', additionalProperties: false,
  properties: {
    id: { type: 'string', required: true },
    found: { type: 'boolean', required: true },
    patch: { type: 'string', required: true },
    bytes: { type: 'integer', required: true },
    truncated: { type: 'boolean', required: true },
    offset: { type: 'integer', required: true },
    nextOffset: { type: 'integer', required: true },
    files: { type: 'array', required: true, items: { type: 'string' } },
    baseCommitId: { type: 'string', required: true },
    suggestedCommitMessage: { type: 'string', required: true },
    source: { type: 'string', required: true },
  },
} satisfies ValueSchemaSpec

/**
 * Read a session and its event log, tolerating a log that cannot be read yet.
 *
 * A session created moments ago can exist before its first activity does, so a
 * failed read degrades the projection rather than failing the call.
 * @param client - the Jules client.
 * @param id - bare session id.
 * @param signal - the call's cancellation signal.
 * @param maxPages - activity page cap.
 * @returns the session, whatever activities were readable, and whether the read worked.
 */
async function readSessionDetail(
  client: JulesClient, id: string, signal: AbortSignal, maxPages: number,
): Promise<{
  session: Awaited<ReturnType<JulesClient['getSession']>>
  activities: Awaited<ReturnType<JulesClient['listAllActivities']>>
  logRead: boolean
}> {
  const session = await client.getSession(id, signal)
  try {
    return { session, activities: await client.listAllActivities(id, { signal, maxPages, pageSize: 100 }), logRead: true }
  } catch (error) {
    // The session itself was readable, so the call still has something to
    // report — but an unreadable log must never masquerade as an empty one.
    // `logRead` is what keeps "no plan pending" from meaning "we could not look".
    if (signal.aborted) throw error
    return { session, activities: [], logRead: false }
  }
}

/**
 * Register every `jules_*` tool.
 *
 * Concurrency classification is a rule, not a per-tool judgement: every
 * read-only tool declares itself concurrency-safe so sibling calls may overlap,
 * and exactly the three that ask the service to change something —
 * `jules_create`, `jules_approve_plan`, `jules_send_message` — leave it unset so
 * the pipeline serializes them against their siblings. Marking a mutating tool
 * safe would let two approvals race, and marking a reader unsafe would make a
 * batch of status checks run one at a time for no reason.
 * @param ctx - plugin context supplying the tool registry.
 * @param client - the configured Jules client.
 * @param config - bounds applied to tool inputs.
 */
export function registerJulesTools(ctx: Context, client: JulesClient, config: JulesToolConfig): void {
  /**
   * The last observation of each session, per caller, so a repeat `jules_status`
   * can say that it learned nothing. Keyed by the agent instance rather than an
   * id so two agents never see each other's reads, with a shared bucket for
   * callers that have no agent.
   */
  type Observation = { signature: string; at: number }
  const seenByAgent = new WeakMap<object, Map<string, Observation>>()
  const seenWithoutAgent = new Map<string, Observation>()

  /**
   * Record this look and report how long the same answer has been standing.
   * @param agent - the calling agent, when there is one.
   * @param session - bare Jules session id.
   * @param signature - everything that would change if the session moved.
   * @returns milliseconds since the identical observation, or 0 when it is new.
   */
  const observe = (agent: object | undefined, session: string, signature: string): number => {
    let store: Map<string, Observation>
    if (agent === undefined) {
      store = seenWithoutAgent
    } else {
      const existing = seenByAgent.get(agent)
      if (existing === undefined) {
        store = new Map<string, Observation>()
        seenByAgent.set(agent, store)
      } else {
        store = existing
      }
    }
    const previous = store.get(session)
    const at = Date.now()
    store.set(session, { signature, at })
    return previous !== undefined && previous.signature === signature ? at - previous.at : 0
  }

  ctx.tools.register(defineTool({
    name: 'jules_sources',
    description: 'List the repositories connected to Jules. A repository must appear here before jules_create can target it. '
      + 'Jules is a remote coding agent: it clones the repository, plans, edits files, and can open a pull request on its own.',
    parameters: {
      pageSize: { type: 'number', description: 'Repositories per page, 1-100.' },
      pageToken: { type: 'string', description: 'Continuation token from a previous call.' },
    },
    output: {
      schema: {
        type: 'object', additionalProperties: false,
        properties: {
          sources: { type: 'array', required: true, items: SOURCE_SCHEMA },
          nextPageToken: { type: 'string', required: true },
        },
      },
      render: (_args, value) => {
        const body = renderSources(value.sources)
        return [{
          type: 'text',
          text: value.nextPageToken.length === 0 ? body : `${body}\n(nextPageToken: ${value.nextPageToken})`,
        }]
      },
    },
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const response = await client.listSources({
        ...args.pageSize === undefined ? {} : { pageSize: args.pageSize },
        ...args.pageToken === undefined ? {} : { pageToken: args.pageToken },
        signal: exec.signal,
      })
      return {
        sources: (response.sources ?? []).map(sourceRow),
        nextPageToken: response.nextPageToken ?? '',
      }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'jules_create',
    description: 'Start a Jules session: give the remote agent a task in a repository and return immediately with a session id. '
      + 'Jules works asynchronously in the cloud, so follow up with jules_wait or jules_status rather than expecting the work to be done. '
      + 'Set requirePlanApproval to review the plan before any file is edited, and autoCreatePr to have Jules open a pull request when it finishes. '
      + 'Omit source to run a repoless session that only needs reasoning or new files.',
    parameters: {
      prompt: { type: 'string', required: true, description: 'The task, as you would brief a capable engineer. Be specific about the desired outcome.' },
      source: { type: 'string', description: 'Repository as "owner/repo" or "sources/github/owner/repo". Omit for a repoless session.' },
      branch: { type: 'string', description: 'Branch Jules starts from. Defaults to the repository default branch.' },
      title: { type: 'string', description: 'Short session title. Jules generates one when omitted.' },
      requirePlanApproval: { type: 'boolean', description: 'Wait for an explicit jules_approve_plan before editing files. Recommended for changes to existing code.' },
      autoCreatePr: { type: 'boolean', description: 'Open a pull request automatically when the session completes.' },
    },
    output: {
      schema: SESSION_DETAIL_SCHEMA,
      render: (_args, value) => [{
        type: 'text',
        text: `Started Jules session ${value.id} (${value.state}).\n${renderSessionDetail(value)}\n`
          + (value.requirePlanApproval
            ? `Next: jules_wait with session "${value.id}" until the plan is ready, then jules_approve_plan.`
            : `Next: jules_wait with session "${value.id}" to follow it to completion.`),
      }],
    },
    async execute(args, exec) {
      if (args.prompt.trim().length === 0) throw new Error('jules_create requires a non-empty prompt')
      const source = args.source ?? (config.defaultSource.length === 0 ? undefined : config.defaultSource)
      const session = await client.createSession({
        prompt: args.prompt,
        ...args.title === undefined ? {} : { title: args.title },
        ...args.requirePlanApproval === undefined ? {} : { requirePlanApproval: args.requirePlanApproval },
        ...args.autoCreatePr === true ? { automationMode: 'AUTO_CREATE_PR' } : {},
        ...source === undefined || source.trim().length === 0 ? {} : {
          sourceContext: {
            source: sourceNameOf(source),
            ...args.branch === undefined ? {} : { githubRepoContext: { startingBranch: args.branch } },
          },
        },
      }, exec.signal)
      return sessionDetail(session)
    },
  }))

  ctx.tools.register(defineTool({
    name: 'jules_list',
    description: 'List recent Jules sessions visible to this credential, newest first. A one-off survey — not a way to wait for progress.',
    parameters: {
      pageSize: { type: 'number', description: 'Sessions per page, 1-100.' },
      pageToken: { type: 'string', description: 'Continuation token from a previous call.' },
    },
    output: {
      schema: {
        type: 'object', additionalProperties: false,
        properties: {
          sessions: { type: 'array', required: true, items: SESSION_ROW_SCHEMA },
          nextPageToken: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: renderSessionRows(value.sessions, value.nextPageToken) }],
    },
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const response = await client.listSessions({
        ...args.pageSize === undefined ? {} : { pageSize: args.pageSize },
        ...args.pageToken === undefined ? {} : { pageToken: args.pageToken },
        signal: exec.signal,
      })
      return {
        sessions: (response.sessions ?? []).map(sessionRow),
        nextPageToken: response.nextPageToken ?? '',
      }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'jules_status',
    description: 'Read one Jules session in full: state, generated plan, pull requests, produced files, and the latest command. '
      + 'Call it once to confirm an action you just took, to follow up a jules_watch notice, or when the user asks about a session — '
      + 'NOT in a loop to wait for progress. Waiting is jules_watch (background) or jules_wait (foreground); both report this same '
      + 'detail when they settle, so repeating this call only burns turns.',
    parameters: {
      session: { type: 'string', required: true, description: 'Session id, "sessions/<id>", or the session URL.' },
    },
    output: {
      schema: SESSION_DETAIL_SCHEMA,
      render: (_args, value) => [{ type: 'text', text: renderSessionDetail(value) }],
    },
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const id = sessionIdOf(args.session)
      const { session, activities, logRead } = await readSessionDetail(client, id, exec.signal, config.maxActivityPages)
      // Everything that would differ if the session had moved. A repeat of the
      // same signature is the signal that this call was not worth making.
      const signature = [
        session.state ?? '',
        session.updateTime ?? '',
        String(activities.length),
        activities[activities.length - 1]?.id ?? '',
      ].join('|')
      return sessionDetail(session, activities, { unchangedForMs: observe(exec.agent, id, signature), logRead })
    },
  }))

  ctx.tools.register(defineTool({
    name: 'jules_activities',
    description: 'Read a Jules session event log, oldest first: plan generation and approval, agent and user messages, progress updates, '
      + 'completion or failure, and a summary of every artifact. Use it to see what the agent actually did, to diagnose a stall, or to '
      + 'follow up a jules_watch notice — not to poll for progress.',
    parameters: {
      session: { type: 'string', required: true, description: 'Session id, "sessions/<id>", or the session URL.' },
      pageSize: { type: 'number', description: 'Activities per page, 1-100.' },
      pageToken: { type: 'string', description: 'Continuation token from a previous call.' },
      since: { type: 'string', description: 'RFC 3339 timestamp; return only activities created after it, for polling a long session.' },
    },
    output: {
      schema: {
        type: 'object', additionalProperties: false,
        properties: {
          activities: { type: 'array', required: true, items: ACTIVITY_SCHEMA },
          nextPageToken: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: renderActivities(value.activities, value.nextPageToken) }],
    },
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const id = sessionIdOf(args.session)
      const response = await client.listActivities(id, {
        ...args.pageSize === undefined ? {} : { pageSize: args.pageSize },
        ...args.pageToken === undefined ? {} : { pageToken: args.pageToken },
        ...args.since === undefined ? {} : { since: args.since },
        signal: exec.signal,
      })
      return {
        activities: (response.activities ?? []).map(activityRow),
        nextPageToken: response.nextPageToken ?? '',
      }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'jules_approve_plan',
    description: 'Approve the plan a Jules session is waiting on, which lets the agent start editing files. '
      + 'Only call this after jules_status or jules_activities showed the plan and you consider it correct. '
      + 'To change it instead, use jules_send_message with the corrections.',
    parameters: {
      session: { type: 'string', required: true, description: 'Session id, "sessions/<id>", or the session URL.' },
    },
    output: {
      schema: SESSION_DETAIL_SCHEMA,
      render: (_args, value) => [{
        type: 'text',
        text: approvalLead(value.id, value.approvalConfirmed, value.logRead) + '\n' + renderSessionDetail(value),
      }],
    },
    async execute(args, exec) {
      const id = sessionIdOf(args.session)
      await client.approvePlan(id, exec.signal)
      // :approvePlan returning is not evidence that the approval is readable.
      // The service is eventually consistent about its own actions, so its
      // planApproved event lags — and a snapshot taken immediately reported
      // planApproved false, or a phase that had already moved on, for approvals
      // that had in fact landed. Poll for the event and report whether it was
      // seen, rather than handing back the race.
      const read = (): Promise<Activity[]> => client.listAllActivities(id, {
        signal: exec.signal,
        maxPages: config.maxActivityPages,
        pageSize: 100,
      })
      // A read failure here must not be reported as an unconfirmed approval, nor
      // thrown away: the approval may well have landed, and the caller needs to
      // know that we could not look rather than that we looked and saw nothing.
      let activities: Activity[] = []
      let logRead = true
      let confirmed = false
      try {
        activities = await read()
        confirmed = activities.some(isPlanApproved)
        for (let attempt = 1; !confirmed && attempt <= APPROVAL_CONFIRM_ATTEMPTS; attempt += 1) {
          await sleep(APPROVAL_CONFIRM_DELAY_MS * attempt, exec.signal)
          activities = await read()
          confirmed = activities.some(isPlanApproved)
        }
      } catch (error) {
        if (exec.signal.aborted) throw error
        logRead = false
      }
      const session = await client.getSession(id, exec.signal)
      return sessionDetail(session, activities, { approvalConfirmed: confirmed, logRead })
    },
  }))

  ctx.tools.register(defineTool({
    name: 'jules_send_message',
    description: 'Send a message to a Jules session: answer a question it asked, correct its plan, or give it follow-up work. '
      + 'The agent replies asynchronously, so read jules_activities afterwards.',
    parameters: {
      session: { type: 'string', required: true, description: 'Session id, "sessions/<id>", or the session URL.' },
      prompt: { type: 'string', required: true, description: 'What to tell the agent.' },
    },
    output: {
      schema: SESSION_DETAIL_SCHEMA,
      render: (_args, value) => [{
        type: 'text',
        text: `Sent the message to session ${value.id} (now ${value.state}).\n${renderSessionDetail(value)}`,
      }],
    },
    async execute(args, exec) {
      if (args.prompt.trim().length === 0) throw new Error('jules_send_message requires a non-empty prompt')
      const id = sessionIdOf(args.session)
      await client.sendMessage(id, args.prompt, exec.signal)
      const { session, activities, logRead } = await readSessionDetail(client, id, exec.signal, config.maxActivityPages)
      return sessionDetail(session, activities, { logRead })
    },
  }))

  ctx.tools.register(defineTool({
    name: 'jules_wait',
    description: 'Hold the turn open until a Jules session finishes, fails, needs a plan decision, or posts a message, then report what '
      + 'happened. Use it only when you genuinely have nothing else to do until the answer arrives — prefer jules_watch, which waits in '
      + 'the background and lets your turn end. Neither is a licence to poll jules_status.',
    parameters: {
      session: { type: 'string', required: true, description: 'Session id, "sessions/<id>", or the session URL.' },
      timeoutMs: { type: 'number', description: `How long to wait before giving up, up to ${Math.trunc(config.waitMaxMs / 1000)} seconds.` },
      until: {
        type: 'array',
        description: 'Session states that end the wait. Defaults to completion, failure, a pending plan, and a question.',
        items: { type: 'string' },
      },
    },
    output: {
      schema: WAIT_SCHEMA,
      render: (_args, value) => [{ type: 'text', text: renderWait(value) }],
    },
    // The tool's own deadline must outlast the wait budget it is given, or the
    // pipeline would cut the call off before the wait could report. The margin
    // covers the reads that follow settlement: an activity walk and a status
    // fetch, each of which can take seconds against this service.
    timeoutMs: config.waitMaxMs + 15_000,
    isConcurrencySafe: () => true,
    // The foreground wait shares runWatch with jules_watch. Duplicating the loop
    // here is what let the two paths disagree: this one used to poll the session
    // state alone, so a session that posted its answer while state stayed
    // IN_PROGRESS would wait out the whole budget and report nothing.
    async execute(args, exec) {
      const id = sessionIdOf(args.session)
      const requested = args.timeoutMs ?? config.waitDefaultMs
      const budget = Math.max(1_000, Math.min(Math.trunc(requested), config.waitMaxMs))
      const targets = new Set<string>(
        args.until === undefined || args.until.length === 0 ? DEFAULT_WAIT_STATES : args.until,
      )
      const outcome = await runWatch(client, id, targets, budget, {
        pollIntervalMs: config.pollIntervalMs,
        maxActivityPages: config.maxActivityPages,
        settleOnMessage: config.settleOnMessage,
      }, exec.signal)
      return outcome.wait
    },
  }))

  ctx.tools.register(defineTool({
    name: 'jules_patch',
    description: 'Return the unified diff a Jules session produced, newest first, ready to apply with git apply. '
      + 'Use it to review or land the agent work in this workspace instead of opening the pull request. Large diffs are '
      + 'returned in slices: the reply lists every touched file and, when it truncates, the offset to continue from.',
    parameters: {
      session: { type: 'string', required: true, description: 'Session id, "sessions/<id>", or the session URL.' },
      maxBytes: { type: 'number', description: `Cap on this slice, up to ${config.maxPatchBytes} bytes.` },
      offset: { type: 'number', description: 'Byte offset to start this slice at. Use the nextOffset from a truncated reply to continue.' },
    },
    output: {
      schema: PATCH_SCHEMA,
      render: (_args, value) => [{ type: 'text', text: renderPatch(value) }],
    },
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const id = sessionIdOf(args.session)
      const activities = await client.listAllActivities(id, { signal: exec.signal, maxPages: config.maxActivityPages, pageSize: 100 })
      const gitPatch = latestPatch(activities)
      const full = gitPatch?.unidiffPatch ?? ''
      const limit = Math.max(1_000, Math.min(Math.trunc(args.maxBytes ?? config.maxPatchBytes), config.maxPatchBytes))
      if (full.length === 0) {
        return {
          id, found: false, patch: '', bytes: 0, truncated: false,
          offset: 0, nextOffset: 0, files: [],
          baseCommitId: '', suggestedCommitMessage: '', source: '',
        }
      }
      const offset = Math.max(0, Math.min(Math.trunc(args.offset ?? 0), Math.max(0, full.length - 1)))
      const slice = full.slice(offset, offset + limit)
      const truncated = offset + slice.length < full.length
      return {
        id,
        found: true,
        patch: slice,
        // The size of the whole diff, so one slice still says how much there is.
        bytes: full.length,
        truncated,
        offset,
        nextOffset: truncated ? offset + slice.length : 0,
        files: patchFiles(full),
        baseCommitId: gitPatch?.baseCommitId ?? '',
        suggestedCommitMessage: gitPatch?.suggestedCommitMessage ?? '',
        source: '',
      }
    },
  }))
}
