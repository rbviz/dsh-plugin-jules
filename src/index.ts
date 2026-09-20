/**
 * Google Jules as a harness capability: the `jules_*` tool family lets a model
 * delegate a coding task to the remote Jules agent, follow it, approve its plan,
 * and retrieve the diff or pull request it produced.
 *
 * The plugin speaks the documented Jules v1alpha REST API directly. The Jules
 * CLI is deliberately not used: it authenticates through an interactive OAuth
 * flow in the OS keyring, reads no `JULES_*` environment variable, produces no
 * machine-readable output, and drives an internal backend rather than the
 * documented one — none of which survives contact with an unattended harness
 * process.
 *
 * @module dsh-plugin-jules
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { launchEnvironmentOf } from '@deepseek-ai/dsh-launch-environment'
import type {} from '@deepseek-ai/dsh-system-prompt'
import type {} from '@deepseek-ai/dsh-tools'
import { JulesClient } from './client.ts'
import { registerJulesTools } from './tools.ts'
import type { WatchJournal } from './journal.ts'
import { openWatchJournal, orphanNote } from './journal.ts'
import { registerJulesWatch } from './watch.ts'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'jules'

/** The tool registry, and the system prompt the guidance section joins. */
export const inject = ['tools', 'systemPrompt']

/** Credential name read when the configuration does not name another one. */
export const DEFAULT_API_KEY_ENV = 'JULES_API_KEY'

/** API root. Jules exposes one documented version, `v1alpha`. */
export const DEFAULT_BASE_URL = 'https://jules.googleapis.com/v1alpha'

/** Where a user creates the API key this plugin reads. */
export const API_KEY_URL = 'https://jules.google.com/settings'

/** Default per-request deadline. */
export const DEFAULT_REQUEST_TIMEOUT_MS = 30_000

/** Default page size for list calls; the service default is 30. */
export const DEFAULT_PAGE_SIZE = 30

/** Largest page size the service accepts. */
export const MAX_PAGE_SIZE = 100

/** Default cap on a diff returned by `jules_patch`. */
export const DEFAULT_MAX_PATCH_BYTES = 200_000

/** Default wait budget for `jules_wait`. */
export const DEFAULT_WAIT_MS = 120_000

/** Largest wait budget a caller may request. */
export const MAX_WAIT_MS = 300_000

/** Delay between two `jules_wait` status polls. */
export const DEFAULT_POLL_INTERVAL_MS = 5_000

/** Pages of activities one read may walk. */
export const DEFAULT_MAX_ACTIVITY_PAGES = 10

/** Default background watch budget for `jules_watch`. */
export const DEFAULT_WATCH_MS = 1_800_000

/** Largest background watch budget a caller may request. */
export const MAX_WATCH_MS = 7_200_000

/** Delay between two background watch polls. */
export const DEFAULT_WATCH_POLL_INTERVAL_MS = 15_000

/** Retry attempts for a rate-limited or failing request. */
export const DEFAULT_RETRY_MAX_ATTEMPTS = 4

/** First backoff step for a retried request. */
export const DEFAULT_RETRY_BASE_DELAY_MS = 1_000

/** Ceiling for one backoff step. */
export const DEFAULT_RETRY_MAX_DELAY_MS = 30_000

/** Plugin configuration. Every field has a default except the credential. */
export interface Config {
  /** Literal API key. Prefer {@link apiKeyEnv} so no secret enters configuration files. */
  apiKey?: string
  /** Credential holding the key; defaults to `JULES_API_KEY`. */
  apiKeyEnv?: string
  /** API root; defaults to the documented v1alpha endpoint. */
  baseURL?: string
  /** Repository `jules_create` targets when the call omits one, as `owner/repo`. */
  defaultSource?: string
  /** Per-request deadline in milliseconds. Defaults to 30000. */
  requestTimeoutMs?: number
  /** Page size for list calls that do not choose one. Defaults to 30. */
  defaultPageSize?: number
  /** Largest page size a caller may request. Defaults to 100. */
  maxPageSize?: number
  /** Largest diff `jules_patch` returns. Defaults to 200000 bytes. */
  maxPatchBytes?: number
  /** Wait budget `jules_wait` uses when the caller does not set one. Defaults to 120000 ms. */
  waitDefaultMs?: number
  /** Largest wait budget a caller may request. Defaults to 300000 ms. */
  waitMaxMs?: number
  /** Delay between two status polls inside `jules_wait`. Defaults to 5000 ms. */
  pollIntervalMs?: number
  /** Activity pages one read may walk. Defaults to 10. */
  maxActivityPages?: number
  /** Expose `jules_watch`, which watches a session through the background job registry. Defaults to true. */
  enableWatch?: boolean
  /** Watch budget `jules_watch` uses when the caller does not set one. Defaults to 1800000 ms. */
  watchDefaultMs?: number
  /** Largest watch budget a caller may request. Defaults to 7200000 ms. */
  watchMaxMs?: number
  /** Delay between two polls inside `jules_watch`. Defaults to 15000 ms. */
  watchPollIntervalMs?: number
  /** End `jules_watch` when the agent posts a message, not only on a session-state change. Defaults to true. */
  watchSettleOnMessage?: boolean
  /** Attempts per request, including the first. Defaults to 4. */
  retryMaxAttempts?: number
  /** First backoff step in milliseconds. Defaults to 1000. */
  retryBaseDelayMs?: number
  /** Ceiling for one backoff step in milliseconds. Defaults to 30000. */
  retryMaxDelayMs?: number
}

