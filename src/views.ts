/**
 * Projections from Jules wire objects to the canonical values the tools return,
 * and the text those values render to.
 *
 * Every projected object carries a value for each declared member: an absent
 * optional scalar becomes `''` and an absent list becomes `[]`. The canonical
 * value therefore stays lossless JSON with a fixed shape, and the renderer — not
 * the model — decides what an empty value means.
 *
 * @module dsh-plugin-jules/views
 */

import type { Activity, Artifact, GitPatch, Plan, Session, Source } from './types.ts'
import { activityKind, shortSourceName } from './types.ts'

/** One row of `jules_sources`. */
export interface SourceView {
  name: string
  owner: string
  repo: string
  isPrivate: boolean
  defaultBranch: string
  branches: string[]
}

/** One row of `jules_list`. */
export interface SessionRow {
  id: string
  title: string
  state: string
  url: string
  source: string
  branch: string
  createTime: string
  updateTime: string
  pullRequests: string[]
}

/** The full picture `jules_status` returns. */
export interface SessionDetail {
  id: string
  title: string
  state: string
  url: string
  prompt: string
  source: string
  branch: string
  /**
   * Whether the plan gate was in force, as `yes`, `no`, or `unknown`.
   *
   * The service treats this as a create-time *input* and does not echo it back,
   * so a plain boolean here reported `false` for sessions that clearly
   * honoured it. `unknown` is the honest answer when neither the session nor the
   * log carries evidence either way.
   */
  requirePlanApproval: string
  /** Whether a PR is opened automatically, on the same yes/no/unknown terms. */
  autoCreatePr: string
  archived: boolean
  createTime: string
  updateTime: string
  planId: string
  planSteps: string[]
  /** A generated plan with no approval after it, which is what blocks the session. */
  planPending: boolean
  planApproved: boolean
  pullRequests: string[]
  generatedFiles: GeneratedFileView[]
  /** The most recent shell command the agent ran, for diagnosing a stall. */
  latestCommand: string
  /**
   * True only when the call performing the projection had just approved a plan
   * and then observed its `planApproved` event. False on every other call,
   * including one that approved but could not confirm in time — the service is
   * eventually consistent about its own actions, so this is the answer to "did
   * my approval land", which the state field cannot give.
   */
  approvalConfirmed: boolean
  /** False only when a log read was attempted and failed, making its derived fields unknown. */
  logRead: boolean
  /** The most recent message the agent sent, which is where a question or a blocker appears. */
  lastMessage: string
  lastProgress: string
  /**
   * Milliseconds since this same observation was last returned, or 0 when it is
   * new. Non-zero means the caller is looking at a session that has not moved,
   * which the renderer turns into a nudge to stop polling.
   */
  unchangedForMs: number
}

/** Per-call facts a projection cannot derive from the session and its log. */
export interface DetailOptions {
  /** Milliseconds since this same observation was last returned; 0 when new. */
  unchangedForMs?: number
  /** Whether this call approved a plan and then observed the approval. */
  approvalConfirmed?: boolean
  /**
   * Set false only when a read was attempted and failed. It then means every
   * log-derived field below is *unknown*, not empty — a distinction that matters
   * because "no plan pending" and "we could not look" call for opposite actions.
   * Omitting it says nothing failed, which is also true of a projection that
   * never looked.
   */
  logRead?: boolean
}

/** One entry of `SessionDetail.generatedFiles`. */
export interface GeneratedFileView {
  path: string
  changeType: string
  /** Length of the file content the service reported. */
  bytes: number
}

/** One row of `jules_activities`. */
export interface ActivityView {
  id: string
  time: string
  originator: string
  kind: string
  summary: string
  artifacts: string[]
}

/** The canonical value of `jules_wait`. */
export interface WaitResult {
  id: string
  title: string
  state: string
  url: string
  settled: boolean
  timedOut: boolean
  needsAttention: boolean
  waitedMs: number
  polls: number
  planId: string
  planSteps: string[]
  pullRequests: string[]
  lastMessage: string
  lastProgress: string
}

