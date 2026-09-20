/**
 * Repository hygiene: no unresolved templating marker in a shipped file.
 *
 * This guards a real class of mistake rather than a hypothetical one. A
 * substitution that is applied to one side of an edit and not the other leaves a
 * literal marker where a real value was meant — in a comment, in a workflow
 * expression, in a config default. Nothing else catches that: comments do not
 * fail a build, and a workflow expression that never expands is just a string as
 * far as YAML is concerned. Both have happened here.
 */
import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { test } from 'node:test'

/** Repository root, resolved from this file rather than the working directory. */
const ROOT = new URL('..', import.meta.url).pathname

/** Directories that are generated, vendored, or not ours to police. */
const SKIP = new Set(['node_modules', 'lib', '.git', '.npm-cache'])

/** Extensions that ship or configure the build. */
const SCANNABLE = /\.(ts|mjs|cjs|js|json|yml|yaml|md)$/

/**
 * The marker to look for. Built rather than written literally so this file does
 * not match itself.
 */
const MARKER = '@'.repeat(2)

/**
 * Every scannable file under a directory, depth-first.
 * @param dir - directory to walk.
 * @returns absolute paths.
 */
function scannable(dir) {
  const found = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (SKIP.has(entry.name)) continue
    const path = join(dir, entry.name)
    if (entry.isDirectory()) found.push(...scannable(path))
    else if (SCANNABLE.test(entry.name)) found.push(path)
  }
  return found
}

test('no shipped file carries an unresolved placeholder marker', () => {
  const offenders = []
  for (const path of scannable(ROOT)) {
    readFileSync(path, 'utf8').split('\n').forEach((line, index) => {
      if (line.includes(MARKER)) {
        offenders.push(`${relative(ROOT, path)}:${index + 1}: ${line.trim().slice(0, 90)}`)
      }
    })
  }
  assert.deepEqual(offenders, [], `unresolved placeholder markers:\n${offenders.join('\n')}`)
})
