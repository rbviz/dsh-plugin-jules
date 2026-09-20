#!/usr/bin/env node
/**
 * Compile the plugin with the TypeScript that the running dsh installation
 * already ships, so this package needs no toolchain of its own.
 *
 * Resolution order: `$DSH_TSC`, then a `typescript` found through this
 * package's own `node_modules` (populated by `link-dsh-deps`), then the
 * harness home. Run `npm run link-dsh-deps` first if this fails.
 */

import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

function candidateTsc() {
  if (process.env.DSH_TSC !== undefined && existsSync(process.env.DSH_TSC)) return process.env.DSH_TSC
  const home = process.env.DSH_HOME ?? join(process.env.HOME ?? '', '.dsh')
  return [
    join(PACKAGE_ROOT, 'node_modules', 'typescript', 'bin', 'tsc'),
    join(home, 'profiles', 'node_modules', 'typescript', 'bin', 'tsc'),
  ].find(existsSync)
}

const tsc = candidateTsc()
if (tsc === undefined) {
  process.stderr.write('build: no typescript found; run "npm run link-dsh-deps" or set DSH_TSC\n')
  process.exit(1)
}

const result = spawnSync(process.execPath, [tsc, '-p', join(PACKAGE_ROOT, 'tsconfig.json'), ...process.argv.slice(2)], {
  stdio: 'inherit',
  cwd: PACKAGE_ROOT,
})
process.exit(result.status ?? 1)
