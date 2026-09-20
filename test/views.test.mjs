/**
 * Projections and renders: the canonical value keeps a fixed shape, and the
 * text says what a model needs without restating the JSON.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  activityRow, latestPatch, patchFiles, renderActivities, renderPatch, renderSessionDetail,
  renderSessionRows, renderSources, renderWait, sessionDetail, sessionRow, sourceRow,
} from '../lib/views.js'

/** A finished session with a plan, a pull request, and one file. */
const SESSION = {
  id: '42',
  title: 'Add a health endpoint',
  state: 'COMPLETED',
  url: 'https://jules.google.com/session/42',
  prompt: 'Add /healthz',
  sourceContext: { source: 'sources/github/octocat/hello-world', githubRepoContext: { startingBranch: 'main' } },
  requirePlanApproval: true,
  automationMode: 'AUTO_CREATE_PR',
  outputs: [{ pullRequest: { url: 'https://github.com/octocat/hello-world/pull/7' } }],
  generatedFiles: [{ path: 'src/health.ts', changeType: 'created', content: 'export {}\n' }],
  createTime: '2026-01-01T00:00:00Z',
  updateTime: '2026-01-01T00:10:00Z',
}

/** The activity log that produced the plan and the file. */
const ACTIVITIES = [
  { id: 'a1', originator: 'agent', createTime: 'T1', planGenerated: { plan: { id: 'p1', steps: [{ index: 1, title: 'Add route', description: 'wire /healthz' }] } } },
  { id: 'a2', originator: 'user', createTime: 'T2', planApproved: { planId: 'p1' } },
  { id: 'a3', originator: 'agent', createTime: 'T3', progressUpdated: { title: 'Editing', description: 'src/health.ts' } },
  { id: 'a4', originator: 'agent', createTime: 'T4', sessionCompleted: {} },
]

test('sessionDetail carries the plan, its approval, and the deliverables', () => {
  const detail = sessionDetail(SESSION, ACTIVITIES)
  assert.equal(detail.id, '42')
  assert.equal(detail.source, 'octocat/hello-world')
  assert.equal(detail.branch, 'main')
  assert.equal(detail.planId, 'p1')
  assert.deepEqual(detail.planSteps, ['1. Add route — wire /healthz'])
  assert.equal(detail.planApproved, true)
  assert.deepEqual(detail.pullRequests, ['https://github.com/octocat/hello-world/pull/7'])
  assert.deepEqual(detail.generatedFiles, [
    { path: 'src/health.ts', changeType: 'created', bytes: 'export {}\n'.length },
  ])
  assert.equal(detail.lastProgress, 'Editing: src/health.ts')
  // Tri-state: the service does not echo these create-time inputs, so evidence
  // decides and 'unknown' is the honest fallback.
  assert.equal(detail.autoCreatePr, 'yes')
  assert.equal(detail.requirePlanApproval, 'yes')
  assert.equal(detail.planPending, false, 'a plan with an approval after it is not pending')
})

test('sessionDetail fills every member for a bare session', () => {
  const detail = sessionDetail({})
  // The canonical value never carries undefined, so a consumer can read every
  // declared member without defending against an absent key.
  assert.deepEqual(Object.keys(detail).sort(), [
    'approvalConfirmed', 'archived', 'autoCreatePr', 'branch', 'createTime', 'generatedFiles', 'id', 'lastMessage',
    'lastProgress', 'latestCommand', 'logRead',
    'planApproved', 'planId', 'planPending', 'planSteps', 'prompt', 'pullRequests', 'requirePlanApproval',
    'source', 'state', 'title', 'unchangedForMs', 'updateTime', 'url',
  ])
  for (const [key, value] of Object.entries(detail)) {
    assert.notEqual(value, undefined, key)
    if (key === 'state') continue
    // logRead is true by default: it reports a read that was *attempted and
    // failed*, so a projection that never looked has nothing to warn about.
    if (key === 'logRead') { assert.equal(value, true, key); continue }
    if (typeof value === 'boolean') assert.equal(value, false, key)
    else if (typeof value === 'number') assert.equal(value, 0, key)
    else if (Array.isArray(value)) assert.deepEqual(value, [], key)
    else if (key === 'requirePlanApproval' || key === 'autoCreatePr') {
      assert.equal(value, 'unknown', key)
    } else assert.equal(value, '', key)
  }
  // An unset state is the enum's own zero value, not an empty string.
  assert.equal(detail.state, 'STATE_UNSPECIFIED')
})

test('sessionDetail survives a log with no plan', () => {
  const detail = sessionDetail({ id: '1', state: 'QUEUED' }, [])
  assert.equal(detail.planId, '')
  assert.deepEqual(detail.planSteps, [])
  assert.equal(detail.planApproved, false)
})

