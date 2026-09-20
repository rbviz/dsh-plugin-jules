/**
 * The watch settling rules, exercised against a stub client so the states that
 * end a watch, the activities that end it, the budget, and the report contents
 * are all reachable without a live agent owner or a real job registry.
 *
 * The activity-based cases matter most: Jules can post its final answer and
 * leave the session state reading IN_PROGRESS indefinitely, so a watcher that
 * trusted the state field alone would never report.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { JulesError, JulesNotFoundError } from '../lib/client.js'
import { runWatch } from '../lib/watch.js'
import { DEFAULT_WAIT_STATES } from '../lib/types.js'

/**
 * A client with scripted session states and activity pages.
 * @param states - one state per status poll; the last repeats.
 * @param baseline - the activity log the first full read returns.
 * @param pages - one page per incremental poll; the last repeats.
 */
function stubClient(states, baseline = [], pages = []) {
  let index = 0
  let pageIndex = 0
  const calls = { getSession: 0, listAllActivities: 0, listActivities: 0, listArgs: [] }
  return {
    calls,
    getSession: async () => {
      calls.getSession += 1
      return { id: '7', title: 't', state: states[Math.min(index++, states.length - 1)], url: 'u' }
    },
    listAllActivities: async () => {
      calls.listAllActivities += 1
      return baseline
    },
    listActivities: async (_session, options) => {
      calls.listActivities += 1
      calls.listArgs.push(options ?? {})
      const page = pages.length === 0 ? [] : pages[Math.min(pageIndex++, pages.length - 1)]
      return { activities: page }
    },
  }
}

const BOUNDS = { pollIntervalMs: 1, maxActivityPages: 3, settleOnMessage: true }
const TARGETS = new Set(DEFAULT_WAIT_STATES)
const signal = () => new AbortController().signal

test('a session that already finished settles without polling', async () => {
  const client = stubClient(['COMPLETED'])
  const outcome = await runWatch(client, '7', TARGETS, 60_000, BOUNDS, signal())
  assert.equal(outcome.trigger, 'state')
  assert.equal(client.calls.getSession, 1)
  assert.equal(outcome.detail, 'session COMPLETED')
  assert.match(outcome.report, /reached COMPLETED/)
})

test('a session already waiting for the caller does not settle on the stale state', async () => {
  // The "answer the agent, then watch for the reply" flow: the state lags at
  // AWAITING_USER_FEEDBACK after sendMessage, so settling on it would report
  // the very thing the caller just acted on.
  const client = stubClient(['AWAITING_USER_FEEDBACK'])
  const outcome = await runWatch(client, '7', TARGETS, 1, BOUNDS, signal())
  assert.equal(outcome.trigger, 'timeout')
})

test('reaching a waiting state after moving away settles the watch', async () => {
  const client = stubClient(['AWAITING_USER_FEEDBACK', 'IN_PROGRESS', 'AWAITING_USER_FEEDBACK'])
  const outcome = await runWatch(client, '7', TARGETS, 60_000, BOUNDS, signal())
  assert.equal(outcome.trigger, 'state')
  assert.equal(outcome.detail, 'session AWAITING_USER_FEEDBACK')
})

test('an in-flight session is polled until it reaches a target state', async () => {
  const client = stubClient(['QUEUED', 'PLANNING', 'IN_PROGRESS', 'COMPLETED'])
  const outcome = await runWatch(client, '7', TARGETS, 60_000, BOUNDS, signal())
  assert.equal(client.calls.getSession, 4)
  assert.equal(outcome.trigger, 'state')
  assert.equal(outcome.detail, 'session COMPLETED')
})

test('a session that stops to ask something also ends the watch', async () => {
  const client = stubClient(['IN_PROGRESS', 'AWAITING_USER_FEEDBACK'])
  const outcome = await runWatch(client, '7', TARGETS, 60_000, BOUNDS, signal())
  assert.equal(outcome.detail, 'session AWAITING_USER_FEEDBACK')
  assert.match(outcome.report, /jules_send_message/)
})

