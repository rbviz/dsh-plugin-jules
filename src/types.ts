/**
 * Wire types for the Jules v1alpha REST API, plus the small amount of
 * normalization the tools do before they call it.
 *
 * Everything here describes what the service sends: Jules omits optional
 * members rather than sending nulls, so every field a response may omit is
 * optional. Nothing in this module imports a harness package, which keeps the
 * API surface testable on its own.
 *
 * @module dsh-plugin-jules/types
 */

/** Lifecycle state of one Jules session, as the service reports it. */
export type SessionState =
  | 'STATE_UNSPECIFIED'
  | 'QUEUED'
  | 'PLANNING'
  | 'AWAITING_PLAN_APPROVAL'
  | 'AWAITING_USER_FEEDBACK'
  | 'IN_PROGRESS'
  | 'PAUSED'
  | 'FAILED'
  | 'COMPLETED'

/** States a session reaches before it starts or after it stops working. */
export const SETTLED_STATES: readonly SessionState[] = ['COMPLETED', 'FAILED']

/** States that stop the agent until a human or a model answers it. */
export const ATTENTION_STATES: readonly SessionState[] = ['AWAITING_PLAN_APPROVAL', 'AWAITING_USER_FEEDBACK']

/**
 * States a caller may reasonably wait for; the default `jules_wait` target.
 *
 * `PAUSED` is deliberately absent. The reference lists it in the enum and
 * documents nothing about what a paused session is waiting for or whether
 * anything resumes it, so treating it as an end to the wait would invent a
 * contract. A caller who knows better can name it in `until`, and until then a
 * paused session reports as a wait that ran out rather than one that finished.
 *
 * `QUEUED`, `PLANNING` and `IN_PROGRESS` are absent for the obvious reason:
 * they are the states a wait exists to sit through.
 */
export const DEFAULT_WAIT_STATES: readonly SessionState[] = [...SETTLED_STATES, ...ATTENTION_STATES]

/**
 * Report whether a session has stopped for good.
 * @param state - the state the service reported.
 * @returns whether the session reached a terminal state.
 */
export function settledState(state: string): boolean {
  return (SETTLED_STATES as readonly string[]).includes(state)
}

/**
 * Report whether a session is blocked on an answer.
 * @param state - the state the service reported.
 * @returns whether the session waits for a human or model decision.
 */
export function needsAttentionState(state: string): boolean {
  return (ATTENTION_STATES as readonly string[]).includes(state)
}

/** One file's worth of output in a `changeSet` artifact. */
export interface GitPatch {
  baseCommitId?: string
  unidiffPatch?: string
  suggestedCommitMessage?: string
}

/** A code change the agent produced. */
export interface ChangeSet {
  source?: string
  gitPatch?: GitPatch
}

/** A shell command the agent ran and what it printed. */
export interface BashOutput {
  command?: string
  output?: string
  exitCode?: number
}

/** Base64 media the agent attached, such as a screenshot. */
export interface Media {
  mimeType?: string
  data?: string
}

/** One thing an activity produced; exactly one member is present. */
export interface Artifact {
  changeSet?: ChangeSet
  bashOutput?: BashOutput
  media?: Media
}

/** One step of a generated plan. */
export interface PlanStep {
  id?: string
  index?: number
  title?: string
  description?: string
}

/** The plan a session is executing. */
export interface Plan {
  id?: string
  steps?: PlanStep[]
  createTime?: string
}

/** One entry in a session's event log; exactly one event member is present. */
export interface Activity {
  name?: string
  id?: string
  originator?: string
  description?: string
  createTime?: string
  artifacts?: Artifact[]
  planGenerated?: { plan?: Plan }
  planApproved?: { planId?: string }
  userMessaged?: { userMessage?: string }
  agentMessaged?: { agentMessage?: string }
  progressUpdated?: { title?: string; description?: string }
  sessionCompleted?: Record<string, never>
  sessionFailed?: { reason?: string }
}

/** A pull request the session opened. */
export interface PullRequest {
  url?: string
  title?: string
  description?: string
  baseRef?: string
  headRef?: string
}

/** One deliverable of a finished session. */
export interface SessionOutput {
  pullRequest?: PullRequest
}

/** A file the session produced, in full or as added lines. */
export interface GeneratedFile {
  path?: string
  changeType?: string
  content?: string
}

/** The repository a source points at. */
export interface GithubRepo {
  owner?: string
  repo?: string
  isPrivate?: boolean
  defaultBranch?: { displayName?: string }
  branches?: { displayName?: string }[]
}

/** A repository connected to Jules through the GitHub App. */
export interface Source {
  name?: string
  id?: string
  githubRepo?: GithubRepo
}