/** Schemastery configuration for loader defaults and the generated config catalog. */
export const Config: z<Config> = z.object({
  apiKey: z.string().role('secret'),
  apiKeyEnv: z.string().role('credential-ref').default(DEFAULT_API_KEY_ENV),
  baseURL: z.string().default(DEFAULT_BASE_URL),
  defaultSource: z.string(),
  requestTimeoutMs: z.number().step(1).min(1).default(DEFAULT_REQUEST_TIMEOUT_MS),
  defaultPageSize: z.number().step(1).min(1).max(MAX_PAGE_SIZE).default(DEFAULT_PAGE_SIZE),
  maxPageSize: z.number().step(1).min(1).max(MAX_PAGE_SIZE).default(MAX_PAGE_SIZE),
  maxPatchBytes: z.number().step(1).min(1_000).default(DEFAULT_MAX_PATCH_BYTES),
  waitDefaultMs: z.number().step(1).min(1_000).default(DEFAULT_WAIT_MS),
  waitMaxMs: z.number().step(1).min(1_000).default(MAX_WAIT_MS),
  pollIntervalMs: z.number().step(1).min(250).default(DEFAULT_POLL_INTERVAL_MS),
  maxActivityPages: z.number().step(1).min(1).default(DEFAULT_MAX_ACTIVITY_PAGES),
  enableWatch: z.boolean().default(true),
  watchDefaultMs: z.number().step(1).min(30_000).default(DEFAULT_WATCH_MS),
  watchMaxMs: z.number().step(1).min(30_000).default(MAX_WATCH_MS),
  watchPollIntervalMs: z.number().step(1).min(250).default(DEFAULT_WATCH_POLL_INTERVAL_MS),
  watchSettleOnMessage: z.boolean().default(true),
  retryMaxAttempts: z.number().step(1).min(1).default(DEFAULT_RETRY_MAX_ATTEMPTS),
  retryBaseDelayMs: z.number().step(1).min(1).default(DEFAULT_RETRY_BASE_DELAY_MS),
  retryMaxDelayMs: z.number().step(1).min(1).default(DEFAULT_RETRY_MAX_DELAY_MS),
})

/**
 * Model guidance for the Jules tool family.
 *
 * Written as an instruction and scoped to policy, like every in-box tool
 * section: what each tool does is the tool description's job, so this says when
 * to reach for the family and what not to do with it. The earlier draft opened
 * by describing Jules instead, and spent most of its length restating the tool
 * descriptions.
 *
 * The waiting half is conditional because `enableWatch: false` removes
 * `jules_watch` from the composition entirely, and guidance naming a tool the
 * model cannot call is worse than guidance that says less. `tool:web_search`
 * sets the same precedent for its optional `web_fetch` companion.
 * @param watchAvailable - whether `jules_watch` is registered in this scope.
 * @returns the section text.
 */
