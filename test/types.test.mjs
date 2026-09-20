/**
 * Normalization rules: a model may name a session or a repository in any of
 * several spellings, and every one of them has to reach the API as the single
 * form it accepts.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { activityKind, sessionIdOf, shortSourceName, sourceNameOf } from '../lib/types.js'

test('sessionIdOf accepts every spelling the API and the UI produce', () => {
  assert.equal(sessionIdOf('123'), '123')
  assert.equal(sessionIdOf('sessions/123'), '123')
  assert.equal(sessionIdOf('  sessions/123  '), '123')
  assert.equal(sessionIdOf('sessions/123/'), '123')
  assert.equal(sessionIdOf('https://jules.google.com/session/abc-1'), 'abc-1')
  assert.equal(sessionIdOf('https://jules.google.com/session/abc-1?x=1'), 'abc-1')
})

test('sessionIdOf rejects an empty or activity-shaped reference', () => {
  assert.throws(() => sessionIdOf(''), /must not be empty/)
  assert.throws(() => sessionIdOf('   '), /must not be empty/)
  assert.throws(() => sessionIdOf('sessions/1/activities/2'), /names an activity/)
})

test('sourceNameOf produces the canonical resource name', () => {
  assert.equal(sourceNameOf('octocat/hello-world'), 'sources/github/octocat/hello-world')
  assert.equal(sourceNameOf('github/octocat/hello-world'), 'sources/github/octocat/hello-world')
  assert.equal(sourceNameOf('sources/github/octocat/hello-world'), 'sources/github/octocat/hello-world')
})

test('sourceNameOf rejects anything that is not owner/repo', () => {
  assert.throws(() => sourceNameOf('octocat'), /not a repository reference/)
  assert.throws(() => sourceNameOf('a/b/c'), /not a repository reference/)
  assert.throws(() => sourceNameOf('/b'), /not a repository reference/)
})

test('shortSourceName round-trips and passes unknown names through', () => {
  assert.equal(shortSourceName('sources/github/octocat/hello-world'), 'octocat/hello-world')
  assert.equal(shortSourceName('sources/other/thing'), 'sources/other/thing')
  assert.equal(shortSourceName(undefined), '')
})

test('activityKind identifies each event member and the unknown case', () => {
  assert.equal(activityKind({ planGenerated: { plan: {} } }), 'planGenerated')
  assert.equal(activityKind({ planApproved: { planId: 'p' } }), 'planApproved')
  assert.equal(activityKind({ userMessaged: { userMessage: 'hi' } }), 'userMessaged')
  assert.equal(activityKind({ agentMessaged: { agentMessage: 'hi' } }), 'agentMessaged')
  assert.equal(activityKind({ progressUpdated: { title: 't' } }), 'progressUpdated')
  assert.equal(activityKind({ sessionCompleted: {} }), 'sessionCompleted')
  assert.equal(activityKind({ sessionFailed: { reason: 'r' } }), 'sessionFailed')
  assert.equal(activityKind({ description: 'bare' }), 'unknown')
})
