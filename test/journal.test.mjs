/**
 * The restart note, and the durable journal behind it.
 *
 * The note is pure; the journal is exercised against the real storage stack,
 * because the failure that mattered was not in the text — it was the domain
 * never opening, which produced no records and no error.
 */
import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import { readdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import { pathToFileURL } from 'node:url'
import { openWatchJournal, orphanNote } from '../lib/journal.js'

/** The backend root, relative to this test file rather than to the cwd. */
const STORAGE_ROOT = new URL('../.storage/', import.meta.url).pathname

/**
 * Find one file anywhere under a directory.
 * @param dir - directory to walk.
 * @param name - basename to look for.
 * @returns the full path, or undefined.
 */
function findFile(dir, name) {
  let entries
  try { entries = readdirSync(dir, { withFileTypes: true }) } catch { return undefined }
  for (const entry of entries) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) {
      const nested = findFile(path, name)
      if (nested !== undefined) return nested
    } else if (entry.name === name) return path
  }
  return undefined
}

/** One record, as the journal stores it. */
const record = (session, expiresAt = 9_999_999) => ({ session, startedAt: 1_000, expiresAt })

test('nothing to report stays silent', () => {
  assert.equal(orphanNote([]), '')
})

test('one orphan names the session and reads naturally', () => {
  const note = orphanNote([record('123')])
  assert.match(note, /background watches do not survive a harness restart/)
  assert.match(note, /one watch was still armed when this harness last stopped: 123/)
  assert.match(note, /kept running in the cloud/)
  assert.match(note, /Re-arm the ones you still care about with jules_watch/)
  assert.match(note, /needs only a jules_status/)
})

test('several orphans are counted and all named', () => {
  const note = orphanNote([record('a'), record('b'), record('c')])
  assert.match(note, /3 watches were still armed/)
  assert.match(note, /a, b, c/)
})

test('the note is appended to the guidance, never replaces it', () => {
  assert.ok(orphanNote([record('1')]).startsWith('\n\n'))
})

let ctx
let journal

before(async () => {
  // Start from an empty backend. Records are durable, so anything an earlier
  // run or a stray probe left behind would otherwise be read back as an orphan
  // and fail assertions that are about this run's records.
  rmSync(STORAGE_ROOT, { recursive: true, force: true })
  ctx = new Context()
  ctx.baseUrl = pathToFileURL(new URL('./journal/', import.meta.url).pathname).href + '/'
  await ctx.plugin(Loader)
  await ctx.loader.create({
    name: '@deepseek-ai/cordis-plugin-include',
    config: { path: './cordis.yml' },
  })
  for (let attempt = 0; attempt < 300 && ctx.get('storageDomain') === undefined; attempt += 1) {
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  assert.notEqual(ctx.get('storageDomain'), undefined, 'the storage domain form never mounted')
  journal = await openWatchJournal(ctx)
  assert.notEqual(journal, undefined, 'the journal did not open over mounted storage')
})

after(async () => {
  await ctx?.fiber.dispose()
})

test('the journal opens over real storage and round-trips a watch', async () => {
  await journal.arm(record('survivor', Date.now() + 60_000))
  assert.deepEqual(journal.pending().map(entry => entry.session), ['survivor'])
  await journal.release('survivor')
  assert.deepEqual(journal.pending(), [])
})

test('an armed watch is on disk, not just in memory', async () => {
  // The per-record json layout writes <root>/<domain>/<table>/<key>.json. A
  // journal that only ever existed in memory would round-trip identically in
  // the test above, so this asserts the document itself.
  assert.equal(findFile(STORAGE_ROOT, 'on-disk.json'), undefined, 'precondition: nothing stored yet')
  await journal.arm(record('on-disk', Date.now() + 60_000))
  assert.notEqual(findFile(STORAGE_ROOT, 'on-disk.json'), undefined, 'arming left no durable document')
  await journal.release('on-disk')
  assert.equal(findFile(STORAGE_ROOT, 'on-disk.json'), undefined, 'releasing left the document behind')
})

test('armed watches are listed oldest first, so the note reads chronologically', async () => {
  await journal.arm({ session: 'second', startedAt: 2_000, expiresAt: Date.now() + 60_000 })
  await journal.arm({ session: 'first', startedAt: 1_000, expiresAt: Date.now() + 60_000 })
  assert.deepEqual(journal.pending().map(entry => entry.session), ['first', 'second'])
  await journal.release('first')
  await journal.release('second')
})

test('a watch whose budget has passed is no longer reported', async () => {
  await journal.arm(record('expired', Date.now() - 1))
  assert.deepEqual(journal.pending(), [])
})

test('re-arming a session replaces its record rather than duplicating it', async () => {
  await journal.arm(record('again', Date.now() + 60_000))
  await journal.arm(record('again', Date.now() + 120_000))
  assert.deepEqual(journal.pending().map(entry => entry.session), ['again'])
  await journal.release('again')
})
