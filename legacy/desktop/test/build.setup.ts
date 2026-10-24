import { spawnSync } from 'node:child_process'
import { statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')

/**
 * Everything the suite launches, and where it must appear. `dist/migrations` is in here because
 * a main bundle without it opens a window and then throws on the first `openLibrary`, which
 * looks nothing like a build problem.
 */
const OUTPUTS = [
  'packages/desktop/dist/main.js',
  'packages/desktop/dist/preload.js',
  'packages/desktop/dist/migrations/001_init.sql',
  'packages/web/dist/electron/browser/index.html',
  'packages/web/dist/electron/browser/main.js',
]

/**
 * The build is a dependency of these tests, not an assumption they make.
 *
 * Running it here rather than trusting a previous one is the whole point: an Electron test that
 * silently re-checks yesterday's bundle is the exact failure the web job's bundle guard had to
 * be taught about. Freshness is then asserted by mtime, so a build that exits 0 without writing
 * anything fails the run instead of handing the suite a stale dist/.
 */
export default function globalSetup(): void {
  // Filesystem timestamps are coarser than this clock on some filesystems, so a file written
  // moments from now can carry an mtime a hair earlier than this reading. Two seconds of slack
  // is far less than the age of any output a rebuild would have skipped.
  const freshAfter = Date.now() - 2_000

  const result = spawnSync(
    process.platform === 'win32' ? 'deno.exe' : 'deno',
    ['task', 'build:desktop'],
    {
      cwd: repoRoot,
      stdio: 'inherit',
    },
  )
  if (result.error) throw result.error
  if (result.status !== 0) {
    throw new Error(`deno task build:desktop exited ${result.status}`)
  }

  for (const relative of OUTPUTS) {
    const file = join(repoRoot, relative)
    let size: number
    let mtimeMs: number
    try {
      ;({ size, mtimeMs } = statSync(file))
    } catch {
      throw new Error(`build:desktop reported success but did not write ${relative}`)
    }
    if (size === 0) throw new Error(`build:desktop wrote an empty ${relative}`)
    if (mtimeMs < freshAfter) {
      throw new Error(
        `${relative} predates this run (mtime ${new Date(mtimeMs).toISOString()}); ` +
          `build:desktop did not rebuild it, so the suite would be testing a stale bundle`,
      )
    }
  }
}
