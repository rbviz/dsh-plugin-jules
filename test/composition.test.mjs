/**
 * Real-composition test.
 *
 * The plugin is mounted through the Cordis loader from a cordis.yml beside the
 * genuine system-prompt and tools services — the same path a profile takes —
 * rather than through a hand-built `ctx.plugin(...)` call. That is what proves
 * the three things a unit test cannot: the built package resolves its in-box
 * imports, the exported Config validates a real loader row, and every tool
 * reaches the registry and runs through the real execution pipeline.
 */
import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import { pathToFileURL } from 'node:url'

/** Requests the stubbed transport received, newest last. */
const requests = []
/** Canned responses keyed by `METHOD path`. */
const routes = new Map()

const originalFetch = globalThis.fetch

/** Install a transport that records the request and answers from `routes`. */
function stubFetch() {
  globalThis.fetch = async (url, init = {}) => {
    const target = new URL(String(url))
    const key = `${init.method ?? 'GET'} ${target.pathname}`
    requests.push({ key, url: target, init })
    const handler = routes.get(key)
    if (handler === undefined) {
      return new Response(JSON.stringify({ error: { message: `no stub for ${key}` } }), { status: 404 })
    }
    return handler(target, init)
  }
}

/** A JSON response. */
function json(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

let ctx
let rootEntry

before(async () => {
  stubFetch()
  ctx = new Context()
  ctx.baseUrl = pathToFileURL(new URL('./composition/', import.meta.url).pathname).href + '/'
  await ctx.plugin(Loader)
  rootEntry = await ctx.loader.create({
    name: '@deepseek-ai/cordis-plugin-include',
    config: { path: './cordis.yml' },
  })
  // The include settles once every row has mounted; a row held PENDING on a
  // missing service would surface here as a timeout rather than a silent skip.
  for (let attempt = 0; attempt < 200 && ctx.get('tools') === undefined; attempt += 1) {
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  assert.notEqual(ctx.get('tools'), undefined, 'the tools service never became available')
})

after(async () => {
  globalThis.fetch = originalFetch
  await ctx?.fiber.dispose()
})

/**
 * Run one tool through the registry.
 * @param name - registered tool name.
 * @param args - declared arguments.
 * @returns the normalized result.
 */
async function call(name, args) {
  return ctx.tools.execute({
    callId: `composition-${name}`,
    name,
    arguments: args,
    signal: AbortSignal.timeout(10_000),
  })
}

/** Flatten a result's content blocks into one string. */
function textOf(result) {
  return result.content.map(block => (block.type === 'text' ? block.text : '')).join('')
}

test('the composition mounted without leaving a row pending', () => {
  assert.notEqual(rootEntry, undefined)
  assert.equal(ctx.get('systemPrompt') !== undefined, true)
})

test('every declared tool is registered', async () => {
  const expected = [
    'jules_sources', 'jules_create', 'jules_list', 'jules_status', 'jules_activities',
    'jules_approve_plan', 'jules_send_message', 'jules_wait', 'jules_patch', 'jules_watch',
  ]
  // An unknown tool name fails through the same pipeline, so a successful call
  // for each name is the registration assertion. Session 1 is answered as
  // already finished so the sweep does not walk the not-found backoff.
  routes.set('GET /v1alpha/sources', () => json({ sources: [] }))
  routes.set('GET /v1alpha/sessions/1', () => json({ id: '1', state: 'COMPLETED' }))
  routes.set('POST /v1alpha/sessions', () => json({ id: '1', state: 'COMPLETED' }))
  routes.set('GET /v1alpha/sessions/1/activities', () => json({ activities: [] }))
  for (const name of expected) {
    const result = await call(name, name === 'jules_sources' ? {} : { session: '1', prompt: 'x' })
    // Only the argument shape can fail here; unknown-tool failure looks different.
    assert.doesNotMatch(textOf(result), /unknown tool/i, `${name} is not registered`)
  }
})

test('jules_sources authenticates and renders the repository list', async () => {
  requests.length = 0
  routes.set('GET /v1alpha/sources', () => json({
    sources: [{
      name: 'sources/github/octocat/hello-world',
      githubRepo: { owner: 'octocat', repo: 'hello-world', defaultBranch: { displayName: 'main' } },
    }],
  }))
  const result = await call('jules_sources', {})
  assert.equal(result.isError, false)
  assert.equal(requests[0].init.headers['X-Goog-Api-Key'], 'composition-test-key')
  assert.equal(requests[0].url.searchParams.get('pageSize'), '30')
  assert.match(textOf(result), /octocat\/hello-world \(public, default=main\)/)
})

test('jules_create sends the documented session body', async () => {
  requests.length = 0
  routes.set('POST /v1alpha/sessions', () => json({
    id: '99', state: 'QUEUED', title: 'Fix the build',
    sourceContext: { source: 'sources/github/octocat/hello-world', githubRepoContext: { startingBranch: 'dev' } },
    requirePlanApproval: true,
  }))
  const result = await call('jules_create', {
    prompt: 'Fix the failing build',
    source: 'octocat/hello-world',
    branch: 'dev',
    requirePlanApproval: true,
    autoCreatePr: true,
  })
  assert.equal(result.isError, false)
  const body = JSON.parse(requests[0].init.body)
  assert.deepEqual(body, {
    prompt: 'Fix the failing build',
    requirePlanApproval: true,
    automationMode: 'AUTO_CREATE_PR',
    sourceContext: {
      source: 'sources/github/octocat/hello-world',
      githubRepoContext: { startingBranch: 'dev' },
    },
  })
  assert.match(textOf(result), /Started Jules session 99 \(QUEUED\)/)
  assert.match(textOf(result), /jules_approve_plan/)
})

test('a repoless create omits sourceContext entirely', async () => {
  requests.length = 0
  routes.set('POST /v1alpha/sessions', () => json({ id: '100', state: 'QUEUED' }))
  await call('jules_create', { prompt: 'Draft a design doc' })
  assert.equal('sourceContext' in JSON.parse(requests[0].init.body), false)
})

test('jules_status reports the plan and the pull request', async () => {
  requests.length = 0
  routes.set('GET /v1alpha/sessions/77', () => json({
    id: '77', state: 'AWAITING_PLAN_APPROVAL', title: 'Add tests',
    outputs: [{ pullRequest: { url: 'https://example.test/pr/1' } }],
  }))
  routes.set('GET /v1alpha/sessions/77/activities', () => json({
    activities: [{
      id: 'a1', originator: 'agent', createTime: 'T1',
      planGenerated: { plan: { id: 'p9', steps: [{ index: 1, title: 'Write tests' }] } },
    }],
  }))
  const result = await call('jules_status', { session: 'sessions/77' })
  assert.equal(result.isError, false)
  const text = textOf(result)
  assert.match(text, /AWAITING_PLAN_APPROVAL \(approve or reject the plan\)/)
  assert.match(text, /1\. Write tests/)
  assert.match(text, /pull request: https:\/\/example\.test\/pr\/1/)
})

test('jules_wait returns when the session moves into a state that needs you', async () => {
  requests.length = 0
  let polls = 0
  routes.set('GET /v1alpha/sessions/5', () => {
    polls += 1
    return json({ id: '5', state: polls === 1 ? 'IN_PROGRESS' : 'AWAITING_PLAN_APPROVAL' })
  })
  routes.set('GET /v1alpha/sessions/5/activities', () => json({ activities: [] }))
  const result = await call('jules_wait', { session: '5', timeoutMs: 5_000 })
  assert.equal(result.isError, false)
  assert.match(textOf(result), /reached AWAITING_PLAN_APPROVAL/)
})

test('jules_wait reports an answer that arrived while the state stayed open', async () => {
  // The foreground wait had the same bug as the watcher: it polled the session
  // state alone, so a session that posted its answer while state read
  // IN_PROGRESS waited out the whole budget and reported nothing.
  requests.length = 0
  let reads = 0
  routes.set('GET /v1alpha/sessions/6', () => json({ id: '6', state: 'IN_PROGRESS' }))
  routes.set('GET /v1alpha/sessions/6/activities', () => {
    reads += 1
    return json({
      activities: reads === 1 ? [] : [{
        id: 'm1', createTime: 'T1', originator: 'agent',
        agentMessaged: { agentMessage: 'The extension supports 14 locales.' },
      }],
    })
  })
  const result = await call('jules_wait', { session: '6', timeoutMs: 5_000 })
  assert.equal(result.isError, false)
  const text = textOf(result)
  assert.match(text, /The extension supports 14 locales/)
  assert.doesNotMatch(text, /still IN_PROGRESS/)
})

test('jules_patch returns the newest unified diff', async () => {
  requests.length = 0
  routes.set('GET /v1alpha/sessions/3/activities', () => json({
    activities: [
      { id: 'a1', artifacts: [{ changeSet: { gitPatch: { unidiffPatch: 'diff --git a/old b/old' } } }] },
      { id: 'a2', artifacts: [{ changeSet: { gitPatch: {
        unidiffPatch: 'diff --git a/src/x.ts b/src/x.ts\n+export const x = 1',
        baseCommitId: 'deadbeef',
        suggestedCommitMessage: 'feat: add x',
      } } }] },
    ],
  }))
  const result = await call('jules_patch', { session: '3' })
  assert.equal(result.isError, false)
  const text = textOf(result)
  assert.match(text, /base commit: deadbeef/)
  assert.match(text, /feat: add x/)
  assert.match(text, /\+export const x = 1/)
  assert.doesNotMatch(text, /a\/old b\/old/)
})

test('jules_watch is registered only because the job registry is mounted', async () => {
  // The row resolves through ctx.inject(['jobs']); without jobs-local in the
  // fixture the tool would not exist at all.
  assert.notEqual(ctx.get('jobs'), undefined)
  const result = await call('jules_watch', { session: '1' })
  // This composition runs tools with no owning agent, so the guard fires.
  assert.equal(result.isError, true)
  assert.match(textOf(result), /requires an agent Session/)
})

test('jules_approve_plan confirms the approval from the log, not the phase', async () => {
  // The service is eventually consistent about its own actions: the approval
  // lands, the planApproved event lags, and the phase lags differently again.
  // Reporting the first snapshot lied in both directions.
  requests.length = 0
  let reads = 0
  routes.set('POST /v1alpha/sessions/11:approvePlan', () => json({}))
  routes.set('GET /v1alpha/sessions/11', () => json({ id: '11', state: 'AWAITING_PLAN_APPROVAL' }))
  routes.set('GET /v1alpha/sessions/11/activities', () => {
    reads += 1
    return json({ activities: reads === 1 ? [] : [{ id: 'a1', planApproved: { planId: 'p1' } }] })
  })
  const result = await call('jules_approve_plan', { session: '11' })
  assert.equal(result.isError, false)
  const text = textOf(result)
  assert.match(text, /the planApproved event is in the log/)
  assert.match(text, /still reports AWAITING_PLAN_APPROVAL/)
  assert.match(text, /trust the event, not the phase/)
})

test('an approval that cannot be confirmed says so instead of claiming failure', async () => {
  requests.length = 0
  routes.set('POST /v1alpha/sessions/12:approvePlan', () => json({}))
  routes.set('GET /v1alpha/sessions/12', () => json({ id: '12', state: 'AWAITING_PLAN_APPROVAL' }))
  routes.set('GET /v1alpha/sessions/12/activities', () => json({ activities: [] }))
  const result = await call('jules_approve_plan', { session: '12' })
  assert.equal(result.isError, false)
  const text = textOf(result)
  // The count is interpolated, not the literal placeholder.
  assert.match(text, /had not appeared after 3 reads/)
  assert.match(text, /service lagging, not a failed approval/)
  assert.match(text, /confirm with jules_activities/)
})

test('a repeated jules_status tells the caller nothing changed', async () => {
  requests.length = 0
  routes.set('GET /v1alpha/sessions/8', () => json({ id: '8', state: 'IN_PROGRESS', updateTime: 'T1' }))
  routes.set('GET /v1alpha/sessions/8/activities', () => json({ activities: [] }))
  const first = await call('jules_status', { session: '8' })
  assert.doesNotMatch(textOf(first), /nothing has changed/)
  const second = await call('jules_status', { session: '8' })
  assert.match(textOf(second), /nothing has changed since your last check/)
  assert.match(textOf(second), /Do not keep polling/)
})

test('a jules_status that sees movement carries no nudge', async () => {
  requests.length = 0
  let reads = 0
  routes.set('GET /v1alpha/sessions/9', () => json({ id: '9', state: 'IN_PROGRESS', updateTime: `T${++reads}` }))
  routes.set('GET /v1alpha/sessions/9/activities', () => json({ activities: [] }))
  await call('jules_status', { session: '9' })
  const moved = await call('jules_status', { session: '9' })
  assert.doesNotMatch(textOf(moved), /nothing has changed/)
})

test('a status whose log could not be read says so, not that the log is empty', async () => {
  // The session read succeeds and the log read fails. Reporting an empty log
  // renders as "no plan, nothing approved, no progress" — the opposite of what
  // an unreadable log means, and the reader would act on it.
  requests.length = 0
  routes.set('GET /v1alpha/sessions/13', () => json({ id: '13', state: 'IN_PROGRESS' }))
  routes.set('GET /v1alpha/sessions/13/activities', () => json({ error: { message: 'log unavailable' } }, 400))
  const result = await call('jules_status', { session: '13' })
  assert.equal(result.isError, false)
  const text = textOf(result)
  assert.match(text, /the activity log could not be read/)
  assert.match(text, /unknown rather than empty/)
  // The session itself was readable, so that part is still reported.
  assert.match(text, /state: IN_PROGRESS/)
})

test('an approval whose log could not be read is not reported as unconfirmed', async () => {
  requests.length = 0
  routes.set('POST /v1alpha/sessions/14:approvePlan', () => json({}))
  routes.set('GET /v1alpha/sessions/14', () => json({ id: '14', state: 'AWAITING_PLAN_APPROVAL' }))
  routes.set('GET /v1alpha/sessions/14/activities', () => json({ error: { message: 'log unavailable' } }, 400))
  const result = await call('jules_approve_plan', { session: '14' })
  assert.equal(result.isError, false)
  const text = textOf(result)
  assert.match(text, /the activity log could not be read/)
  // "could not look" must not read as "looked and saw nothing".
  assert.doesNotMatch(text, /had not appeared after/)
})

test('a service failure becomes a tool error, not a crash', async () => {
  requests.length = 0
  routes.set('GET /v1alpha/sessions/404', () => json({ error: { message: 'Session not found' } }, 404))
  const result = await call('jules_status', { session: '404' })
  assert.equal(result.isError, true)
  assert.match(textOf(result), /Session not found/)
})

test('an invalid session reference is rejected before any request', async () => {
  requests.length = 0
  const result = await call('jules_status', { session: 'sessions/1/activities/2' })
  assert.equal(result.isError, true)
  assert.match(textOf(result), /names an activity/)
  assert.equal(requests.length, 0)
})
