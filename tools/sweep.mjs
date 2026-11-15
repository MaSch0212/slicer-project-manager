// Removes stale build output from the cargo target folder with cargo-sweep
// (`cargo install cargo-sweep`): artifacts of toolchains that are no longer installed, and
// artifacts no build has used in the last DAYS days. Cargo itself never cleans `target/`, which
// grows to tens of gigabytes here (one debug build of the workspace, the desktop app and every
// test binary). Usage: `pnpm clean:stale`; `pnpm verify` ends with it too.
//
// Skips quietly (exit 0) when cargo-sweep is missing, and with `--soft` never reports a failure,
// so the housekeeping at the end of `pnpm verify` cannot fail the checks.
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const DAYS = 7
const TIMEOUT_MS = 10 * 60 * 1000

const soft = process.argv.includes('--soft')
const root = join(dirname(fileURLToPath(import.meta.url)), '..')

// One command string (not an args array) so Windows resolves `cargo` the way the other scripts do.
const run = (args, cwd) =>
  spawnSync(['cargo', ...args].join(' '), {
    cwd,
    stdio: 'inherit',
    shell: true,
    timeout: TIMEOUT_MS,
  })

// CI runners start with an empty target folder, so there is nothing stale to sweep there.
if (soft && process.env.CI) process.exit(0)

const probe = spawnSync('cargo sweep --version', { shell: true, stdio: 'ignore', timeout: 30_000 })
if (probe.status !== 0) {
  console.log('cargo-sweep is not installed; skipping the cleanup (cargo install cargo-sweep).')
  process.exit(0)
}

// Everything builds into the workspace target folder; there is no second one.
const target = join(root, 'target')
let failed = false
if (existsSync(target)) {
  for (const args of [
    ['sweep', '--installed'],
    ['sweep', '--time', String(DAYS)],
  ]) {
    if (run(args, root).status !== 0) {
      console.log(`cargo ${args.join(' ')} failed`)
      failed = true
    }
  }
}

if (failed && soft)
  console.log('! cleanup of stale build output failed (housekeeping, not a check)')
process.exit(failed && !soft ? 1 : 0)