/** The canonical value of `jules_patch`. */
export interface PatchResult {
  id: string
  found: boolean
  /** The requested slice of the unified diff. */
  patch: string
  /** Size of the whole diff, not of the slice. */
  bytes: number
  /** Whether more of the diff remains after this slice. */
  truncated: boolean
  /** Byte offset this slice started at. */
  offset: number
  /** Offset to pass to continue reading, or 0 when this slice is the last. */
  nextOffset: number
  /** Every path the whole diff touches, so a large patch is still reviewable at a glance. */
  files: string[]
  baseCommitId: string
  suggestedCommitMessage: string
  source: string
}

/**
 * Join a plan's steps into display lines.
 * @param plan - the plan, when one was generated.
 * @returns one line per step.
 */
function planLines(plan: Plan | undefined): string[] {
  const steps = plan?.steps ?? []
  return steps.map((step, index) => {
    const ordinal = step.index ?? index + 1
    const title = step.title ?? 'untitled step'
    return step.description === undefined || step.description.length === 0
      ? `${ordinal}. ${title}`
      : `${ordinal}. ${title} — ${step.description}`
  })
}

/**
 * Describe one artifact without reproducing its payload.
 * @param artifact - one artifact from an activity.
 * @returns a short descriptor.
 */
function artifactSummary(artifact: Artifact): string {
  if (artifact.changeSet !== undefined) {
    const patch = artifact.changeSet.gitPatch?.unidiffPatch ?? ''
    const files = patch.length === 0 ? 0 : patch.split('\n').filter(line => line.startsWith('diff --git ')).length
    const bytes = patch.length
    return `changeSet: ${files} file(s), ${bytes} byte(s) of unified diff`
  }
  if (artifact.bashOutput !== undefined) {
    const command = artifact.bashOutput.command ?? 'command'
    const exit = artifact.bashOutput.exitCode
    return `bashOutput: ${command}${exit === undefined ? '' : ` (exit ${exit})`}`
  }
  if (artifact.media !== undefined) {
    return `media: ${artifact.media.mimeType ?? 'application/octet-stream'}`
  }
  return 'unknown artifact'
}

/**
 * Read the one human-readable line an activity carries.
 * @param activity - one activity from the log.
 * @returns the message, progress text, or failure reason.
 */
export function activitySummary(activity: Activity): string {
  if (activity.planGenerated !== undefined) {
    const steps = planLines(activity.planGenerated.plan)
    return steps.length === 0 ? 'Plan generated.' : `Plan generated with ${steps.length} step(s).`
  }
  if (activity.planApproved !== undefined) return `Plan ${activity.planApproved.planId ?? ''} approved.`.trim()
  if (activity.userMessaged !== undefined) return activity.userMessaged.userMessage ?? 'User message.'
  if (activity.agentMessaged !== undefined) return activity.agentMessaged.agentMessage ?? 'Agent message.'
  if (activity.progressUpdated !== undefined) {
    const title = activity.progressUpdated.title ?? ''
    const description = activity.progressUpdated.description ?? ''
    if (title.length > 0 && description.length > 0) return `${title}: ${description}`
    return title.length > 0 ? title : description
  }
  if (activity.sessionCompleted !== undefined) return 'Session completed.'
  if (activity.sessionFailed !== undefined) return `Session failed: ${activity.sessionFailed.reason ?? 'no reason reported'}`
  return activity.description ?? 'Unrecognized activity.'
}

/**
 * Project one session into a list row.
 * @param session - the wire session.
 * @returns the row value.
 */