test('an agent message settles the watch while the state stays IN_PROGRESS', async () => {
  // The regression that prompted this rule: the report arrived, the state did not move.
  const client = stubClient(['IN_PROGRESS', 'IN_PROGRESS', 'IN_PROGRESS'], [], [
    [],
    [{ id: 'm1', createTime: 'T2', agentMessaged: { agentMessage: 'Here is the answer: 5 languages.' } }],
  ])
  const outcome = await runWatch(client, '7', TARGETS, 60_000, BOUNDS, signal())
  assert.equal(outcome.trigger, 'message')
  // Reads as a checkpoint, not as completion: the session may keep going.
  assert.equal(outcome.detail, 'checkpoint: agent message (IN_PROGRESS)')
  assert.match(outcome.report, /Here is the answer: 5 languages\./)
})

test('a baseline agent message is not news and does not settle the watch', async () => {
  // Otherwise "answer the agent, then watch for its reply" re-reports the very
  // question that was just answered.
  const client = stubClient(['IN_PROGRESS'], [
    { id: 'm1', createTime: 'T1', agentMessaged: { agentMessage: 'already answered' } },
  ])
  const outcome = await runWatch(client, '7', TARGETS, 1, BOUNDS, signal())
  assert.equal(outcome.trigger, 'timeout')
})

test('a terminal activity in the baseline still settles, because the session is over', async () => {
  const client = stubClient(['IN_PROGRESS'], [{ id: 'c1', sessionCompleted: {} }])
  const outcome = await runWatch(client, '7', TARGETS, 60_000, BOUNDS, signal())
  assert.equal(outcome.trigger, 'completed')
})

test('a completion activity settles even when the state never moves', async () => {
  const client = stubClient(['IN_PROGRESS'], [], [[{ id: 'c1', sessionCompleted: {} }]])
  const outcome = await runWatch(client, '7', TARGETS, 60_000, BOUNDS, signal())
  assert.equal(outcome.trigger, 'completed')
  assert.equal(outcome.detail, 'session completed (IN_PROGRESS)')
})

test('a failure activity settles without waiting out the budget', async () => {
  const client = stubClient(['IN_PROGRESS'], [], [[{ id: 'f1', sessionFailed: { reason: 'build broke' } }]])
  const outcome = await runWatch(client, '7', TARGETS, 60_000, BOUNDS, signal())
  assert.equal(outcome.trigger, 'failed')
  assert.equal(outcome.detail, 'session failed (IN_PROGRESS)')
})

test('progress updates alone never end the watch', async () => {
  const client = stubClient(['IN_PROGRESS'], [], [[{ id: 'p1', progressUpdated: { title: 'working' } }]])
  const outcome = await runWatch(client, '7', TARGETS, 5, BOUNDS, signal())
  assert.equal(outcome.trigger, 'timeout')
  assert.ok(client.calls.listActivities > 0, 'the watch kept polling the log')
})

test('settleOnMessage false ignores the agent speaking', async () => {
  const client = stubClient(['IN_PROGRESS'], [
    { id: 'm1', createTime: 'T1', agentMessaged: { agentMessage: 'ignored' } },
  ])
  const outcome = await runWatch(client, '7', TARGETS, 1, { ...BOUNDS, settleOnMessage: false }, signal())
  assert.equal(outcome.trigger, 'timeout')
})

test('an exhausted budget reports the state rather than waiting forever', async () => {
  const client = stubClient(['IN_PROGRESS'])
  const outcome = await runWatch(client, '7', TARGETS, 1, BOUNDS, signal())
  assert.equal(outcome.trigger, 'timeout')
  assert.match(outcome.detail, /^still IN_PROGRESS after \d+s$/)
  assert.match(outcome.report, /still IN_PROGRESS/)
})

test('the report carries the plan, the pull request, and the last agent message', async () => {
  const client = stubClient(['COMPLETED'], [
    { id: 'a1', planGenerated: { plan: { id: 'p1', steps: [{ index: 1, title: 'Do the thing' }] } } },
    { id: 'a2', agentMessaged: { agentMessage: 'Which branch should I target?' } },
  ])
  const outcome = await runWatch(client, '7', TARGETS, 60_000, BOUNDS, signal())
  assert.match(outcome.report, /1\. Do the thing/)
  assert.match(outcome.report, /latest agent message:/)
  assert.match(outcome.report, /Which branch should I target\?/)
})

test('a custom target set ends the watch on its own terms', async () => {
  const client = stubClient(['QUEUED', 'IN_PROGRESS'])
  const outcome = await runWatch(client, '7', new Set(['IN_PROGRESS']), 60_000, BOUNDS, signal())
  assert.equal(outcome.trigger, 'state')
  assert.equal(outcome.detail, 'session IN_PROGRESS')
  assert.equal(client.calls.getSession, 2)
})

