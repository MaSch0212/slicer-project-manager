import { readFileSync } from 'node:fs'
import { NODE_IO, writeJsonFile, type JsonStoreIo } from '../json-store.ts'

/**
 * **Persisted third-party browsing history, one entry long, which the user did not ask for.**
 *
 * That is what this file is, said plainly, because every other way of describing it — "the last
 * page", "where you were" — makes it sound like a preference. `browse.json` under
 * `app.getPath('userData')` holds one key: the URL the model browser was last sitting on, so that
 * reopening `/browse` returns to a half-finished search instead of to the registry's start list.
 * Spec 9.14 is open on whether it should exist at all, and this module is written so that dropping
 * it is a deletion rather than an untangling: nothing else reads the file, and `attach` falls back
 * to `MODEL_SITES[0].homeUrl` when it answers null.
 *
 * **Spec 7.3's claim that the entry is "cleared with the browse profile" is inaccurate**, which is
 * why `clearLastPage` exists (E plan decision 8). The browse profile is
 * `…\userData\Partitions\spm-browse`; this file is `…\userData\browse.json`, beside it and not
 * inside it. Deleting the partition directory — which is what "clearing the browse profile" means
 * on disk, and what would drop the cookies and the logins — leaves this file untouched. So the
 * only thing that removes it is `browse.clearLastPage()`, and the renderer has to be able to ask.
 *
 * **A file of its own, not a fourth key in `state.json`** (D decision 4's reasoning, unchanged):
 * one corrupt write should cost the user their last browsed page or their library choice, never
 * both. It shares `json-store.ts`'s writer with `state.json` and `slicers.json`, which is where the
 * pid-named temp file, the `fsyncSync` before the `renameSync` and the cleanup after a failed
 * rename come from. `test/browse-last-page.test.ts` asserts that sequence for *this* file rather
 * than trusting that the import is enough.
 *
 * Nothing here imports `electron`, so all of it runs under plain `node --test` against a real
 * temporary file.
 */

/** Beside `state.json` and `slicers.json` under `app.getPath('userData')`, never inside either. */
export const BROWSE_FILE_NAME = 'browse.json'

/** The one key in it. */
export const LAST_URL_KEY = 'lastUrl'

/**
 * The longest URL this file will store or return.
 *
 * Not a limit any site was measured to approach — it is a bound on what a *file* can make the
 * shell do. `readLastPage` feeds its answer to `loadURL`, so the file is an input, and an input
 * with no length bound is one hand-edit away from a megabyte of URL being read, parsed and handed
 * to Chromium at every attach. 2048 is the conventional ceiling browsers and servers settled on
 * and is far above anything the four sites produce: the longest URL the spike recorded is
 * `https://cults3d.com/zh/3d-m%C3%B3x%C3%ADng/du%C5%8Dxi%C3%A0ng/hyper-hopper`, 66 characters.
 */
export const MAX_REMEMBERED_URL = 2048

/**
 * Whether a URL is one this file will keep.
 *
 * **`http(s)` only, and that is narrower than `browseNavigationPolicy` on purpose.** The policy
 * also allows `blob:`, `data:` and `about:blank`, and not one of the three is a page anybody can
 * be returned to: a `blob:` URL is dead the moment the document that minted it goes, `about:blank`
 * is nothing, and a `data:` URL is a whole document inlined into a string — which is the arm that
 * would put an arbitrary number of bytes of site-authored content into `userData` under a name
 * that reads like a bookmark. So the rule is written here as its own predicate rather than
 * deferred to the policy, and it is applied on the way in *and* on the way out: a `browse.json`
 * that has been hand-edited to name a `file:` URL is refused when it is read, not only when it was
 * written.
 */
export function isRememberableUrl(value: unknown): value is string {
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_REMEMBERED_URL) {
    return false
  }
  const parsed = URL.parse(value)
  return parsed !== null && (parsed.protocol === 'http:' || parsed.protocol === 'https:')
}

/**
 * The remembered page, or null — for a file that is not there, is not JSON, is not an object, or
 * names something `isRememberableUrl` refuses.
 *
 * Every one of those degrades to "start where the registry says", which is a first run and is not
 * an error. `ENOENT` is silent for the reason `readState` gives: it is first run, or a `userData`
 * that has just been wiped, and is the one case worth no words.
 */
export function readLastPage(file: string): string | null {
  let text: string
  try {
    text = readFileSync(file, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      console.warn(`desktop: could not read ${BROWSE_FILE_NAME}`, error)
    }
    return null
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    console.warn(`desktop: ${BROWSE_FILE_NAME} is not valid JSON; forgetting the last page`)
    return null
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null
  const value = (parsed as Record<string, unknown>)[LAST_URL_KEY]
  return isRememberableUrl(value) ? value : null
}

/**
 * Replaces the file with `url`, through `json-store.ts`'s writer.
 *
 * Silent when the URL is not one this file keeps, rather than throwing: the caller is a
 * `did-navigate` handler, and a `blob:` document the user opened is not a failure of anything.
 *
 * **It does not throw on a write failure either.** A `userData` this process cannot write is
 * already going to be reported by `state.json` and `slicers.json`, which carry choices the user
 * made; losing a scroll position is not a reason to fail a navigation that has already happened.
 */
export function writeLastPage(file: string, url: string, io: JsonStoreIo = NODE_IO): void {
  if (!isRememberableUrl(url)) return
  try {
    writeJsonFile(file, { [LAST_URL_KEY]: url }, io)
  } catch (error) {
    console.warn(`desktop: could not remember the last browsed page in ${BROWSE_FILE_NAME}`, error)
  }
}

/**
 * Removes the file. The only thing that forgets the remembered page (decision 8).
 *
 * A delete and not a write of `{}`: the point of the call is that the entry stops existing, and a
 * file that says `{}` is a file that still says the feature ran. `force: true` makes "there was
 * nothing to forget" a success, which is what a user clicking it twice should get.
 */
export function clearLastPage(file: string, io: JsonStoreIo = NODE_IO): void {
  io.rmSync(file, { force: true })
}