export function sessionRow(session: Session): SessionRow {
  return {
    id: session.id ?? '',
    title: session.title ?? '',
    state: session.state ?? 'STATE_UNSPECIFIED',
    url: session.url ?? '',
    source: shortSourceName(session.sourceContext?.source),
    branch: session.sourceContext?.githubRepoContext?.startingBranch ?? '',
    createTime: session.createTime ?? '',
    updateTime: session.updateTime ?? '',
    pullRequests: (session.outputs ?? []).flatMap(output => output.pullRequest?.url ?? []),
  }
}

/**
 * Project one session into the full detail view.
 * @param session - the wire session.
 * @param activities - the session's event log, when it was read.
 * @returns the detail value.
 */
export function sessionDetail(
  session: Session,
  activities: readonly Activity[] = [],
  options: DetailOptions = {},
): SessionDetail {
  const latestPlan = [...activities].reverse()
    .find(activity => activity.planGenerated !== undefined)?.planGenerated?.plan
  const approved = activities.some(activity => activity.planApproved !== undefined)
  // A plan is pending while the newest plan event is its generation.
  const lastPlanIndex = activities.findLastIndex(activity => activity.planGenerated !== undefined)
  const lastApprovalIndex = activities.findLastIndex(activity => activity.planApproved !== undefined)
  const planPending = lastPlanIndex >= 0 && lastApprovalIndex < lastPlanIndex
  const latestCommand = [...activities].reverse()
    .flatMap(activity => activity.artifacts ?? [])
    .find(artifact => artifact.bashOutput?.command !== undefined)?.bashOutput?.command ?? ''
  const pullRequests = (session.outputs ?? []).flatMap(output => output.pullRequest?.url ?? [])
  const progress = [...activities].reverse()
    .find(activity => activity.progressUpdated !== undefined)?.progressUpdated
  // A session that stops to ask something produces no plan and no progress, so
  // without this the projection reads as an empty success.
  const lastMessage = [...activities].reverse()
    .find(activity => activity.agentMessaged !== undefined)?.agentMessaged?.agentMessage ?? ''
  return {
    id: session.id ?? '',
    title: session.title ?? '',
    state: session.state ?? 'STATE_UNSPECIFIED',
    url: session.url ?? '',
    prompt: session.prompt ?? '',
    source: shortSourceName(session.sourceContext?.source),
    branch: session.sourceContext?.githubRepoContext?.startingBranch ?? '',
    // Evidence first, echo second. The session object omits these inputs on
    // read, so 'unknown' beats a fabricated 'no'.
    requirePlanApproval: session.requirePlanApproval === true
      ? 'yes'
      : approved || (latestPlan !== undefined && session.state === 'AWAITING_PLAN_APPROVAL')
        ? 'yes'
        : session.requirePlanApproval === false
          ? 'no'
          : 'unknown',
    autoCreatePr: session.automationMode === 'AUTO_CREATE_PR' || pullRequests.length > 0
      ? 'yes'
      : session.automationMode === undefined || session.automationMode === 'AUTOMATION_MODE_UNSPECIFIED'
        ? 'unknown'
        : 'no',
    archived: session.archived === true,
    createTime: session.createTime ?? '',
    updateTime: session.updateTime ?? '',
    planId: latestPlan?.id ?? '',
    planSteps: planLines(latestPlan),
    planPending,
    planApproved: approved,
    pullRequests,
    latestCommand,
    generatedFiles: (session.generatedFiles ?? []).map(file => ({
      path: file.path ?? '',
      changeType: file.changeType ?? '',
      bytes: (file.content ?? '').length,
    })),
    approvalConfirmed: options.approvalConfirmed === true,
    logRead: options.logRead !== false,
    lastMessage,
    unchangedForMs: options.unchangedForMs ?? 0,
    lastProgress: progress === undefined
      ? ''
      : [progress.title, progress.description].filter(part => part !== undefined && part.length > 0).join(': '),
  }
}

/**
 * Project one source into a row.
 * @param source - the wire source.
 * @returns the row value.
 */