/** One session, as `/sessions/{id}` returns it. */
export interface Session {
  name?: string
  id?: string
  prompt?: string
  title?: string
  state?: SessionState
  url?: string
  sourceContext?: {
    source?: string
    githubRepoContext?: { startingBranch?: string; workingBranch?: string }
  }
  requirePlanApproval?: boolean
  automationMode?: string
  outputs?: SessionOutput[]
  createTime?: string
  updateTime?: string
  generatedFiles?: GeneratedFile[]
  archived?: boolean
}

/** A page of sources. */
export interface ListSourcesResponse {
  sources?: Source[]
  nextPageToken?: string
}

/** A page of sessions. */
export interface ListSessionsResponse {
  sessions?: Session[]
  nextPageToken?: string
}

/** A page of activities. */
export interface ListActivitiesResponse {
  activities?: Activity[]
  nextPageToken?: string
}

/** What `jules_create` sends. `sourceContext` is omitted for a repoless session. */
export interface CreateSessionRequest {
  prompt: string
  title?: string
  sourceContext?: {
    source: string
    githubRepoContext?: { startingBranch?: string }
  }
  requirePlanApproval?: boolean
  automationMode?: string
}

/** The identifying part of a session reference, accepted in any of its forms. */
const SESSION_ID_PATTERN = /^sessions\/([^/]+)$/

/** A reference that points at an activity rather than at its session. */
const ACTIVITY_REFERENCE_PATTERN = /^sessions\/[^/]+\/activities/

/**
 * Reduce any session reference a model may produce to the bare id the API
 * paths use: `123`, `sessions/123`, or the `jules.google.com/session/123`
 * URL all become `123`.
 * @param reference - session id, resource name, or session URL.
 * @returns the bare session id.
 * @throws {TypeError} when the reference carries no id.
 */
export function sessionIdOf(reference: string): string {
  const trimmed = reference.trim().replace(/\/+$/, '')
  if (trimmed.length === 0) throw new TypeError('a Jules session reference must not be empty')
  // Checked before the session forms: \`sessions/1/activities/2\` would otherwise
  // read as the session id \`1/activities/2\` and reach the API as a 404.
  if (ACTIVITY_REFERENCE_PATTERN.test(trimmed)) {
    throw new TypeError(`${JSON.stringify(reference)} names an activity, not a session`)
  }
  const fromUrl = /jules\.google\.com\/session\/([^/?#]+)/.exec(trimmed)
  if (fromUrl?.[1] !== undefined) return fromUrl[1]
  const fromName = SESSION_ID_PATTERN.exec(trimmed)
  if (fromName?.[1] !== undefined && fromName[1].length > 0) return fromName[1]
  return trimmed
}

/**
 * Accept the three spellings of a connected repository and produce the
 * resource name the API expects: `owner/repo` and `github/owner/repo` both
 * become `sources/github/owner/repo`.
 * @param reference - `owner/repo`, `github/owner/repo`, or the full resource name.
 * @returns the canonical source resource name.
 * @throws {TypeError} when the reference is not a two-part repository id.
 */
export function sourceNameOf(reference: string): string {
  const trimmed = reference.trim()
  if (trimmed.startsWith('sources/')) {
    const rest = trimmed.slice('sources/'.length)
    return rest.startsWith('github/') ? trimmed : `sources/github/${rest}`
  }
  const parts = trimmed.replace(/^github\//, '').split('/')
  if (parts.length !== 2 || parts[0] === undefined || parts[1] === undefined
    || parts[0].length === 0 || parts[1].length === 0) {
    throw new TypeError(
      `${JSON.stringify(reference)} is not a repository reference; use "owner/repo" or "sources/github/owner/repo"`,
    )
  }
  return `sources/github/${parts[0]}/${parts[1]}`
}

/**
 * Render a source resource name back as `owner/repo` for display, leaving an
 * unrecognized name untouched.
 * @param name - the source resource name.
 * @returns the short repository reference.
 */
export function shortSourceName(name: string | undefined): string {
  if (name === undefined) return ''
  const match = /^sources\/github\/(.+)$/.exec(name)
  return match?.[1] ?? name
}

/**
 * Identify which event an activity carries.
 * @param activity - one activity from the log.
 * @returns the event member name, or `'unknown'` when none is present.
 */
export function activityKind(activity: Activity): string {
  if (activity.planGenerated !== undefined) return 'planGenerated'
  if (activity.planApproved !== undefined) return 'planApproved'
  if (activity.userMessaged !== undefined) return 'userMessaged'
  if (activity.agentMessaged !== undefined) return 'agentMessaged'
  if (activity.progressUpdated !== undefined) return 'progressUpdated'
  if (activity.sessionCompleted !== undefined) return 'sessionCompleted'
  if (activity.sessionFailed !== undefined) return 'sessionFailed'
  return 'unknown'
}
