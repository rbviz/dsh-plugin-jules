/**
 * The restart note reaching the model, which is the half a restart used to be
 * required to observe.
 *
 * A record is seeded on disk before boot, matching the shape the json backend
 * writes, so this is the state a restarted harness loads. If the note does not
 * appear here it will not appear after a restart either.
 */
import assert from 'node:assert/strict'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { after, before, test } from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import { pathToFileURL } from 'node:url'
import { julesGuidance } from '../lib/index.js'

/** Where this fixture's storage backend roots, mirroring the cordis.yml entry. */
const STORAGE_ROOT = new URL('../.storage-guidance/', import.meta.url).pathname

/**
 * Seed one journal record exactly as the per-record json backend writes it.
 * @param key - file name without the extension.
 * @param session - Jules session id to record.
 * @param expiresAt - epoch ms the watch budget would end.
 */
function seed(key, session, expiresAt) {
  const dir = join(STORAGE_ROOT, 'jules_watches', 'watches')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, key + '.json'), JSON.stringify({ version: 1, record: { session, startedAt: 1, expiresAt } }))
}

let ctx
let prompt = ''

before(async () => {
  rmSync(STORAGE_ROOT, { recursive: true, force: true })
  // One watch that outlived the harness, and one whose budget had already run
  // out: the note must name the first and stay silent about the second.
  seed('orphan', 'session-orphan-1234', Date.now() + 3_600_000)
  seed('stale', 'session-expired-5678', Date.now() - 3_600_000)

  ctx = new Context()
  ctx.baseUrl = pathToFileURL(new URL('./guidance/', import.meta.url).pathname).href + '/'
  await ctx.plugin(Loader)
  await ctx.loader.create({ name: '@deepseek-ai/cordis-plugin-include', config: { path: './cordis.yml' } })
  // Readiness is the journal being open, not the section existing. The section
  // is registered synchronously with a lazy text function, while the store opens
  // asynchronously, so assembling the moment the section appears races the
  // domain open and reads an empty journal — which is exactly how this test
  // first failed, reporting the product broken when it was the test.
  for (let attempt = 0; attempt < 400; attempt += 1) {
    const open = ctx.get('storageDomain')?.get('jules_watches') !== undefined
    if (open && ctx.get('systemPrompt') !== undefined) {
      const assembly = await ctx.systemPrompt.assemble()
      prompt = JSON.stringify(assembly)
      if (prompt.includes('Use the jules_* tools')) break
    }
    await new Promise(resolve => setTimeout(resolve, 10))
  }
})

after(async () => {
  await ctx?.fiber.dispose()
})

test('the guidance is assembled at all', () => {
  assert.match(prompt, /Use the jules_\* tools/, 'the jules section never reached the prompt')
})

test('the guidance reads as an instruction, not a description', () => {
  for (const text of [julesGuidance(true), julesGuidance(false)]) {
    assert.match(text, /^Use the jules_\* tools to delegate/, 'the section must open in the imperative voice')
    assert.match(text, /DO NOT POLL/, 'the anti-polling rule is the reason this section exists')
  }
})

test('the watch half names jules_watch only when it is registered', () => {
  // The fixture leaves enableWatch at its default, so the assembled prompt is
  // the variant a watcher-enabled composition produces.
  assert.match(prompt, /jules_watch registers a background watch/)
  assert.match(julesGuidance(true), /jules_watch registers a background watch/)
  // With enableWatch false the tool is absent, and guidance that names it would
  // send the model after something it cannot call.
  assert.doesNotMatch(julesGuidance(false), /jules_watch/, 'guidance named a tool the composition does not register')
  assert.match(julesGuidance(false), /jules_wait holds the turn open until/, 'the no-watch variant must still say how to wait')
})

test('a watch that outlived the harness is named in the guidance', () => {
  assert.match(prompt, /still armed when this harness last stopped/)
  assert.match(prompt, /session-orphan-1234/, 'the orphaned session was not named')
  assert.match(prompt, /Re-arm the ones you still care about with jules_watch/)
})

test('a watch whose budget already passed is not reported', () => {
  assert.doesNotMatch(prompt, /session-expired-5678/, 'an expired watch was reported as an orphan')
})