export function sourceRow(source: Source): SourceView {
  const repo = source.githubRepo
  return {
    name: source.name ?? '',
    owner: repo?.owner ?? '',
    repo: repo?.repo ?? '',
    isPrivate: repo?.isPrivate === true,
    defaultBranch: repo?.defaultBranch?.displayName ?? '',
    branches: (repo?.branches ?? []).flatMap(branch => branch.displayName ?? []),
  }
}

/**
 * Project one activity into a row.
 * @param activity - the wire activity.
 * @returns the row value.
 */
export function activityRow(activity: Activity): ActivityView {
  return {
    id: activity.id ?? '',
    time: activity.createTime ?? '',
    originator: activity.originator ?? '',
    kind: activityKind(activity),
    summary: activitySummary(activity),
    artifacts: (activity.artifacts ?? []).map(artifactSummary),
  }
}

/**
 * Find the newest unified diff in an activity log.
 *
 * Activities are append-only, so later pages hold later patches; the last
 * `changeSet` artifact is the state the session finished in.
 * @param activities - the session's event log, oldest first.
 * @returns the newest patch and its provenance, or undefined.
 */
export function latestPatch(activities: readonly Activity[]): GitPatch | undefined {
  for (let index = activities.length - 1; index >= 0; index -= 1) {
    const changeSet = activities[index]?.artifacts?.find(artifact => artifact.changeSet !== undefined)?.changeSet
    if (changeSet !== undefined) return changeSet.gitPatch
  }
  return undefined
}

/** Longest agent message the rendered text repeats before pointing at the log. */
const MESSAGE_DISPLAY_LIMIT = 1200

/**
 * Bound an agent message for display. The canonical value always keeps the full
 * text; only the rendered card is clipped, because a scoping question can run to
 * several paragraphs.
 * @param text - the message to show.
 * @returns the message, clipped with a pointer to the full log when long.
 */
function clipForDisplay(text: string): string {
  return text.length <= MESSAGE_DISPLAY_LIMIT
    ? text
    : text.slice(0, MESSAGE_DISPLAY_LIMIT) + ' [clipped; read the full log with jules_activities]'
}

/**
 * List the paths a unified diff touches.
 *
 * The service's `generatedFiles` manifest was empty on every session observed,
 * so the diff itself is the only reliable statement of what changed.
 * @param unidiff - the complete unified diff.
 * @returns one entry per touched path, in diff order.
 */
export function patchFiles(unidiff: string): string[] {
  const files: string[] = []
  for (const line of unidiff.split('\n')) {
    if (!line.startsWith('diff --git ')) continue
    const match = /^diff --git a\/(.+?) b\/(.+)$/.exec(line)
    const path = match?.[2]
    if (path !== undefined && !files.includes(path)) files.push(path)
  }
  return files
}

/** Render a session state with the action it asks for, when it asks for one. */
function stateLabel(state: string): string {
  if (state === 'AWAITING_PLAN_APPROVAL') return 'AWAITING_PLAN_APPROVAL (approve or reject the plan)'
  if (state === 'AWAITING_USER_FEEDBACK') return 'AWAITING_USER_FEEDBACK (the agent asked a question)'
  return state
}

/**
 * Render the source list.
 * @param sources - projected rows.
 * @returns the model-facing text.
 */
export function renderSources(sources: readonly SourceView[]): string {
  if (sources.length === 0) {
    return 'No repositories are connected to Jules. Install the Jules GitHub App at https://jules.google.com first.'
  }
  return sources.map((source) => {
    const visibility = source.isPrivate ? 'private' : 'public'
    const branch = source.defaultBranch.length > 0 ? ` default=${source.defaultBranch}` : ''
    return `${source.owner}/${source.repo} (${visibility},${branch}) -> jules_create source=${source.owner}/${source.repo}`
  }).join('\n')
}

/**
 * Render session rows as one line each.
 * @param rows - projected rows.
 * @param nextPageToken - continuation token, when the page was truncated.
 * @returns the model-facing text.
 */