test('latestPatch returns the newest change set', () => {
  const activities = [
    { artifacts: [{ changeSet: { gitPatch: { unidiffPatch: 'old' } } }] },
    { progressUpdated: { title: 'working' } },
    { artifacts: [{ bashOutput: { command: 'ls' } }, { changeSet: { gitPatch: { unidiffPatch: 'new', baseCommitId: 'abc' } } }] },
  ]
  assert.deepEqual(latestPatch(activities), { unidiffPatch: 'new', baseCommitId: 'abc' })
})

test('latestPatch reports nothing when no activity carries a diff', () => {
  assert.equal(latestPatch([{ progressUpdated: { title: 'x' } }]), undefined)
  assert.equal(latestPatch([]), undefined)
})

test('activityRow summarizes each event kind and its artifacts', () => {
  assert.equal(activityRow(ACTIVITIES[0]).kind, 'planGenerated')
  assert.match(activityRow(ACTIVITIES[0]).summary, /Plan generated with 1 step/)
  assert.match(activityRow(ACTIVITIES[2]).summary, /^Editing: src\/health\.ts$/)
  assert.equal(activityRow({ sessionFailed: { reason: 'no space' } }).summary, 'Session failed: no space')
  const withArtifacts = activityRow({
    artifacts: [
      { changeSet: { gitPatch: { unidiffPatch: 'diff --git a/x b/x\n+y\ndiff --git a/y b/y\n+z' } } },
      { bashOutput: { command: 'npm test', exitCode: 0 } },
      { media: { mimeType: 'image/png' } },
    ],
  })
  const patch = 'diff --git a/x b/x\n+y\ndiff --git a/y b/y\n+z'
  assert.deepEqual(withArtifacts.artifacts, [
    `changeSet: 2 file(s), ${patch.length} byte(s) of unified diff`,
    'bashOutput: npm test (exit 0)',
    'media: image/png',
  ])
})

test('sourceRow exposes repository facts and a missing branch list', () => {
  const row = sourceRow({
    name: 'sources/github/octocat/hello-world',
    githubRepo: { owner: 'octocat', repo: 'hello-world', isPrivate: true, defaultBranch: { displayName: 'main' } },
  })
  assert.deepEqual(row, {
    name: 'sources/github/octocat/hello-world', owner: 'octocat', repo: 'hello-world',
    isPrivate: true, defaultBranch: 'main', branches: [],
  })
  assert.deepEqual(sourceRow({}).branches, [])
})

test('sessionRow lists pull requests and tolerates their absence', () => {
  assert.deepEqual(sessionRow(SESSION).pullRequests, ['https://github.com/octocat/hello-world/pull/7'])
  assert.deepEqual(sessionRow({ id: '1' }).pullRequests, [])
})

test('renderSessionDetail names the state and its required action', () => {
  const text = renderSessionDetail(sessionDetail(SESSION, ACTIVITIES))
  assert.match(text, /Add a health endpoint {2}\[42\]/)
  assert.match(text, /state: COMPLETED/)
  assert.match(text, /pull request: https:\/\/github\.com\/octocat\/hello-world\/pull\/7/)
  assert.match(text, /generated files \(1\):/)
  const waiting = renderSessionDetail(sessionDetail({ id: '1', state: 'AWAITING_PLAN_APPROVAL' }))
  assert.match(waiting, /AWAITING_PLAN_APPROVAL \(approve or reject the plan\)/)
  assert.match(waiting, /repo: none \(repoless session\)/)
})

test('renderSessionRows marks an empty result and appends the cursor', () => {
  assert.match(renderSessionRows([], ''), /No Jules sessions matched/)
  const text = renderSessionRows([sessionRow(SESSION)], 'tok')
  assert.match(text, /42 {2}COMPLETED/)
  assert.match(text, /\(nextPageToken: tok\)/)
})

test('renderSources explains how to connect a repository when there are none', () => {
  assert.match(renderSources([]), /Install the Jules GitHub App/)
  const text = renderSources([sourceRow({ name: 'sources/github/a/b', githubRepo: { owner: 'a', repo: 'b', defaultBranch: { displayName: 'main' } } })])
  assert.match(text, /a\/b \(public, default=main\) -> jules_create source=a\/b/)
})

test('renderActivities reports an empty log and lists artifacts', () => {
  assert.match(renderActivities([], ''), /no activities yet/)
  const text = renderActivities([activityRow(ACTIVITIES[0])], '')
  assert.match(text, /planGenerated {2}agent/)
  assert.match(text, /Plan generated with 1 step/)
})

test('the last agent message survives projection and rendering', () => {
  // A session that stops to ask something produces no plan and no progress, so
  // this field is the only thing distinguishing it from an empty success.
  const detail = sessionDetail({ id: '1', state: 'COMPLETED' }, [
    { agentMessaged: { agentMessage: 'Should I also cover the admin path?' } },
  ])
  assert.equal(detail.lastMessage, 'Should I also cover the admin path?')
  assert.match(renderSessionDetail(detail), /latest agent message:/)
  assert.match(renderSessionDetail(detail), /Should I also cover the admin path\?/)
  assert.equal(sessionDetail({}, []).lastMessage, '')
  assert.doesNotMatch(renderSessionDetail(sessionDetail({}, [])), /latest agent message/)
})