test('the incremental poll carries the newest createTime as its cursor', async () => {
  const client = stubClient(['IN_PROGRESS'], [{ id: 'a1', createTime: 'T1' }])
  await runWatch(client, '7', TARGETS, 5, BOUNDS, signal())
  const cursored = client.calls.listArgs.filter(args => args.since !== undefined)
  assert.ok(cursored.length > 0, 'later polls asked only for what is new')
  assert.equal(cursored[0].since, 'T1')
})

test('a rejected cursor is dropped instead of failing the watch', async () => {
  // The cursor form is not in the API reference, so a deployment may refuse it.
  // The watch must lose the optimization, not the watch itself.
  let cursored = 0
  let plain = 0
  const client = {
    listAllActivities: async () => [{ id: 'a1', createTime: 'T1' }],
    getSession: async () => ({ id: '7', state: 'IN_PROGRESS' }),
    listActivities: async (_session, options) => {
      if (options?.since !== undefined) {
        cursored += 1
        throw new JulesError('Cannot bind query parameter. Field \'createTime\' could not be found', 400)
      }
      plain += 1
      return { activities: [{ id: 'm1', createTime: 'T2', agentMessaged: { agentMessage: 'reply' } }] }
    },
  }
  const outcome = await runWatch(client, '7', TARGETS, 60_000, BOUNDS, signal())
  assert.equal(cursored, 1, 'the cursor was attempted exactly once')
  assert.ok(plain >= 1, 'the fallback re-read the log without a cursor')
  assert.equal(outcome.trigger, 'message')
  assert.match(outcome.report, /reply/)
})

test('a non-400 failure while cursored is not swallowed', async () => {
  const client = {
    listAllActivities: async () => [{ id: 'a1', createTime: 'T1' }],
    getSession: async () => ({ id: '7', state: 'IN_PROGRESS' }),
    listActivities: async () => { throw new JulesError('server exploded', 500) },
  }
  await assert.rejects(
    () => runWatch(client, '7', TARGETS, 60_000, BOUNDS, signal()),
    /server exploded/,
  )
})

test('a session that is not readable yet is retried, not failed', async () => {
  // Jules mints the session id before the resource is queryable, so an
  // immediate first read answers 404. Dying there would kill every watch
  // started right after jules_create, which is the normal way to use it.
  let attempts = 0
  const client = {
    listAllActivities: async () => {
      attempts += 1
      if (attempts === 1) throw new JulesNotFoundError('Requested entity was not found.', 404)
      return []
    },
    getSession: async () => ({ id: '7', state: 'COMPLETED' }),
    listActivities: async () => ({ activities: [] }),
  }
  const outcome = await runWatch(client, '7', TARGETS, 60_000, BOUNDS, signal())
  assert.equal(outcome.trigger, 'state')
  assert.equal(attempts, 2, 'the first not-found was retried instead of reported')
})

test('an error that is not a not-found is reported immediately', async () => {
  let attempts = 0
  const client = {
    listAllActivities: async () => {
      attempts += 1
      throw new Error('service unreachable')
    },
    getSession: async () => ({ id: '7', state: 'COMPLETED' }),
  }
  await assert.rejects(() => runWatch(client, '7', TARGETS, 60_000, BOUNDS, signal()), /service unreachable/)
  assert.equal(attempts, 1, 'no visibility retry for a non-404 failure')
})

test('a client failure propagates so the job can settle as failed', async () => {
  const client = { getSession: async () => { throw new Error('service unreachable') }, listAllActivities: async () => [] }
  await assert.rejects(
    () => runWatch(client, '7', TARGETS, 60_000, BOUNDS, signal()),
    /service unreachable/,
  )
})

test('cancellation stops the watch instead of running out the budget', async () => {
  const controller = new AbortController()
  const client = {
    listAllActivities: async () => [],
    getSession: async () => {
      controller.abort(new Error('watch cancelled'))
      return { id: '7', state: 'IN_PROGRESS' }
    },
  }
  await assert.rejects(
    () => runWatch(client, '7', TARGETS, 60_000, { ...BOUNDS, pollIntervalMs: 5_000 }, controller.signal),
    /watch cancelled/,
  )
})