export function renderSessionRows(rows: readonly SessionRow[], nextPageToken: string): string {
  const head = rows.length === 0 ? 'No Jules sessions matched.' : rows.map((row) => {
    const parts = [`${row.id}  ${row.state}`]
    if (row.title.length > 0) parts.push(row.title)
    if (row.source.length > 0) parts.push(shortSourceName(`sources/github/${row.source}`))
    if (row.pullRequests.length > 0) parts.push(row.pullRequests.join(' '))
    if (row.updateTime.length > 0) parts.push(`updated ${row.updateTime}`)
    return parts.join('  |  ')
  }).join('\n')
  return nextPageToken.length === 0 ? head : `${head}\n(nextPageToken: ${nextPageToken})`
}

/**
 * Render one session in full.
 * @param detail - the projected detail.
 * @returns the model-facing text.
 */
export function renderSessionDetail(detail: SessionDetail): string {
  const lines = [
    `${detail.title.length > 0 ? detail.title : '(untitled session)'}  [${detail.id}]`,
    `state: ${stateLabel(detail.state)}`,
  ]
  if (!detail.logRead) {
    // Without this the reader sees an empty plan, no approval, and no progress,
    // and concludes the session is idle — the opposite of "we could not look".
    lines.push('warning: the activity log could not be read, so plan, approval, latest command, and messages below are unknown rather than empty. Retry, or read it directly with jules_activities.')
  }
  if (detail.approvalConfirmed) {
    // The phase and the approval disagree in both directions, and the event log
    // is the one that is right.
    lines.push('approval confirmed by the planApproved event in the log.')
    if (detail.state === 'AWAITING_PLAN_APPROVAL') {
      lines.push('note: the service still reports AWAITING_PLAN_APPROVAL — that field lags its own approval, so trust the event, not the phase.')
    }
  }
  if (detail.unchangedForMs > 0) {
    // Meets a polling agent where it actually is: the answer it just got is the
    // one it already had.
    lines.push(
      `note: nothing has changed since your last check ${Math.round(detail.unchangedForMs / 1000)}s ago.`
      + ' Do not keep polling — a jules_watch notice is what tells you something happened.',
    )
  }
  if (detail.url.length > 0) lines.push(`url: ${detail.url}`)
  if (detail.source.length > 0) {
    lines.push(`repo: ${detail.source}${detail.branch.length > 0 ? ` (branch ${detail.branch})` : ''}`)
  } else {
    lines.push('repo: none (repoless session)')
  }
  lines.push(`plan approval required: ${detail.requirePlanApproval}`)
  lines.push(`auto-create PR: ${detail.autoCreatePr}`)
  if (detail.createTime.length > 0) lines.push(`created: ${detail.createTime}`)
  if (detail.updateTime.length > 0) lines.push(`updated: ${detail.updateTime}`)
  if (detail.planSteps.length > 0) {
    lines.push(`plan${detail.planPending ? ' (awaiting your approval)' : detail.planApproved ? ' (approved)' : ''}:`)
    lines.push(...detail.planSteps.map(step => `  ${step}`))
  }
  if (detail.latestCommand.length > 0) lines.push(`latest command: ${detail.latestCommand}`)
  if (detail.pullRequests.length > 0) lines.push(...detail.pullRequests.map(url => `pull request: ${url}`))
  if (detail.generatedFiles.length > 0) {
    lines.push(`generated files (${detail.generatedFiles.length}):`)
    lines.push(...detail.generatedFiles.map(file => `  ${file.changeType.length > 0 ? file.changeType : 'changed'} ${file.path}`))
  }
  if (detail.lastMessage.length > 0) {
    lines.push('latest agent message:')
    lines.push(...clipForDisplay(detail.lastMessage).split('\n').map(line => `  ${line}`))
  }
  if (detail.lastProgress.length > 0) lines.push(`latest progress: ${detail.lastProgress}`)
  if (detail.prompt.length > 0) lines.push(`prompt:\n  ${detail.prompt.replaceAll('\n', '\n  ')}`)
  return lines.join('\n')
}

