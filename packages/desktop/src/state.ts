import { readFileSync } from 'node:fs'
import { writeJsonFile } from './json-store.ts'

/**
 * What the shell remembers between launches, and the one file it writes it to.
 *
 * Split out of `library.ts` by task 5, because it stopped being about the library folder. Task 4
 * put one key in this file; the shell now has a *mode* as well, and a remote server it may be
 * pointed at instead of a folder — three keys that have to move together or not at all. The
 * writer was already atomic and fsync'd in anticipation of exactly that: a torn write used
 * to cost one forgotten folder, and now it would cost the whole of the shell's configuration.
 * D moved it to `json-store.ts` so `slicers.json` gets the same guarantees out of the same code;
 * `writeState` below is what this file's own keys are written with, and is unchanged in effect.
 *
 * Nothing here imports `electron`, so `test/state.test.ts` drives every branch under plain
 * `node --test` against a real temporary file; the writer's atomicity is asserted in
 * `test/library.test.ts`, beside the folder tests that depend on it.
 */

/** The file under `app.getPath('userData')` that carries all of it. */
export const STATE_FILE_NAME = 'state.json'

/**
 * Which of spec 2.6's two modes the shell is in.
 *
 * `'unset'` is not one of them and is deliberately not in this type: it is the absence of an
 * answer, which the state file spells by having no `mode` key at all. `ActiveMode` in `shell.ts`
 * is the runtime half and does have that third value — the two were both called `ShellState`
 * until review pointed out that one package had the name meaning two unrelated things.
 */
export type ShellMode = 'local' | 'remote'

/** Task 4's key, unchanged, so a `state.json` written by task 4 still reopens its folder. */
export const REMEMBERED_DIR_KEY = 'libraryDir'
export const MODE_KEY = 'mode'
export const REMOTE_URL_KEY = 'remoteUrl'

type ShellState = Record<string, unknown>

export function readState(stateFile: string): ShellState {
  let text: string
  try {
    text = readFileSync(stateFile, 'utf8')
  } catch (error) {
    // `ENOENT` is first run, or a userData directory that has just been wiped, and is the one
    // case worth no words. Everything else — `EACCES`, `EISDIR`, an I/O error — returns the user
    // to the picker with their choice apparently forgotten, and a silent catch would leave that
    // with no explanation in any log.
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      console.warn(`desktop: could not read ${STATE_FILE_NAME}`, error)
    }
    return {}
  }
  try {
    const parsed: unknown = JSON.parse(text)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
      throw new Error('not an object')
    return parsed as ShellState
  } catch (error) {
    // A truncated or hand-edited state file must not stop the app from starting. Say so once:
    // silently treating it as empty would make the choice the user made look forgotten with no
    // explanation anywhere.
    console.warn(`desktop: ignoring an unreadable ${STATE_FILE_NAME}`, error)
    return {}
  }
}

function readString(stateFile: string, key: string): string | null {
  const value = readState(stateFile)[key]
  return typeof value === 'string' && value !== '' ? value : null
}

export function readRememberedDir(stateFile: string): string | null {
  return readString(stateFile, REMEMBERED_DIR_KEY)
}

export function readRememberedRemote(stateFile: string): string | null {
  return readString(stateFile, REMOTE_URL_KEY)
}

/**
 * The remembered mode, or null when there is none — which is first run, and also a `state.json`
 * written by task 4, which knew nothing about modes.
 *
 * **Absent and unrecognised are different answers**, and conflating them was a real bug here: an
 * unknown `mode` used to fall through to the same fallback as a missing one, so a `state.json`
 * that said `"mode": "cloud"` beside a folder silently opened that folder. Found by making the
 * test able to fail — with no folder in the fixture, `null` came back either way and the
 * assertion could not tell the two paths apart.
 *
 * - **Absent** is a task-4 file: a `libraryDir` and no `mode`, written by a user who chose a
 *   folder before this key existed. It reads as `local`, so upgrading does not throw anyone back
 *   to a question they already answered.
 * - **Unrecognised** — hand-edited, or written by a newer version — is `null`, which asks. The
 *   file was written by something whose intent this code does not know, and the keys beside the
 *   one it cannot read are no more trustworthy than the one it cannot.
 */
export function readRememberedMode(stateFile: string): ShellMode | null {
  const value = readState(stateFile)[MODE_KEY]
  if (value === 'local' || value === 'remote') return value
  if (value !== undefined) {
    console.warn(`desktop: ignoring an unknown ${MODE_KEY} in state.json`)
    return null
  }
  return readRememberedDir(stateFile) === null ? null : 'local'
}

/**
 * Writes the shell's choice down: the mode, and the folder or origin it names.
 *
 * One function for both modes, and the *whole* choice in one write, because that is what makes
 * the two keys impossible to disagree. Two calls — one for the mode, one for its target — would
 * have a window in which `mode: 'remote'` was on disk beside the previous mode's `libraryDir`
 * and no `remoteUrl`, which the next launch would read as a remote mode with nowhere to connect.
 *
 * The key of the mode that is *not* chosen is left alone rather than deleted: switching to a
 * server and back should not make the shell forget which folder it was. Only `mode` decides
 * which of the two is read at startup.
 */
export function rememberChoice(stateFile: string, mode: ShellMode, target: string): void {
  const state = readState(stateFile)
  state[MODE_KEY] = mode
  state[mode === 'local' ? REMEMBERED_DIR_KEY : REMOTE_URL_KEY] = target
  writeState(stateFile, state)
}

/** Task 4's spelling, kept because `LibraryHost` is the only caller and it only ever means local. */
export function rememberDir(stateFile: string, dir: string): void {
  rememberChoice(stateFile, 'local', dir)
}

/**
 * Replaces the state file, atomically — `json-store.ts`'s write-temp/fsync/rename.
 *
 * A one-line function and deliberately still a function: it is the shape every caller in this
 * file uses, it names `state.json` as the thing being replaced, and `test/library.test.ts`'s
 * atomicity assertions reach the writer through it. The reasoning for each step of the sequence
 * — including what the fsync buys and the directory entry that is still not forced — lives on
 * `writeJsonFile` and is not duplicated here.
 */
export function writeState(stateFile: string, state: ShellState): void {
  writeJsonFile(stateFile, state)
}
