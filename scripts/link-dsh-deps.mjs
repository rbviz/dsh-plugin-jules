#!/usr/bin/env node
/**
 * Make the in-box `@deepseek-ai/*` packages importable from this plugin's own
 * directory.
 *
 * Why this exists: a profile installs an out-of-tree bundle with pnpm's
 * `link:` protocol, which puts a symlink in the profile's `node_modules` but
 * creates no `node_modules` beside the real package. Node resolves a symlinked
 * package to its realpath, so this plugin's own `import '@deepseek-ai/dsh-tools'`
 * would otherwise fail with ERR_MODULE_NOT_FOUND even though dsh itself loaded
 * the file.
 *
 * The fix is to point each declared peer dependency at the copy the running
 * installation already uses, so both sides share one module instance. dsh
 * maintains exactly such a directory at `$DSH_HOME/profiles/node_modules`
 * (its "module fallback"), whose entries are themselves links into the
 * installation.
 *
 * Usage:
 *   node scripts/link-dsh-deps.mjs [--home <dsh home>] [--check]
 *
 * `--check` reports what is missing without writing anything.
 */

import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync, symlinkSync, unlinkSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const MANIFEST = JSON.parse(readFileSync(join(PACKAGE_ROOT, 'package.json'), 'utf8'))

/**
 * Every name to link: runtime peers plus the loader packages the composition
 * test boots. Types alone still need resolution, so this is not filtered.
 */
const REQUIRED = [
  ...Object.keys(MANIFEST.peerDependencies ?? {}),
  ...Object.keys(MANIFEST.devDependencies ?? {}),
]

function parseArgs(argv) {
  const options = { home: process.env.DSH_HOME, check: false, optional: false }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--check') options.check = true
    else if (arg === '--optional') options.optional = true
    else if (arg === '--home') options.home = argv[++index]
    else if (arg.startsWith('--home=')) options.home = arg.slice('--home='.length)
    else {
      process.stderr.write(`link-dsh-deps: unknown argument ${arg}\n`)
      process.exit(2)
    }
  }
  if (options.home === undefined || options.home.length === 0) options.home = join(homedir(), '.dsh')
  return { home: resolve(options.home), check: options.check }
}

function homedir() {
  return process.env.HOME ?? process.env.USERPROFILE ?? ''
}

/** `node_modules` directories that may hold the in-box packages, best candidate first. */
function candidateRoots(home) {
  const roots = [join(home, 'profiles', 'node_modules')]
  const profiles = join(home, 'profiles')
  if (existsSync(profiles)) {
    for (const entry of readdirSync(profiles, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name === 'node_modules') continue
      roots.push(join(profiles, entry.name, 'node_modules'))
    }
  }
  return roots
}

/** First existing directory providing `packageName`, or undefined. */
function locate(packageName, roots) {
  for (const root of roots) {
    const candidate = join(root, packageName)
    if (existsSync(join(candidate, 'package.json'))) return candidate
  }
  return undefined
}

const { home, check, optional } = parseArgs(process.argv.slice(2))
const roots = candidateRoots(home)
const target = join(PACKAGE_ROOT, 'node_modules')
const missing = []

for (const packageName of REQUIRED) {
  const source = locate(packageName, roots)
  if (source === undefined) {
    missing.push(packageName)
    continue
  }
  const link = join(target, packageName)
  const current = existsSync(link)
    ? (() => { try { return readlinkSync(link) } catch { return undefined } })()
    : undefined
  if (current === resolve(source)) continue
  if (check) {
    process.stdout.write(`would link ${packageName} -> ${source}\n`)
    continue
  }
  mkdirSync(dirname(link), { recursive: true })
  try { if (lstatSync(link)) unlinkSync(link) } catch { /* absent */ }
  symlinkSync(resolve(source), link, 'junction')
  process.stdout.write(`linked ${packageName} -> ${source}\n`)
}

if (missing.length > 0) {
  const detail = `link-dsh-deps: could not find ${missing.join(', ')}\n`
    + `  searched:\n${roots.map(root => `    ${root}\n`).join('')}`
    + '  pass --home <dsh home> or set DSH_HOME to the harness home that installed them.\n'
  // --optional is for a machine with no harness installed: CI, or a consumer
  // building from a tarball. The packages then come from node_modules like any
  // other dependency, so the absence of a harness home is not a failure.
  if (optional) {
    process.stderr.write(detail + '  (--optional: continuing; node_modules will be used as-is)\n')
    process.exit(0)
  }
  process.stderr.write(detail)
  process.exit(1)
}

if (check) process.stdout.write('link-dsh-deps: all peer dependencies resolve\n')