/**
 * Render an activity page.
 * @param rows - projected rows.
 * @param nextPageToken - continuation token, when the page was truncated.
 * @returns the model-facing text.
 */
export function renderActivities(rows: readonly ActivityView[], nextPageToken: string): string {
  if (rows.length === 0) return 'This session has no activities yet.'
  const lines = rows.map((row) => {
    const head = [row.time, row.kind, row.originator].filter(part => part.length > 0).join('  ')
    const artifacts = row.artifacts.length === 0 ? '' : `\n    artifacts: ${row.artifacts.join('; ')}`
    return `${head}\n  ${row.summary.replaceAll('\n', '\n  ')}${artifacts}`
  })
  const body = lines.join('\n')
  return nextPageToken.length === 0 ? body : `${body}\n(nextPageToken: ${nextPageToken})`
}

/**
 * Render a wait result.
 * @param result - the canonical wait value.
 * @returns the model-facing text.
 */
export function renderWait(result: WaitResult): string {
  const outcome = result.timedOut
    ? `still ${result.state} after ${Math.round(result.waitedMs / 1000)}s`
    : `reached ${stateLabel(result.state)} after ${Math.round(result.waitedMs / 1000)}s`
  const lines = [`session ${result.id}: ${outcome}`]
  if (result.lastMessage.length > 0) {
    lines.push('latest agent message:')
    lines.push(...clipForDisplay(result.lastMessage).split('\n').map(line => `  ${line}`))
  }
  if (result.lastProgress.length > 0) lines.push(`latest progress: ${result.lastProgress}`)
  if (result.planSteps.length > 0) {
    lines.push('plan:')
    lines.push(...result.planSteps.map(step => `  ${step}`))
  }
  if (result.pullRequests.length > 0) lines.push(...result.pullRequests.map(url => `pull request: ${url}`))
  if (result.state === 'AWAITING_PLAN_APPROVAL') {
    lines.push(`next: call jules_approve_plan with session "${result.id}" to let the agent start, or jules_send_message to change the plan.`)
  } else if (result.state === 'AWAITING_USER_FEEDBACK') {
    lines.push(`next: read jules_activities for session "${result.id}" and answer with jules_send_message.`)
  } else if (result.state === 'FAILED') {
    lines.push(`next: read jules_activities for session "${result.id}" to see the failure reason.`)
  } else if (result.lastMessage.length > 0 && !result.settled) {
    lines.push(`next: the agent posted a message — answer it with jules_send_message for session "${result.id}", and watch again if the work is still running.`)
  } else if (result.timedOut) {
    lines.push(`next: call jules_wait or jules_status again for session "${result.id}".`)
  } else if (result.pullRequests.length === 0) {
    lines.push(`next: call jules_patch with session "${result.id}" to read the change, or jules_status for the full report.`)
  }
  return lines.join('\n')
}

/**
 * Render the newest patch, or explain why there is none.
 * @param result - the canonical patch value.
 * @returns the model-facing text.
 */
export function renderPatch(result: PatchResult): string {
  if (!result.found) {
    return `Session ${result.id} has no code change yet. Call jules_wait or jules_status first; a changeSet artifact appears only once the agent edits files.`
  }
  const lines: string[] = []
  if (result.baseCommitId.length > 0) lines.push(`base commit: ${result.baseCommitId}`)
  if (result.suggestedCommitMessage.length > 0) lines.push(`suggested commit message: ${result.suggestedCommitMessage}`)
  if (result.files.length > 0) {
    lines.push(`files (${result.files.length}):`)
    lines.push(...result.files.map(file => `  ${file}`))
  }
  if (result.truncated) {
    lines.push(`(showing bytes ${result.offset}-${result.offset + result.patch.length} of ${result.bytes}; continue with offset=${result.nextOffset})`)
  }
  lines.push(result.patch)
  return lines.join('\n')
}