export function julesGuidance(watchAvailable: boolean): string {
  const waiting = watchAvailable
    ? 'jules_watch registers a background watch and returns a job id; then END YOUR TURN, and the harness wakes you with a notice when '
      + 'the session finishes, fails, needs a plan decision, or posts a message. DO NOT POLL: a status call that returns what you '
      + 'already saw has cost a turn and bought nothing. jules_wait holds that same wait open in the foreground, so reach for it only '
      + 'when nothing else can proceed meanwhile.'
    : 'jules_wait holds the turn open until the session finishes, fails, needs a plan decision, or posts a message. DO NOT POLL: a '
      + 'status call that returns what you already saw has cost a turn and bought nothing.'
  return 'Use the jules_* tools to delegate a coding task to Jules, a remote agent that works asynchronously in the cloud on its own '
    + 'clone of a repository, so the session keeps working after your turn ends. jules_create returns a session id immediately. '
    + waiting + ' '
    + 'jules_status is for confirming an action you just took, following up a watch notice, or answering the user about a session — '
    + 'never for waiting. '
    + 'Ask for requirePlanApproval when a task will change existing code, then read the plan before jules_approve_plan releases it. '
    + 'Prefer finishing small work here; delegate a task that is long, independent, or better done in a clean checkout, and do not '
    + 'open several sessions for one task because the service throttles concurrent creation.'
}

/**
 * Complete every optional field and reject combinations the schema cannot express.
 * @param config - the validated configuration section.
 * @returns the fully defaulted bounds the plugin runs with.
 */
function resolveConfig(config: Config): Required<Omit<Config, 'apiKey' | 'defaultSource'>> & Pick<Config, 'apiKey' | 'defaultSource'> {
  const resolved = {
    apiKey: config.apiKey,
    defaultSource: config.defaultSource,
    apiKeyEnv: config.apiKeyEnv ?? DEFAULT_API_KEY_ENV,
    baseURL: (config.baseURL ?? DEFAULT_BASE_URL).replace(/\/+$/, ''),
    requestTimeoutMs: config.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
    defaultPageSize: config.defaultPageSize ?? DEFAULT_PAGE_SIZE,
    maxPageSize: config.maxPageSize ?? MAX_PAGE_SIZE,
    maxPatchBytes: config.maxPatchBytes ?? DEFAULT_MAX_PATCH_BYTES,
    waitDefaultMs: config.waitDefaultMs ?? DEFAULT_WAIT_MS,
    waitMaxMs: config.waitMaxMs ?? MAX_WAIT_MS,
    pollIntervalMs: config.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS,
    maxActivityPages: config.maxActivityPages ?? DEFAULT_MAX_ACTIVITY_PAGES,
    enableWatch: config.enableWatch ?? true,
    watchDefaultMs: config.watchDefaultMs ?? DEFAULT_WATCH_MS,
    watchMaxMs: config.watchMaxMs ?? MAX_WATCH_MS,
    watchPollIntervalMs: config.watchPollIntervalMs ?? DEFAULT_WATCH_POLL_INTERVAL_MS,
    watchSettleOnMessage: config.watchSettleOnMessage ?? true,
    retryMaxAttempts: config.retryMaxAttempts ?? DEFAULT_RETRY_MAX_ATTEMPTS,
    retryBaseDelayMs: config.retryBaseDelayMs ?? DEFAULT_RETRY_BASE_DELAY_MS,
    retryMaxDelayMs: config.retryMaxDelayMs ?? DEFAULT_RETRY_MAX_DELAY_MS,
  }
  if (resolved.defaultPageSize > resolved.maxPageSize) {
    throw new Error('jules: defaultPageSize must not exceed maxPageSize')
  }
  if (resolved.waitDefaultMs > resolved.waitMaxMs) {
    throw new Error('jules: waitDefaultMs must not exceed waitMaxMs')
  }
  if (resolved.watchDefaultMs > resolved.watchMaxMs) {
    throw new Error('jules: watchDefaultMs must not exceed watchMaxMs')
  }
  if (resolved.retryBaseDelayMs > resolved.retryMaxDelayMs) {
    throw new Error('jules: retryBaseDelayMs must not exceed retryMaxDelayMs')
  }
  if (!URL.canParse(resolved.baseURL)) {
    throw new Error(`jules: baseURL must be an absolute URL, received ${JSON.stringify(resolved.baseURL)}`)
  }
  return resolved
}

/**
 * Register the Jules tool family and its model guidance.
 * @param ctx - plugin context supplying the tool registry and credential seam.
 * @param config - validated configuration section.
 */
