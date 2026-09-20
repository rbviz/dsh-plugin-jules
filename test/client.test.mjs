/**
 * Client behaviour against a stubbed transport: the request the service
 * actually receives, and how each failure shape is classified.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  JulesAuthError, JulesClient, JulesError, JulesNetworkError,
  JulesNotFoundError, JulesRateLimitError, JulesTimeoutError,
} from '../lib/client.js'

/** Build a client whose credential and transport are supplied by the test. */
function makeClient(handler, overrides = {}) {
  const calls = []
  const client = new JulesClient({
    resolveApiKey: async () => 'test-key',
    baseURL: 'https://jules.example/v1alpha',
    requestTimeoutMs: 5_000,
    defaultPageSize: 30,
    maxPageSize: 100,
    retry: { maxAttempts: 3, baseDelayMs: 1, maxDelayMs: 5 },
    fetchImpl: (url, init) => {
      calls.push({ url: String(url), init })
      return handler(String(url), init)
    },
    ...overrides,
  })
  return { client, calls }
}

/** A JSON response. */
function json(body, status = 200, headers = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  })
}

test('a request carries the API key header and the documented path', async () => {
  const { client, calls } = makeClient(() => json({ sessions: [] }))
  await client.listSessions({ pageSize: 5 })
  assert.equal(calls.length, 1)
  assert.equal(calls[0].url, 'https://jules.example/v1alpha/sessions?pageSize=5')
  assert.equal(calls[0].init.headers['X-Goog-Api-Key'], 'test-key')
})

test('page size is clamped into the range the service accepts', async () => {
  const { client, calls } = makeClient(() => json({ sources: [] }))
  await client.listSources({ pageSize: 5000 })
  await client.listSources({ pageSize: -3 })
  await client.listSources({})
  assert.match(calls[0].url, /pageSize=100/)
  assert.match(calls[1].url, /pageSize=1/)
  assert.match(calls[2].url, /pageSize=30/)
})

test('a session id and an activity cursor reach the path and query', async () => {
  const { client, calls } = makeClient(() => json({ activities: [] }))
  await client.listActivities('abc', { since: '2026-01-17T00:03:53Z', pageSize: 7 })
  const url = new URL(calls[0].url)
  assert.equal(url.pathname, '/v1alpha/sessions/abc/activities')
  assert.equal(url.searchParams.get('pageSize'), '7')
  // The reference documents ?createTime=, but the service rejects it with
  // "Cannot bind query parameter. Field 'createTime' could not be found", so
  // the filter expression the official SDK sends is what must appear.
  assert.equal(url.searchParams.get('filter'), 'create_time>"2026-01-17T00:03:53Z"')
  assert.equal(url.searchParams.has('createTime'), false)
})

test('no cursor means no filter parameter at all', async () => {
  const { client, calls } = makeClient(() => json({ activities: [] }))
  await client.listActivities('abc', { pageSize: 7 })
  assert.equal(new URL(calls[0].url).searchParams.has('filter'), false)
})

test('an id needing escaping is escaped', async () => {
  const { client, calls } = makeClient(() => json({}))
  await client.getSession('a/b')
  assert.match(calls[0].url, /sessions\/a%2Fb$/)
})

test('a JSON body is sent for the mutating calls', async () => {
  const { client, calls } = makeClient(() => json({}))
  await client.sendMessage('42', 'please refactor')
  assert.equal(calls[0].init.method, 'POST')
  assert.deepEqual(JSON.parse(calls[0].init.body), { prompt: 'please refactor' })
  assert.equal(calls[0].init.headers['Content-Type'], 'application/json')
})

test('approvePlan posts an empty object to the colon method', async () => {
  const { client, calls } = makeClient(() => json({}))
  await client.approvePlan('42')
  assert.equal(calls[0].url, 'https://jules.example/v1alpha/sessions/42:approvePlan')
  assert.equal(calls[0].init.body, '{}')
})

test('an empty response body decodes to undefined', async () => {
  const { client } = makeClient(() => new Response('', { status: 200 }))
  assert.equal(await client.approvePlan('42'), undefined)
})

test('each failure status maps to its own error class', async () => {
  const cases = [
    [401, JulesAuthError],
    [403, JulesAuthError],
    [404, JulesNotFoundError],
    [400, JulesError],
  ]
  for (const [status, expected] of cases) {
    const { client } = makeClient(() => json({ error: { message: 'nope' } }, status))
    await assert.rejects(() => client.getSession('1'), (error) => {
      assert.ok(error instanceof expected, `${status} should be ${expected.name}, got ${error.name}`)
      assert.match(error.message, /nope/)
      assert.equal(error.status, status)
      return true
    })
  }
})

