import assert from 'node:assert/strict'
import { test } from 'node:test'
import { browseNavigationPolicy, navigationPolicy } from '../src/urls.ts'

/**
 * What the model browser's view may navigate to.
 *
 * Nothing here imports `electron`, which is the point: the policy is a decision that wants
 * exhaustive cheap coverage rather than one drive through a GUI. The GUI half — that all four
 * hooks consult it, on a view with its own partition and no preload — is a later task's
 * `.spec.ts`, and no amount of this file substitutes for it.
 */

/* -------------------------------------------------------------------------------------------
 * browseNavigationPolicy
 * ---------------------------------------------------------------------------------------- */

/**
 * One table, both answers.
 *
 * Deliberately not two lists. A suite that only enumerates refusals passes for a policy that
 * refuses everything — and this policy's whole job is that it *allows* `http(s)`, `blob:`, `data:`
 * and `about:blank`. Asserting the allows and the blocks through the same fixture and the same
 * assertion is what makes "return 'block'" unconditionally go red.
 */
const POLICY_TABLE: ReadonlyArray<readonly [string, 'allow' | 'block']> = [
  // http(s) — this is a browser. The inversion of the renderer's policy.
  ['https://www.thingiverse.com/thing:1', 'allow'],
  ['http://example.com/', 'allow'],
  ['https://makerworld.com/en/models/2093108-dji-neo-2-the-box?from=recommend', 'allow'],
  ['HTTPS://EXAMPLE.COM/', 'allow'],

  // blob: and data:. The one download this project ever completed came down a blob: URL —
  // Thingiverse's, 21 060 699 bytes of ZIP, `getURL()` a blob: and the whole chain that one URL.
  ['blob:https://www.thingiverse.com/ae5e9664-0d63-4a6f-9c0a-2b0b4b8b0e21', 'allow'],
  ['blob:https://www.printables.com/1234', 'allow'],
  ['data:text/html,x', 'allow'],
  ['data:application/octet-stream;base64,AAAA', 'allow'],

  // about:blank — the deferred-popup idiom's target. Blocking it blocks the open, not the
  // destination. Only `blank`: the rest of `about:` is browser internals.
  ['about:blank', 'allow'],
  ['about:srcdoc', 'block'],
  ['about:config', 'block'],

  // spm: — belt-and-braces behind the partition, which already answers ERR_FAILED for it.
  ['spm://app/', 'block'],
  ['spm://app/_spm/files/1/raw', 'block'],
  ['spm://evil/', 'block'],

  // file: — the one arm doing work Chromium does not already do. A file dropped onto a
  // webContents is a file: navigation.
  ['file:///C:/Users/x/secret.stl', 'block'],
  ['file:///etc/passwd', 'block'],

  // Everything else.
  ['javascript:alert(1)', 'block'],
  ['bambustudio://open?model=1', 'block'],
  ['chrome://settings', 'block'],
  ['devtools://devtools/bundled/inspector.html', 'block'],
  ['ws://example.com/', 'block'],
  ['mailto:someone@example.com', 'block'],
  ['not a url', 'block'],
  ['', 'block'],
  ['//example.com/', 'block'],
]

test('browseNavigationPolicy answers the measured table, allows and blocks alike', () => {
  for (const [url, expected] of POLICY_TABLE) {
    assert.equal(browseNavigationPolicy(url), expected, url)
  }
})

test('the browse policy and the renderer policy are different functions, and invert on http(s)', () => {
  /*
   * The failure this pins is a later merge of the two. `navigationPolicy` answers `external` for
   * `http(s)`, which hands the URL to `shell.openExternal` — a browse view wired to that would
   * fire the user's system browser for every link and never move. A test that confused the two
   * would pass while making the feature useless.
   */
  assert.equal(navigationPolicy('https://example.com/'), 'external')
  assert.equal(browseNavigationPolicy('https://example.com/'), 'allow')

  // And they disagree the other way too: the renderer's own origin is allowed there, refused here.
  assert.equal(navigationPolicy('spm://app/projects'), 'allow')
  assert.equal(browseNavigationPolicy('spm://app/projects'), 'block')

  // `about:blank` and `blob:` are the arms the renderer's policy refuses and this one needs.
  assert.equal(navigationPolicy('about:blank'), 'block')
  assert.equal(navigationPolicy('blob:spm://app/1234'), 'block')
})