export function apply(ctx: Context, config: Config): void {
  const resolved = resolveConfig(config)
  const apiKeyEnv = credentialRef(resolved.apiKeyEnv)
  const literalApiKey = resolved.apiKey !== undefined && resolved.apiKey.length > 0
    ? resolved.apiKey
    : undefined

  const client = new JulesClient({
    resolveApiKey: async () => {
      if (literalApiKey !== undefined) return literalApiKey
      const credentials = ctx.get('credentials')
      if (credentials !== undefined) {
        const record = await credentials.resolve(apiKeyEnv)
        if (record !== undefined && record.value.length > 0) return record.value
      }
      // Without the credential seam, the launch environment is the whole
      // credential plane — the same fallback the in-box providers take.
      const ambient = launchEnvironmentOf(ctx).get(apiKeyEnv)
      return ambient !== undefined && ambient.value.length > 0 ? ambient.value : undefined
    },
    baseURL: resolved.baseURL,
    requestTimeoutMs: resolved.requestTimeoutMs,
    defaultPageSize: resolved.defaultPageSize,
    maxPageSize: resolved.maxPageSize,
    retry: {
      maxAttempts: resolved.retryMaxAttempts,
      baseDelayMs: resolved.retryBaseDelayMs,
      maxDelayMs: resolved.retryMaxDelayMs,
    },
  })

  registerJulesTools(ctx, client, {
    maxPatchBytes: resolved.maxPatchBytes,
    waitDefaultMs: resolved.waitDefaultMs,
    waitMaxMs: resolved.waitMaxMs,
    pollIntervalMs: resolved.pollIntervalMs,
    maxActivityPages: resolved.maxActivityPages,
    settleOnMessage: resolved.watchSettleOnMessage,
    defaultSource: resolved.defaultSource ?? '',
  })

  // Watches are process-local and cannot be restored before an agent exists to
  // own one, so the journal only preserves what was in flight.
  //
  // Injected rather than read with ctx.get(): activation here is
  // service-availability driven and does not follow row order, so the storage
  // domain can arrive after this plugin applies. Reading it eagerly raced and
  // silently disabled the journal — no records, and no error either.
  let journal: WatchJournal | undefined
  // Sessions this process is actively watching. The note is about watches that
  // survived a restart, and a watch running right now is not one of them.
  const live = new Set<string>()
  ctx.inject(['storageDomain'], (storageCtx) => {
    void openWatchJournal(storageCtx)
      .then((opened) => { journal = opened })
      .catch((error: unknown) => {
        storageCtx.logger.warn(`jules: could not open the watch journal: ${String(error)}`)
      })
  })

  if (resolved.enableWatch) {
    // Registered through an optional injection: a composition without the job
    // registry still gets the other nine tools instead of holding the whole
    // plugin PENDING on a service it may never provide.
    const watchConfig = {
      pollIntervalMs: resolved.watchPollIntervalMs,
      defaultMs: resolved.watchDefaultMs,
      maxMs: resolved.watchMaxMs,
      maxActivityPages: resolved.maxActivityPages,
      settleOnMessage: resolved.watchSettleOnMessage,
    }
    ctx.inject(['jobs'], (jobsCtx) => {
      registerJulesWatch(jobsCtx, client, watchConfig, () => journal, live)
    })
  }

  ctx.systemPrompt.section({
    name: 'tool:jules',
    // Borrows the subagent slot deliberately. The order table is a fixed set of
    // positions owned by particular tool families, and Jules is the same kind of
    // thing a subagent is — a delegation target — so its guidance belongs beside
    // those instructions rather than in an unrelated slot. Equal orders fall back
    // to name order, which is stable. The system-prompt README documents the
    // alternative for out-of-tree packages — "external contributions may use any
    // finite order" — but a borrowed allocated position cannot collide with a
    // future in-box slot, while a hand-picked number can.
    order: ctx.systemPrompt.getSectionOrder('TOOL_SUBAGENT'),
    // Evaluated per assembly, so the orphan note appears the moment the plugin
    // loads after a restart and disappears as watches are re-armed.
    //
    // Empty text is dropped before rendering, so an agent whose scope excludes
    // the family is never told about tools it cannot call — the same gate
    // `tool:read` and `tool:subagent` apply. `jules_create` stands in for the
    // family: it registers unconditionally and is the entry point this guidance
    // is about. Gating ahead of the note also stops an agent without Jules tools
    // from being handed a list of watches to re-arm.
    text: ({ scope }) => ctx.tools.get('jules_create', scope) === undefined
      ? ''
      : julesGuidance(ctx.tools.get('jules_watch', scope) !== undefined)
        + orphanNote((journal?.pending() ?? []).filter(record => !live.has(record.session))),
  })
}