test('a 2xx that is not JSON is a typed error, not a SyntaxError', async () => {
  // A proxy or a broken endpoint can answer 200 with HTML. That belongs in this
  // client's error taxonomy, not as a bare SyntaxError from JSON.parse.
  const { client } = makeClient(() => new Response('<html>gateway</html>', { status: 200 }))
  await assert.rejects(() => client.getSession('1'), (error) => {
    assert.ok(error instanceof JulesError, 'expected a JulesError, got ' + error.name)
    assert.match(error.message, /not JSON/)
    return true
  })
})

test('a failure without an error envelope still reports its status', async () => {
  const { client } = makeClient(() => new Response('<html>gateway</html>', { status: 400 }))
  await assert.rejects(() => client.getSession('1'), /HTTP 400/)
})

test('429 and 5xx are retried, then reported', async () => {
  let attempts = 0
  const { client, calls } = makeClient(() => {
    attempts += 1
    return json({ error: { message: 'slow down' } }, 429)
  })
  await assert.rejects(() => client.getSession('1'), JulesRateLimitError)
  assert.equal(attempts, 3)
  assert.equal(calls.length, 3)
})

test('a transient failure is retried and the later success is returned', async () => {
  let attempts = 0
  const { client } = makeClient(() => {
    attempts += 1
    return attempts < 2 ? json({ error: { message: 'boom' } }, 503) : json({ id: '7', state: 'QUEUED' })
  })
  assert.deepEqual(await client.getSession('7'), { id: '7', state: 'QUEUED' })
  assert.equal(attempts, 2)
})

test('Retry-After is honoured instead of the backoff step', async () => {
  let attempts = 0
  const started = Date.now()
  const { client } = makeClient(() => {
    attempts += 1
    return attempts < 2
      ? new Response(JSON.stringify({ error: { message: 'wait' } }), {
          status: 429, headers: { 'retry-after': '0.05' },
        })
      : json({ id: '1' })
  }, { retry: { maxAttempts: 2, baseDelayMs: 10_000, maxDelayMs: 10_000 } })
  await client.getSession('1')
  assert.ok(Date.now() - started < 5_000, 'Retry-After should win over the 10s base delay')
})

test('a caller abort surfaces the caller reason and stops retrying', async () => {
  const controller = new AbortController()
  const reason = new Error('caller went away')
  const { client, calls } = makeClient(() => {
    controller.abort(reason)
    return json({ error: { message: 'x' } }, 503)
  })
  await assert.rejects(() => client.getSession('1', controller.signal), /caller went away/)
  assert.equal(calls.length, 1)
})

test('a request that outlives its deadline raises a timeout', async () => {
  const { client } = makeClient(
    (_url, init) => new Promise((_resolve, reject) => {
      init.signal.addEventListener('abort', () => reject(init.signal.reason), { once: true })
    }),
    { requestTimeoutMs: 25 },
  )
  await assert.rejects(() => client.getSession('1'), JulesTimeoutError)
})

test('a transport failure becomes a network error', async () => {
  const { client } = makeClient(() => { throw new TypeError('fetch failed') })
  await assert.rejects(() => client.getSession('1'), (error) => {
    assert.ok(error instanceof JulesNetworkError)
    assert.match(error.message, /could not be reached/)
    return true
  })
})

test('a missing credential fails before any request is made', async () => {
  const { client, calls } = makeClient(() => json({}), { resolveApiKey: async () => undefined })
  await assert.rejects(() => client.getSession('1'), (error) => {
    assert.ok(error instanceof JulesAuthError)
    assert.match(error.message, /jules\.google\.com\/settings/)
    return true
  })
  assert.equal(calls.length, 0)
})

test('listAllActivities walks every page and stops at the last one', async () => {
  const pages = [
    { activities: [{ id: '1' }], nextPageToken: 't1' },
    { activities: [{ id: '2' }], nextPageToken: 't2' },
    { activities: [{ id: '3' }] },
  ]
  let index = 0
  const { client, calls } = makeClient(() => json(pages[index++]))
  assert.deepEqual((await client.listAllActivities('9')).map(a => a.id), ['1', '2', '3'])
  assert.equal(calls.length, 3)
  assert.match(calls[1].url, /pageToken=t1/)
})

test('listAllActivities stops at the page cap', async () => {
  let served = 0
  const { client } = makeClient(() => { served += 1; return json({ activities: [{ id: String(served) }], nextPageToken: 'more' }) })
  assert.equal((await client.listAllActivities('9', { maxPages: 4 })).length, 4)
  assert.equal(served, 4)
})
