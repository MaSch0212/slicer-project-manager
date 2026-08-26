import { _electron as electron, type ElectronApplication } from '@playwright/test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))

/** The bundle the global setup built. Launched by path, exactly as `dev:desktop` does. */
export const MAIN_BUNDLE = resolve(here, '../dist/main.js')

export type LaunchedApp = { app: ElectronApplication; libraryDir: string }

/**
 * Launches the shell against a library folder of its own.
 *
 * The folder is empty and does not yet contain a `.spm`: opening and migrating it is the thing
 * under test (ruling C-3), so handing the app a ready-made library would hide a failure to do
 * any of it.
 */
export async function launchApp(): Promise<LaunchedApp> {
  const libraryDir = mkdtempSync(join(tmpdir(), 'spm-desktop-'))
  const app = await electron.launch({
    args: [MAIN_BUNDLE],
    env: { ...process.env, SPM_LIBRARY_DIR: libraryDir },
  })
  return { app, libraryDir }
}