test('a very long agent message is clipped for display only', () => {
  const long = 'x'.repeat(2_000)
  const detail = sessionDetail({ id: '1' }, [{ agentMessaged: { agentMessage: long } }])
  assert.equal(detail.lastMessage.length, 2_000, 'the canonical value keeps the full text')
  const text = renderSessionDetail(detail)
  assert.match(text, /\[clipped; read the full log with jules_activities\]/)
  assert.ok(text.length < long.length, 'the rendered card is shorter than the message')
})

test('a repeat check on an unchanged session says so', () => {
  // Polling is the failure mode this guards: an agent that asks twice must be
  // told the second answer bought nothing.
  const first = sessionDetail({ id: '1', state: 'IN_PROGRESS' })
  assert.equal(first.unchangedForMs, 0)
  assert.doesNotMatch(renderSessionDetail(first), /nothing has changed/)

  const repeat = sessionDetail({ id: '1', state: 'IN_PROGRESS' }, [], { unchangedForMs: 45_000 })
  assert.equal(repeat.unchangedForMs, 45_000)
  const text = renderSessionDetail(repeat)
  assert.match(text, /nothing has changed since your last check 45s ago/)
  assert.match(text, /Do not keep polling/)
  // The nudge is additive: the full report is still there.
  assert.match(text, /state: IN_PROGRESS/)
})

test('planPending tracks a plan that has not been approved', () => {
  const generated = { planGenerated: { plan: { id: 'p1', steps: [{ title: 'Do it' }] } } }
  assert.equal(sessionDetail({}, [generated]).planPending, true)
  assert.equal(sessionDetail({}, [generated, { planApproved: { planId: 'p1' } }]).planPending, false)
  // A second plan reopens the gate even after an earlier approval.
  assert.equal(
    sessionDetail({}, [generated, { planApproved: { planId: 'p1' } }, generated]).planPending,
    true,
  )
  assert.equal(sessionDetail({}, []).planPending, false)
})

test('the latest shell command is surfaced for diagnosing a stall', () => {
  const detail = sessionDetail({}, [
    { artifacts: [{ bashOutput: { command: 'bundle install' } }] },
    { progressUpdated: { title: 'thinking' } },
    { artifacts: [{ bashOutput: { command: 'bundle exec rspec' } }] },
  ])
  assert.equal(detail.latestCommand, 'bundle exec rspec')
  assert.equal(sessionDetail({}, []).latestCommand, '')
})

test('patchFiles lists each touched path once, in diff order', () => {
  const diff = [
    'diff --git a/src/a.ts b/src/a.ts',
    '+++ b/src/a.ts',
    'diff --git a/src/b.ts b/src/b.ts',
    'diff --git a/src/a.ts b/src/a.ts',
  ].join('\n')
  assert.deepEqual(patchFiles(diff), ['src/a.ts', 'src/b.ts'])
  assert.deepEqual(patchFiles(''), [])
})

test('renderWait states the outcome and the next tool to call', () => {
  const base = {
    id: '42', title: 't', state: 'COMPLETED', url: '', settled: true, timedOut: false,
    needsAttention: false, waitedMs: 12_000, polls: 3, planId: '', planSteps: [],
    pullRequests: [], lastMessage: '', lastProgress: '',
  }
  assert.match(renderWait(base), /reached COMPLETED after 12s/)
  assert.match(renderWait({ ...base, state: 'FAILED', timedOut: false }), /read jules_activities/)
  assert.match(renderWait({ ...base, state: 'AWAITING_PLAN_APPROVAL', timedOut: false }), /jules_approve_plan/)
  assert.match(renderWait({ ...base, state: 'IN_PROGRESS', timedOut: true }), /still IN_PROGRESS after 12s/)
  assert.match(renderWait({ ...base, pullRequests: ['u'] }), /pull request: u/)
})

test('renderPatch explains an absent diff and flags truncation', () => {
  const empty = {
    id: '42', found: false, patch: '', bytes: 0, truncated: false,
    offset: 0, nextOffset: 0, files: [], baseCommitId: '', suggestedCommitMessage: '', source: '',
  }
  assert.match(renderPatch(empty), /has no code change yet/)
  const full = { ...empty, found: true, patch: 'diff --git a/x b/x', bytes: 18, baseCommitId: 'abc', suggestedCommitMessage: 'feat: x' }
  const text = renderPatch(full)
  assert.match(text, /base commit: abc/)
  assert.match(text, /suggested commit message: feat: x/)
  assert.match(text, /diff --git a\/x b\/x/)
  assert.match(
    renderPatch({ ...full, truncated: true, offset: 0, nextOffset: 18 }),
    /showing bytes 0-18 of 18; continue with offset=18/,
  )
})
