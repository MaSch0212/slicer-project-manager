# Slicer Project Manager — Subsystem E: the model browser

- **Date:** 2026-08-28
- **Status:** Approved (design); implementation plan pending
- **Parent:** [`2026-08-22-slicer-project-manager-design.md`](2026-08-22-slicer-project-manager-design.md)
  — binding. Where this document and the parent disagree, the parent wins and this one is wrong —
  except at 1.3, where the parent is corrected in place against a measurement, the way D corrected
  it before.
- **Measurements:** `.superpowers/spikes/2026-08-28-model-browser-facts.md`, both probe runs, on the
  developer's Windows 11 machine against Electron 44.0.0 and the four live model sites. Section
  references of the form "(§5)" are to that document.
- **Packages touched:** `packages/desktop` (all of the browsing), `packages/web` (one route, one
  page, one capability-gated link), `packages/contract` (interface + DTOs). **`packages/core` is not
  touched at all** — see 7.5.

## 1. Purpose and scope

E is the last thing the desktop shell adds that a browser tab cannot do. The web build cannot offer
it, and that is now a measured fact rather than an assumption: the four model sites refuse to be
framed, and a browser has nothing but a frame to offer them.

### 1.1 What E adds

- An **embedded browser** — a `WebContentsView` on its own persistent partition, with its own
  navigation policy, its own window-open handler, its own permission handler and its own download
  stream. Containing it is the centre of this document.
- **Download interception**: `will-download` on the browse partition, `setSavePath()` into a staging
  directory the main process owns, and a per-download record the user acts on.
- **Landing a download into a project** through `files.upload`, with the bytes never crossing IPC.
- **Matching a site URL to a project** through `projects.website`, and an honest answer for the case
  where nothing matches — which is every first-time download.
- `/browse`, and the capability flag that lights it up.

### 1.2 Out of scope

- **Automating a login, or storing a third-party credential.** The app stores none and automates
  none (E-10, 5.7). A persistent partition means the user signs in themselves, once.
- **Anything that would require defeating bot protection.** All four sites sit behind Cloudflare
  (§10). Two of them serve a non-interactive managed challenge that clears itself in about six
  seconds. The design **tolerates an interstitial and never attempts to bypass one** — no UA
  spoofing (measured not to matter, §10), no challenge solving, no CAPTCHA handling. If a site ever
  escalates to an interactive challenge, the user solves it in the view, because a human is driving.
- **Anything on the web build.** Measured impossible (§7): the sites refuse framing and a browser
  cannot make a `WebContentsView`.
- **Scraping, bulk download, metadata harvesting, or a site-specific API integration.** The app
  drives no clicks and reads no page. §10's `net.request` row says even a "fetch the page in the
  main process to read its title" design would meet the same challenge page a browser does.
- **macOS and Linux.** Every measurement behind this document was taken on Windows 11 (§11.8). The
  download path, the storage paths, the partition directory layout and the challenge behaviour are
  all plausibly platform-sensitive. E ships what was measured and says so.

### 1.3 What this document corrects in the parent

Parent §9 says the four sites "all refuse third-party framing — **so** an embedded browser in the
desktop app is the only viable route". The conclusion holds. The reason given for it is wrong, and
the wrong reason would mislead the next person who reads it.

**Measured both ways in the same session, minutes apart** (§7): all four URLs were refused as an
`<iframe>` inside a plain HTTP page carrying no CSP of its own — `X-Frame-Options: SAMEORIGIN` for
Thingiverse, Printables and Cults3D, CSP `frame-ancestors 'none'` for MakerWorld — and **all four of
those same URLs loaded as top-level `WebContentsView`s**, with real titles and real DOM.

`X-Frame-Options` and `frame-ancestors` govern embedding **as a frame**. A `WebContentsView` is a
separate top-level frame tree, not a subframe, so neither header applies to it. So the sentence is
"**a `WebContentsView` is not a frame**", not "the sites allow it". The practical conclusion — the
web build cannot offer this, an embedded native view can — is unchanged, and parent §9 is amended in
place to say so.

One consequence worth keeping: the refusal Thingiverse gave was **Cloudflare's 403 block page**
carrying `x-frame-options: SAMEORIGIN`, while the top-level response for the same URL carried
neither XFO nor CSP at all. A design that read "Thingiverse sets XFO" off that would be reading a
property of the block page, not of the site.

## 2. What was measured

Every row was run and observed on one Windows 11 machine against the repo's own
`node_modules/electron` — Electron 44.0.0, Chromium 152.0.7977.54, Node 24.18.1, read from
`process.versions` inside the running app. Nothing here is from vendor documentation.
**A design decision that contradicts a row is wrong.**

| #   | Question                                                           | Measured                                                                                                                                                                                                                | Spike   |
| --- | ------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------- |
| 1   | Which embedding primitive is current?                              | **`WebContentsView`.** `BrowserView` carries `@deprecated` on every member of the installed `electron.d.ts` (still constructible); `<webview>` defaults off and its own type entry warns that its preload gets Node.    | §1      |
| 2   | Does a bare `WebContentsView` reach `window.spm`?                  | **No.** Read out of the embedded document at a third-party origin: `typeof window.spm === "undefined"`, `Object.keys` empty, no `require`, no `process`.                                                                | §2      |
| 3   | Can it be handed the bridge by mistake?                            | **Yes, in one line.** Given `webPreferences.preload`, an otherwise sandboxed, context-isolated view **at a third-party origin** got `typeof window.spm === 'object'` and `invoke('projects.list')` reached `ipcMain`.   | §2      |
| 4   | Is there a second, invisible way to hand it over?                  | **Yes.** `session.registerPreloadScript({type:'frame'})` on `defaultSession` reached a `WebContentsView` created **afterwards** on that session; the same probe on another partition answered `"undefined"`.            | §2      |
| 5   | Does `getLastWebPreferences()` report `preload`?                   | **No.** 15 keys, `preload` not among them. Byte-identical for the bridge-holding host window and a bridge-less view. The instrument `shell.spec.ts` uses cannot answer this question.                                   | §2, §14 |
| 6   | Does a bare view get its own session?                              | **No — `defaultSession`**, the same one the app renderer is on. `wcv.webContents.session === session.defaultSession` → `true`.                                                                                          | §3      |
| 7   | What does a `persist:` partition buy?                              | Separate cookie jar, separate `localStorage` (verified both directions), separate storage directory, its own permission handler, its own `will-download` stream.                                                        | §3, §6  |
| 8   | Is `spm://` reachable from the browse partition?                   | **No.** `protocol.handle` registers on `defaultSession` only: `isProtocolHandled('spm')` is `true` there and `false` on `persist:spm-browse`. A top-level navigation rejects `ERR_FAILED (-2)`.                         | §5      |
| 9   | …and from a view on the **default** session?                       | **A top-level navigation succeeds** — `loadURL('spm://app/')` returned `loaded`. `fetch()` fails from both. So the partition is what removes the privileged origin, and the navigation is the discriminator.            | §5      |
| 10  | Could the partition be given `spm://` anyway?                      | **Yes** — `browseSession.protocol.handle('spm', …)` succeeds. "No `spm://` in the browse partition" is a property to keep on purpose, not one the platform enforces.                                                    | §5      |
| 11  | Does the window-level navigation policy cover an embedded view?    | **No.** With `applyNavigationPolicy(window)` attached exactly as `app.ts` does it, `loadURL` and an in-page `location.href` in the view both completed with an **empty hook log**.                                      | §4      |
| 12  | …attached to the view's own `webContents`?                         | **Yes.** The same function logged `{hook:'will-navigate', policy:'external'}` and the view stayed where it was.                                                                                                         | §4      |
| 13  | What does an unhooked `window.open` from embedded content produce? | A real top-level `BrowserWindow` at the requested URL, **on the opener's session** (partition preserved), security flags inherited, **no bridge**. With a handler, zero windows.                                        | §4, §14 |
| 14  | Does a popup ever inherit the opener's preload?                    | **Never.** 20 popups across 21 variants, all `typeof window.spm === 'undefined'`; `did-create-window` hands over merged options carrying no `preload` key.                                                              | §14     |
| 15  | What does a popup have instead?                                    | **`window.opener.spm`** — the opener's live bridge — **when same-origin with the opener**, and an `invoke` through it returned the real `ipcMain` answer. Cross-origin: `SecurityError`. `noopener` severs it.          | §14     |
| 16  | Does the embedded view inherit the app's CSP?                      | **No.** Discriminator: a `fetch` refused from the host document at `spm://app` and identical at `ok 200` from the embedded page. CSP is a per-response header; embedded content runs under whatever the site sends.     | §5      |
| 17  | Can embedded content iframe `spm://app/`?                          | **No** — `ERR_BLOCKED_BY_RESPONSE`, the app's own `frame-ancestors 'none'` doing its job.                                                                                                                               | §5      |
| 18  | Does `will-download` fire for a download inside embedded content?  | **Yes**, carrying the embedded `webContents`.                                                                                                                                                                           | §6      |
| 19  | **On which session?**                                              | **The view's own, and only that one.** Identical listeners on `defaultSession` and on the partition; only the partition's fired.                                                                                        | §6      |
| 20  | Does `setSavePath()` redirect it, on a real site at real size?     | **Yes.** Thingiverse "Download all files" → `completed`, **21 060 699 bytes** at the chosen path, first four bytes `504b0304`, and `fs.existsSync(<user Downloads>/<filename>)` **false**.                              | §6, §8  |
| 21  | Can a download be refused?                                         | **Yes** — `preventDefault()` wrote nothing anywhere, and the item was destroyed by the next tick (`getState()` threw). **All-or-nothing, decided synchronously in the handler.**                                        | §6      |
| 22  | Is the download URL always re-requestable?                         | **No.** Thingiverse's was a `blob:` — `getURL()` = `blob:https://www.thingiverse.com/ae5e…`, the whole chain. A "capture the URL now, fetch it later" design fails there.                                               | §8      |
| 23  | Where does the filename come from?                                 | **`getFilename()`.** `getContentDisposition()` was an **empty string** on the real download; `getETag()` and `getLastModifiedTime()` were empty on every download measured. `getFilename()` was populated and sane.     | §6, §8  |
| 24  | Is progress observable?                                            | **Yes.** `updated` fired 5 times on both a 300 KB local file and the 21 MB real one, `getReceivedBytes()`/`getPercentComplete()` advancing 0 → 100; `done` once with `completed`.                                       | §6      |
| 25  | Is a scripted download distinguishable from a user click?          | **Partly.** `hasUserGesture()` is `false` for `webContents.downloadURL()` and `true` for a real click — but also `false` for a click driven by `executeJavaScript`.                                                     | §6, §12 |
| 26  | Do the four sites load as top-level `WebContentsView`s?            | **Yes, all four**, with real titles — the same four URLs that were refused as iframes. See 1.3.                                                                                                                         | §7      |
| 27  | Is there an interstitial, and does it clear?                       | **Printables and Cults3D answer 403 with Cloudflare's "Just a moment…"**, clearing to the real page in **5 573 ms** and **6 374 ms** under a 2 s poll. **No CAPTCHA was presented and none was solved.**                | §10     |
| 28  | Does the user agent matter?                                        | **Not shown to.** A spoofed plain-Chrome UA still saw the interstitial; the default Electron UA cleared it. The difference between the runs was the polling wait. **Do not claim the UA must be spoofed.**              | §10     |
| 29  | What can a logged-out visitor download?                            | Thingiverse: **yes**, anonymously, a 21 MB zip of everything. Printables: button present, no login wall, **not clicked**. MakerWorld: **no** — its only affordance is `Open in Bambu Studio`. Cults3D: **unresolved**.  | §8      |
| 30  | Do consent overlays interfere?                                     | **Yes.** Thingiverse names 1067 partners; Cults3D's overlay is the likely reason a scripted click on `DOWNLOAD FREE` did nothing. A human driving the view deals with these; the app does not.                          | §10     |
| 31  | What is stable in a model URL?                                     | Per site: `thing:<id>`, `/model/<id>-<slug>`, `/models/<id>-<slug>`, and for Cults3D **the last path segment only** — no numeric id and the whole path translated across 8 locales.                                     | §9      |
| 32  | Is locale a path or a query?                                       | **Both, depending on the site.** Printables: `?lang=de` with the canonical un-prefixed. MakerWorld: `/de/models/…`, 12 `hreflang` alternates. Cults3D: `/de/modell-3d/verschiedene/…` — the segments themselves change. | §9      |

### 2.1 What the spike could not settle

Named here because parts of this design lean on them, and a reader should know which parts rest on
one machine and one afternoon.

- **Whether a Printables or Cults3D download actually intercepts** (§11.1, §11.2). One download
  completed end to end, on Thingiverse. Printables' button was found and not clicked; Cults3D's
  scripted click was eaten by its consent overlay. The interception mechanism is measured; that it
  fires on those two sites specifically is not. _To settle:_ one `sites4`-shaped run each.
- **Everything behind a login** (§11.3). No account was created anywhere, by instruction. MakerWorld
  in particular has **no measured download path at all** — its logged-out affordance is a custom
  scheme hand-off to Bambu Studio, and whether that even reaches `will-download`,
  `setWindowOpenHandler` or a protocol hook was not measured (§11.5). 5.7 says what E does about it,
  which is to leave it to the user and not design a flow nobody ran.
- **Whether Cloudflare escalates under sustained use** (§11.6). Four runs over ~40 minutes never
  produced an interactive challenge. That is not evidence about the tenth hour.
- **`WebContentsView` bounds, resize and focus in the real Angular shell** (§11.9). Not a security
  question, and the one part of `WebContentsView` that is famously fiddly. 4.2 designs for it; the
  design is reasoning, not measurement.
- **macOS and Linux** (§11.8), as 1.2 says.

## 3. The security boundary

This is the centre of the document. E adds arbitrary third-party content to a process that holds a
live IPC bridge to the user's filesystem and database. The measurements say the hazard does **not**
automatically follow the content there — but only because of defaults that nothing currently
asserts, and each of them is one line from being reversed.

### 3.1 The browse view is a `WebContentsView`, and never the main window

`WebContentsView` is the only non-deprecated primitive left (row 1), and it is the only one every
measurement below was taken on.

The main window's `webContents` carries the preload permanently — a preload is attached to a
`webContents` and follows it wherever it navigates, which is subsystem C's core measurement and is
re-verified twice here against the real bundled preload (§4 last row, §14.1). So **the main window
must never be navigated to a model site**. `navigationPolicy` already sends `http(s)` to
`shell.openExternal`, and E must not weaken that arm to make room for `/browse`: `/browse` is a
`spm://app` route that hosts a _native sibling view_, not a page the window navigates to.

### 3.2 The browse view never gets a preload

**This is the single hardest line in the subsystem.**

Measured both directions (row 2, row 3). A `WebContentsView` created with no options, loaded at a
third-party origin, reports `typeof window.spm === "undefined"` with `Object.keys` empty. The same
view constructed with `webPreferences.preload` pointing at the app's own preload — still
`sandbox: true`, still `contextIsolation: true`, still `nodeIntegration: false` — reported
`typeof window.spm === 'object'` with all three keys **at a third-party origin**, and
`window.spm.invoke('projects.list', [])` returned a real `ipcMain` answer. A remote page called the
app's dispatch table.

Nothing about the sandbox, the context isolation or the partition prevents this. The three flags
`shell.spec.ts` asserts are all still correct in the compromised configuration. **The only thing
standing between a model site and `ipcMain` is the absence of one property.**

Two consequences the implementation plan must carry:

- The browse view is constructed in exactly one place, and that constructor call takes
  `webPreferences` with **`partition` and nothing else that the trust model depends on**. A helper
  that spreads the main window's `webPreferences` into it is the defect.
- The assertion that catches a regression is **not** `getLastWebPreferences()` (row 5, 8.2). It is
  `typeof window.spm` read out of the embedded document.

### 3.3 The session-scoped preload is forbidden, and it is the one that is invisible

`session.registerPreloadScript({ type: 'frame', filePath })` on `defaultSession` **reached a
`WebContentsView` created afterwards on that session** (row 4). The same probe in a view on another
partition answered `"undefined"`. A preload registered on a _session_ is inherited by every
webContents on that session, an embedded browser included.

This is worse than 3.2 for three reasons, and the spec states them where a future author cannot miss
them:

1. **It is invisible at the call site.** `app.ts` would say nothing about the browse view at all.
   The line that hands the bridge over is somewhere else entirely, in start-up code about the
   renderer.
2. **`ses.setPreloads` is deprecated in favour of `registerPreloadScript` in this Electron's own
   type definitions.** So a plausible future tidy-up — "move the preload off `webPreferences`, the
   session API is the modern one" — is a direct route into this defect, arrived at by someone doing
   what the deprecation notice told them to.
3. **The existing security instrument cannot see it.** `getLastWebPreferences()` does not report
   `preload` (row 5). `shell.spec.ts:423` reads that object to assert the three trust-model flags,
   which is correct for those three and **cannot be extended to this**.

**So: `packages/desktop` may not call `registerPreloadScript` or `setPreloads` at all.** The app has
exactly one preload and it is delivered by `webPreferences.preload` in `createMainWindow`.

**What can be tested, since the obvious instrument cannot** — 8.2 gives both, and neither is a
`webPreferences` assertion:

- **The partition makes the browse view structurally immune to it.** A view on `persist:spm-browse`
  is not on `defaultSession`, so a `defaultSession`-scoped preload does not reach it (row 4's
  negative control). Asserting that the browse view's session is not the default session is
  therefore also the guard for this defect, and it is a runtime assertion that can fail.
- **A source assertion.** The two identifiers must not occur in `packages/desktop/src`. CI already
  greps built bundles for a class name to enforce parent §2.5's build separation, so a grep as a
  guarantee is an established mechanism in this repo rather than a novelty. It is the only
  instrument that catches the defect _before_ it reaches a session.

### 3.4 The `persist:` partition is a security property, not tidiness

The browse view runs on `persist:spm-browse`. Six things that buys, every one of them measured:

| What                                | Measured                                                                                                                              | Why E wants it                                                                                                                               |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| Separate cookies and `localStorage` | Verified both directions: a value set in the partition was invisible from a default-session view at the same origin, and vice versa   | A site's cookies are never in the same jar as anything the app itself stores, and the app's session state is not readable by a site          |
| Separate storage directory          | `…\Roaming\<app>\Partitions\spm-browse` against `…\Roaming\<app>`                                                                     | The browsing profile is one directory the user can delete, and it is not the app's own                                                       |
| **`spm://` is not handled there**   | `isProtocolHandled('spm')`: `true` on the default session, `false` on the partition. A top-level navigation rejects `ERR_FAILED (-2)` | **The decisive one.** See below                                                                                                              |
| Its own `will-download` stream      | Identical listeners on both sessions; only the partition's fired (row 19)                                                             | The browse interceptor cannot capture the app's own `spm://app/_spm/files/<id>/raw` downloads, and nothing on `defaultSession` sees a site's |
| Its own permission handler          | `setPermissionRequestHandler` on each session fired only for its own view's request                                                   | 3.6 — and it means the browse partition needs one **written for it explicitly**, or it has Electron's defaults                               |
| Popups stay inside it               | A popup is created on the opener's session; storage path ended in the opener's partition (§14.2 `p17`)                                | A site's popup does not fall back to `defaultSession`                                                                                        |

**The `spm://` row is the one that makes this a security property.** On the **default** session the
same top-level navigation **succeeds**: `loadURL('spm://app/')` from an embedded view returned
`loaded` and `getURL()` was `spm://app/` (row 9). There is no bridge at the other end — the view has
no preload — but the privileged origin is reachable, and the app serves **file bytes** under it:
`spm://app/_spm/files/<id>/raw`, which `files.ts:145-152` answers with `content-type`,
`content-length`, `content-disposition: inline`, `accept-ranges` and `x-content-type-options` and
**no CSP at all** (`app.ts` attaches `CONTENT_SECURITY_POLICY` only on the renderer-asset branch, for
`text/html`). A browse view on the default session would have the user's library file URLs within
reach of a top-level navigation. The partition removes the question rather than answering it.

Note precisely what the partition does and does not change here, because the two halves differ:
a `fetch()` of `spm://app/...` from embedded content fails on **both** sessions (row 9 — the
default-session view's fetch was a `TypeError` too). It is the **top-level navigation** that the
partition blocks and the default session permits. The partition is the discriminator for navigation,
not for fetch.

**And it is a property to keep on purpose.** `browseSession.protocol.handle('spm', …)` succeeds
(row 10) — the platform does not forbid it. So this is asserted (8.3) rather than assumed.

### 3.5 The navigation policy must be a second policy on a second `webContents`

**The composition defect, measured in shipped code** (rows 11 and 12): subsystem C's
`applyNavigationPolicy` hooks `window.webContents`. With it attached exactly as `app.ts` does it, a
`loadURL` and an in-page `location.href` inside a `WebContentsView` added to that window **both
completed with an empty hook log**, and `getURL()` afterwards was the third-party URL.
`navigationPolicy` would have answered `'external'` for it. Attached directly to the view's own
`webContents`, the same function logged the hook and the view stayed where it was.

So the browse view gets its own hooks. And it is a **different policy**, not a second call to the
same one: the renderer's policy sends `http(s)` to `shell.openExternal`, which is exactly what a
model browser must not do — a browse view that opened every link in the user's system browser would
not be a browser.

**`browseNavigationPolicy(url)`, in `urls.ts`, beside `navigationPolicy` and tested the same way:**

| Answer  | For                                                                                       | Why                                                                                                                                                                         |
| ------- | ----------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `allow` | `http:` and `https:`                                                                      | This is a browser. The inversion of the renderer's policy, and the reason it is a separate function rather than a flag                                                      |
| `block` | `spm:`                                                                                    | Belt-and-braces behind 3.4: the partition already refuses it with `ERR_FAILED`, and a policy that relies on a session property nothing in `urls.ts` can see is not a policy |
| `block` | everything else — `file:`, `data:`, `javascript:`, a custom scheme, an unparseable string | Same default as the renderer's, same reason: the list worth refusing is open-ended and the list worth allowing is one entry long                                            |

**No host allowlist**, and this is a decision rather than an omission. Containment comes from the
partition and the absent preload, not from a list of hostnames; a list would read as if it were the
security boundary while doing none of that work, and it would break real use — a site's own CDN, its
consent-management vendor, and the identity provider a user logs in through are all other hosts, and
5.7 says the login is the user's to perform. **Not measured:** no login was performed anywhere
(§11.3), so "logins go through other hosts" is reasoning about how the web works, not something this
spike observed. It is recorded as an open question (9.4) rather than presented as a finding.

The **custom-scheme** arm is not hypothetical: MakerWorld's only logged-out affordance is
`Open in Bambu Studio` (row 29), which is a custom-scheme hand-off. `block` is the measured-ignorance
answer — whether it reaches `will-navigate`, `setWindowOpenHandler` or a protocol hook was never
measured (§11.5) — and 9.3 says what settling it would take. Blocking it costs a user the hand-off
and tells them so; permitting an unmeasured scheme to reach `shell.openExternal` hands an arbitrary
string to the OS, which `navigationPolicy`'s docblock already names as its own vulnerability.

### 3.6 `setWindowOpenHandler`, and the popup question settled

The browse view needs its own window-open handler too — the same hook attached to the same
`webContents` for the same reason (row 13). With none, `window.open` from embedded content produced
a real top-level `BrowserWindow` at the requested URL. With one, zero windows.

**A popup from the browse view cannot reach the app's bridge, and the reason is now precise.** A
popup **never has a bridge of its own**: a preload is not inherited across `window.open`, measured
across 21 variants against the repo's real bundled preload, and `did-create-window` hands the main
process merged options carrying no `preload` key (row 14). What a popup has, **when same-origin with
its opener**, is `window.opener.spm` — the opener's _live_ bridge, through which an `invoke`
returned a real `ipcMain` answer (row 15). The separating variable is **same-origin-ness at the
moment of the open**, and nothing else in the measured table moves it: not the preload, not the
handler's return shape, not the features string, not `nativeWindowOpen` (which no longer exists on
this Electron). `noopener` severs the reach.

For the browse view this is **largely moot, and it is moot _because_ of the partition** — which
makes it an argument for 3.4 rather than a side effect of it. A browse popup would be same-origin
with a site, and the opener is a site with no bridge; and the one origin whose opener _would_ hold a
bridge, `spm://app`, **is not served on the browse partition at all** (row 8). The partition removes
the same-origin case rather than relying on it not arising. That is the sixth reason for the
partition and the one that is easiest to lose in a refactor.

**The handler is still deny-by-default**, for reasons that are about the product rather than the
bridge: a site's popup would be a top-level `BrowserWindow` outside the app's own frame and outside
whatever chrome `/browse` draws, and it would be a second window with no back button and no address
bar. E's handler therefore does one thing the renderer's does not: for an `http(s)` target it
**navigates the browse view itself** to the URL and returns `{ action: 'deny' }`, so a
`target="_blank"` link on a model page goes where the user expects. Anything else is denied outright.

If a later change ever needs to _allow_ a real popup, it forces `noopener` — measured to null the
opener link and to make `window.open` return `null` to the caller (§14.2 `p05`, `p22`). That is a
design note carried forward, not a description of what E builds.

### 3.7 The permission handler

Each session needs its own; the default session's handler fired only for the default session's view
(row 7). So a browse partition with none uses Electron's defaults, which is not a decision anyone
made.

**`setPermissionRequestHandler` on the browse session denies everything.** A model site needs no
geolocation, no camera, no microphone, no notifications, no MIDI, no clipboard read, no pointer lock
and no persistent storage grant to show a page with a download button on it, and a browser embedded
in a project manager is not the place to start granting them. A denied permission is a degraded page;
a granted one is a capability the user was never asked about, in a window that looks like the app.

`setPermissionCheckHandler` — the synchronous sibling that answers `navigator.permissions.query` and
some checks that never raise a request — was **not measured** and is set to the same refusal for
consistency. Recorded as 9.5 rather than presented as measured.

### 3.8 What the browse view does not inherit, and why that is fine

**It does not inherit the app's CSP** (row 16). CSP is a per-response header, so embedded content
runs under whatever the site sends — which for these sites is nothing useful. The discriminator was
sharp: a `fetch` refused from the host document at `spm://app` under the app's real
`connect-src 'self' spm:`, and the identical fetch from the embedded page at `ok 200`. Its inline
scripts ran.

This is expected and is not a hole. The app's CSP exists to constrain _the app's own renderer_, which
holds the bridge. The browse view holds nothing, reaches nothing privileged (3.4) and can navigate
nowhere the policy permits it to escape from (3.5). Trying to impose the app's CSP on a model site by
rewriting response headers would break the sites and buy nothing the containment above does not
already give.

It also cannot iframe `spm://app/`: `ERR_BLOCKED_BY_RESPONSE`, the app's own `frame-ancestors 'none'`
doing its job (row 17). That directive is now load-bearing for E and not only for the renderer, which
is worth knowing before someone relaxes it.

### 3.9 The five properties, in one place

An implementer or a reviewer should be able to check these without reading the argument again. Each
one has a measurement behind it and an assertion in 8.3.

1. The browse view is a `WebContentsView` with **no `preload`**, and the main window is never
   navigated to a site.
2. It is on **`persist:spm-browse`**, and `spm://` is **not** handled on that session.
3. `packages/desktop/src` contains **no** `registerPreloadScript` and **no** `setPreloads`.
4. `will-navigate` and `setWindowOpenHandler` are attached to **the view's own `webContents`**, with
   `browseNavigationPolicy`, not the renderer's.
5. The browse session has its **own permission handler**, denying everything.

## 4. The browse surface and its lifecycle

### 4.1 A native sibling, not a DOM element

The renderer is an Angular app in a `BrowserWindow`. A `WebContentsView` is added to that window's
`contentView` as a sibling of the renderer's own view. **It is not in the DOM.** Three consequences,
each of which an implementer would otherwise discover the hard way:

- **It cannot be laid out by CSS.** Its position is `setBounds({x, y, width, height})` in the
  window's coordinate space, set from the main process. Angular can only _describe_ where it should
  be.
- **It paints over the renderer unconditionally.** There is no z-index relationship to negotiate: a
  dialog, a toast, a dropdown or a route transition rendered by Angular under the view's rectangle is
  invisible. So the app's own chrome must live **outside** the rectangle, and any modal the app
  raises while browsing must first shrink or detach the view.
- **It outlives its route unless something destroys it.** Angular unmounting the `/browse` component
  does nothing to a native view. A view that survives a route change is a site painted over the
  project list — which is not a cosmetic bug, it is a third-party page rendered inside what the user
  reads as the application.

### 4.2 Bounds, and who owns them

The renderer owns the _intent_; the main process owns the _rectangle_.

The `/browse` page renders an empty placeholder element and reports its bounding rectangle, in CSS
pixels, through `browse.setBounds`. The main process converts by the window's current
`zoomFactor`/scale, **clamps to the window's content bounds**, and applies. It clamps rather than
trusts because the renderer is the untrusted side of this boundary (C plan, constraint 4) and an
unclamped rectangle is a site drawn over the whole window including whatever chrome the app uses to
say "this is a site".

Reported on: element resize, window resize, and the page's own scroll. The main process also
re-applies on the window's `resize` event, so a resize between two renderer reports never leaves the
view stranded — the renderer's report is the intent and the window's event is the correction.

**This is designed, not measured.** §11.9 is explicit that nothing in the spike touched layout,
resize or focus, and it names this as the famously fiddly part of `WebContentsView`. 9.6 records it
as the open question it is.

### 4.3 The route, and leaving it

`/browse` is an ordinary Angular route (7.4). The native view is attached on the page's
`ngOnInit`-equivalent and **destroyed** on teardown — `browse.attach()` and `browse.detach()`.

**Destroyed and not hidden.** Hiding is the tempting option because it makes returning to `/browse`
instant and keeps the user's place on a site. It is rejected: a hidden view is a live third-party
page still running script, still holding sockets, still able to start a download the user is not
looking at, and still one bounds bug away from being visible on a page it has nothing to do with. The
cost is real and it is the right cost — and it is smaller than it looks, because **the partition is
persistent**: cookies, logins and `localStorage` survive the destruction of the view, so returning to
`/browse` returns to a signed-in session, just not to a scroll position.

Three backstops, because a native resource whose only owner is a renderer lifecycle hook is a leak
waiting for a crash:

- The main process holds **at most one** browse view. `attach` on a shell that already has one
  destroys the previous one first.
- The view is destroyed on the host window's `closed`.
- The view is destroyed on a **transport change**. `replaceWindows` in `app.ts` builds a new window
  and destroys the old, in that order and for a measured reason; a browse view still parented to the
  old window would go with it, but a browse view the shell still holds a reference to would be a
  handle on a destroyed window. `ShellHost`'s existing "switching modes must not leak the previous
  mode's client" property (`shell.ts`) is exactly the same property, and E's view joins the things it
  covers.

### 4.4 The site registry, and what `/browse` opens on

A static table in `packages/desktop`, one row per site — the same shape and the same reasoning as D's
slicer registry: it is code, not configuration, and every field in it is a measured property.

```ts
type ModelSiteDef = {
  id: 'thingiverse' | 'printables' | 'makerworld' | 'cults3d'
  displayName: string
  /** Matched against a URL's host with a leading `www.` stripped. */
  hosts: string[]
  /** Where "browse this site" starts. */
  homeUrl: string
  /** 6.2. Returns the site-stable identity of a model URL, or null if this is not one. */
  identity(url: URL): string | null
}
```

It drives three things and **not** a fourth: the start page, the URL matching of 6.2, and the label a
download is attributed to. It does **not** restrict navigation (3.5).

The four rows are the four sites the spike measured. Nothing stops a user typing another URL into the
address control; they simply get no site identity for it, and 6.2's fallback applies.

### 4.5 What the UI does during an interstitial

Two of the four sites answer 403 with Cloudflare's non-interactive managed challenge, clearing in
about 5.6 s and 6.4 s (row 27). That is long enough that a naive UI looks broken, and it is the
single most likely first impression of this feature.

**What the app does:** shows a normal loading state, and **does not time out at three seconds**. The
challenge clears itself; a spinner that gives up before it does converts a working page into an error
message. The spike's own failure mode is the warning — an earlier run that waited a flat 9 s and then
read the DOM once still saw "Just a moment…", while a run that polled every 2 s saw the real page at
5.6 s. What is being waited for is a **navigation**, not a timer, so the app waits on the view's own
`did-navigate` / `did-finish-load` and shows progress rather than counting seconds.

**What it never does:** spoof a user agent (row 28 — measured not to matter, and the spec says so in
those words so nobody re-adds it as a fix), retry in a loop, solve a challenge, or present a
challenge page as an error. If a page is still challenging after a generous window, the app says the
site is verifying the connection and leaves the view where it is, because the view is a browser and
the user can look at it.

**Consent overlays** (row 30) are the user's to dismiss. The app clicks nothing. Thingiverse's names
1067 partners and Cults3D's has no plainly-labelled reject control; the app choosing on the user's
behalf would be making a privacy decision it has no standing to make, and the measurement that a
scripted click on Cults3D did nothing at all is a reminder that it would not even work reliably.

## 5. Downloads

### 5.1 Interception, and why it must be decided in the handler

`will-download` on the browse session, `item.setSavePath(...)`, done. Measured end to end on a real
site at real size: 21 060 699 bytes landed at the chosen path with ZIP magic intact and **nothing in
the user's Downloads folder** (row 20).

Two measured facts remove the alternatives, and they are worth stating as the constraints they are:

- **The URL may be a `blob:`** (row 22). Thingiverse's was — `getURL()` and the whole `getURLChain()`
  were one `blob:` URL. A design that captured the URL and re-fetched it from the main process, or
  handed it to the OS, **would fail on Thingiverse specifically**. `setSavePath()` inside the handler
  is the only mechanism that works.
- **Refusal is all-or-nothing and synchronous** (row 21). `preventDefault()` stopped the download
  completely — nothing written anywhere — and the item was destroyed by the next tick;
  `item.getState()` afterwards threw `DownloadItem used after being destroyed`. There is no "ask the
  user first" inside the handler, because there is no await that leaves an item alive.

So the handler makes exactly one decision, on information it has synchronously, and stages
everything it does not refuse.

### 5.2 What the handler decides, and the one thing it refuses

**Default: accept and stage.** Staging is safe because a staged file is inert — it is in a directory
under `userData`, it is in no project, no `files` row exists for it, and nothing has been uploaded.
The user's decision happens afterwards, with time, in the UI (5.4).

**Refused, synchronously: a download past the session's ceiling.** A per-browse-session cap on
concurrent downloads and on total staged bytes. This is the one refusal that needs no user input and
so is the one that fits inside the handler, and it exists because an unattended `will-download` is a
disk-fill primitive for any page that wants one.

**Not refused: `hasUserGesture() === false`.** It is recorded on the download record and shown, never
acted on. Row 25 is why: the flag distinguishes `webContents.downloadURL()` from a real click, but a
click driven by `executeJavaScript` also reports `false` — so it is evidence about how a download
started and not a verdict, and refusing on it would silently break sites whose download button is a
scripted `blob:` construction. Which is Thingiverse's, the one download that was actually measured.

### 5.3 Where the bytes go

`<userData>/model-downloads/<downloadId>/<filename>`, one directory per download — the same shape as
D's per-launch directory and for the same reason: one directory, one file, one record, no ambiguity
about what belongs to what.

The filename is `item.getFilename()`. **Not `Content-Disposition`** — row 23: it was an empty string
on the real download, while `getFilename()` was populated and sane in every case measured. Sanitised
through the same rules `files.upload` already applies (core's `safeJoin` refuses separators and
traversal), because the name comes from a remote server.

Progress is real (row 24): `updated` fires repeatedly with `getReceivedBytes()`,
`getPercentComplete()` and `getCurrentBytesPerSecond()` populated, and `done` fires once. The record
carries them; the `/browse` page polls `browse.downloads()` while it is mounted, which is the same
request/response shape D's session card uses rather than a new event channel.

`getETag()` and `getLastModifiedTime()` came back **empty on every download measured** (row 23), so
nothing in the design may use them — no caching, no "have I downloaded this before" check built on
them.

**Swept at start, never deleted implicitly.** Staged downloads from previous runs are enumerated and
offered, exactly as D's `sessions.sweepAtStart()` enumerates unfinished launches and deletes nothing.
A user who quit mid-decision gets their file back rather than losing it silently.

### 5.4 Landing a download into a project

**Never automatic.** The user names the project, always. 6.3 says why this is not merely caution: the
common case is that nothing matches.

The landing is a `shellCall` — `browse.land(downloadId, projectId, { name })` — and it resolves the
bytes itself. In **local mode** it calls core's `uploadFile` with a `createReadStream` of the staged
file, wrapped to the streaming `UploadBody` core takes. In **remote mode** it goes through
`remoteUpload` in `packages/desktop/src/slicers/remote-files.ts`, which already streams a file from a
directory to `POST /api/projects/:id/files` through `RemoteHost.proxy` with the session cookie, the
`UPLOAD_LENGTH_HEADER` the server's quota check requires, and the percent-encoded name header.

Three properties fall out of that and are the reason for it:

- **The bytes never cross IPC.** They are already main-process side; the renderer names a
  `downloadId` and a `projectId` and never a path. This is C's constraint 4 and the parent's "bulk
  bytes never cross a JSON boundary" (§4.2), satisfied by construction rather than by care.
- **`files.upload` is the landing path the parent named** (§9), so the quota check comes free —
  parent §5.6 already says "downloads from the model browser (spec E) land through `files.upload`, so
  they inherit the check with no extra code", and this is what makes that sentence true.
- **A name clash is reported, not worked around.** `uploadFile` throws `Conflict` when the name
  exists in the project or on disk. The UI surfaces it and lets the user rename. It does **not**
  auto-suffix: `benchy-1.zip` beside `benchy.zip` hides the fact that the user already has this
  model, which is precisely the thing they were trying to find out.

A landed download's staging directory is removed once the upload has returned. A failed upload leaves
it, so the user can try again.

**`remote-files.ts` is now used by two subsystems**, which makes its location a small lie. Its
contents are generic — `apiRequest`, `remoteUpload`, `remoteDownload`, `failureOf` — and only its
docblock is about slicers. E imports it where it is rather than moving it, and the move to
`src/remote-files.ts` is recorded as a cleanup with its reason (9.7) rather than performed here,
because it touches D's tests and belongs to its own change.

### 5.5 What actually comes down is an archive

Thingiverse's download is a **21 MB zip of everything** — four `.stl` files, nine images, a
`README.txt` and a `LICENSE.txt` (row 20, §8). Not a single model file. And no per-file download link
was findable on the page: `a[href*="/download:"]` returned `[]` on the `/files` tab even though the
four `.stl` names were in the DOM.

**E lands the archive whole, as one file, classified `kind='other'`.** It does not extract.

That is a worse outcome for the user than extraction and it is stated plainly rather than dressed up:
they get one `.zip` in the project with no preview and no model rows. What they do next is
**unzip it into the project folder and rescan** — which works today, needs nothing from E, and is
correct by the parent's own design: disk is the source of truth for which files exist (§3.2), a
rescan adopts what it finds, classifies it and seeds previews (§3.5), and dropping files into project
folders by hand is a first-class workflow the parent explicitly supports.

Extraction is not in E because it is a `core` change, and the brief's instruction and the C plan's
constraint 2 both point the other way. It would need: a use case that expands an archive into a
project, a quota check over the _expanded_ size rather than the archive's, per-entry name-clash
handling, and a zip-slip guard on every entry name. Core has the reader for it (`files/zip.ts`) and
a precedent for walking an archive into a library (`importCuraManagerZip`), so it is a plausible
follow-up rather than a wall. Recorded as 9.1.

### 5.6 What is not known about downloading from three of the four sites

Row 29, restated because the design must not pretend otherwise:

- **Thingiverse** is the only site where a download was measured end to end, anonymously.
- **Printables**' Download button was located on a real model page with no login wall and **was not
  clicked**.
- **Cults3D**'s `DOWNLOAD FREE` produced neither a download nor a navigation under a scripted click,
  with its consent overlay on screen. Unresolved between "needs the overlay dismissed" and "needs an
  account".
- **MakerWorld** has **no measured download path at all.** Its only logged-out affordance is
  `Open in Bambu Studio`.

E's design does not depend on the three unmeasured cases: `will-download` on the browse session is a
session-level hook, so any download any page starts is intercepted, whatever the button did. What is
genuinely unknown is whether those buttons produce a download at all, and 9.2 says what settling it
costs.

### 5.7 Authentication is the user's

**The app stores no third-party credential and automates no login.** The persistent partition is what
makes that a complete answer rather than a limitation: the user signs in on the site, in the view,
themselves, and the partition keeps the session across restarts. There is no place in this design
where the app types a password, and no field in any of its stored state that could hold one.

MakerWorld is the case that would tempt a designer into more. It is the one site with a measured
login wall, and the temptation would be to design "the flow" for it. There is no measurement of that
flow — no account was created (§11.3) — so **there is no flow here**, only a browser the user can log
into. Designing an unmeasured login path is how a spec acquires a section that is wrong.

## 6. Matching a site URL to a project

### 6.1 What varies, per site

Collected from real pages loaded in a `WebContentsView` (§9). `projects.website` is validated as a
full URL (`packages/contract/src/schemas.ts:51`), so what is stored is whatever the user pasted.

| Site        | Canonical form observed                                                   | What varies                                                                                                                                                                                                         | Stable identity                  |
| ----------- | ------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------- |
| Thingiverse | `https://www.thingiverse.com/thing:7401409`                               | Sub-paths `/files`, `/comments`, `/apps`, `/makes`. **No `<link rel=canonical>` and no `og:url` at all** — both `null` on two different things                                                                      | `thing:<id>`                     |
| Printables  | `https://www.printables.com/model/1807378-universal-clip-self-tightening` | **Locale is a query**: `/de/model/1807378-…` landed on `/model/1807378-…?lang=de` with the canonical unchanged. Slug derives from the title                                                                         | `<id>` from `/model/<id>-<slug>` |
| MakerWorld  | `https://makerworld.com/en/models/2093108-dji-neo-2-the-box`              | **Locale is a path segment**, 12 `hreflang` alternates. `/de/models/2093108` (no slug) → **307** → the canonical. App appends `?from=recommend` and a `#profileId-<n>` fragment                                     | `<id>` from `/models/<id>-…`     |
| Cults3D     | `https://cults3d.com/en/3d-model/various/hyper-hopper`                    | **No numeric id, and the whole path is translated**: `/de/modell-3d/verschiedene/…`, `/ja/3d-moderu/iroiro/…`. Both the type segment and the category segment change per locale, and the category differs per model | **The last path segment only**   |

### 6.2 The key

```
matchKey(url) =
  parse; lowercase the host; strip a leading "www."
  drop the query and the fragment entirely
  if a registry row's hosts match, use that row's identity(url):
    thingiverse  ->  "thingiverse:" + <id> from /thing:<id>
    printables   ->  "printables:"  + <id> from /model/<id>-<slug>
    makerworld   ->  "makerworld:"  + <id> from /models/<id>-<slug>   (locale segment ignored)
    cults3d      ->  "cults3d:"     + the final path segment, percent-decoded, lowercased
  otherwise:      lowercased host + pathname, trailing slash removed
```

Every clause answers a measured row rather than a taste:

- **The query and fragment are dropped** because Printables puts the locale there (`?lang=de`) and
  MakerWorld appends `?from=recommend` on referral links and a `#profileId-<n>` fragment at runtime.
  Keeping them makes two URLs for the same model.
- **A per-site identity, not `host + pathname`**, because a naive path match fails on exactly the two
  sites with `hreflang` alternates. MakerWorld's locale is a path segment; Cults3D translates the
  path _segments themselves_, which no generic normalisation can undo.
- **Cults3D is the final segment alone** because nothing else in its URL survives a locale change —
  and the category segment also differs per model (`various`, `home`), so it is not even stable
  within one locale.
- **`<id>-<slug>` matches on the id** because the slug derives from the title and a retitled model
  changes it.
- **The fallback is `host + pathname`** for anything the registry does not recognise, which is honest
  about being a weaker key rather than pretending the four rows are the whole web.

**This is a consequence of the rows, not a rule that was tested.** §9 says so in those words. The URL
shapes were measured; the key derived from them was not run against a library of real
`projects.website` values. 9.8 records it, and 8.3 gives it the exhaustive fixture test that is the
cheapest available substitute.

### 6.3 When nothing matches — which is the common case

**A first-time download matches nothing, by definition.** The project does not exist yet; that is why
the user is on the site. Any design that treats "no match" as an error path has the common case
backwards.

So the landing UI's shape is: **choose a project**, with the matched one preselected when there is
one, and **create a new project** as a first-class option beside it — not a fallback reached after a
failure message. When a new project is created this way, its `website` is set to the **canonical URL
of the page the download came from**, which is what makes the _second_ download from that model match.

The match, when there is one, is presented as a suggestion the user confirms. It is never applied
silently: `matchKey` is derived rather than measured (6.2), and a wrong silent match puts someone's
file in someone else's project.

Two or more projects sharing a `matchKey` is possible — nothing in the schema forbids two projects
with the same `website`. All of them are offered, ordered by name. This is not an error condition and
is not reported as one.

### 6.4 Where matching runs

**In the renderer, over `projects.list`, and nowhere else.**

`ProjectDto` already carries `website` (`dtos.ts:62`), so `API_CLIENT.projects.list({
includeArchived: true })` returns everything the match needs in one call the page is already making
to populate its project picker. `matchKey` is a pure function in `packages/contract` — it is shared
by the page and by nothing else today, and it belongs beside the schema that validates the URL it
parses.

**The alternatives, and why not:**

| Alternative                                   | Why not                                                                                                                                                                             |
| --------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A `website` filter on `ProjectQuery`          | It is a change to the server's observable behaviour (C plan, constraint 2) for a filter that saves nothing: the page needs the full project list anyway, for the picker             |
| Match in `core`, keyed on a normalised column | A new column, a migration, a backfill, and a matching rule baked into the database — for a rule 6.2 admits is derived rather than measured. Browsing is a shell concern (parent §9) |
| Match in the main process                     | It would need the project list in the main process, which in remote mode means a request the renderer is already making. Two call sites for one list                                |

`core`'s `LIKE` search (`queries.ts:157`) covers name, notes and tags and deliberately **not**
`website`; nothing here changes that.

## 7. Capabilities, API surface, and the seams

### 7.1 The capability flip

`canBrowseModelSites` becomes `true` in **both** desktop shell columns —
`LOCAL_SHELL_CAPABILITIES` and `REMOTE_SHELL_CAPABILITIES` in
`packages/desktop/src/capabilities.ts` (E-11). Both, because browsing is a property of the _machine_
and not of the library: the desktop app pointed at a remote server can still embed a browser, and
5.4 lands the download on that server.

The browser column stays `false`. The Deno server goes on reporting it false from
`/api/capabilities`, and the union (`||`, a shell-owned row) is what carries the shell's `true`
through in remote mode. **That column is now false on evidence rather than by assumption**: §7
measured that the sites refuse framing and a `WebContentsView` is what loads them, and a browser
build has no `WebContentsView`.

Both docblocks in that file say "`canBrowseModelSites` stays false until E ships it, which is a
deliberate departure from the spec table: a capability whose feature does not exist lights up UI that
goes nowhere". E ships it, so those two sentences go with the flip.

**And one test loses its subject.** `test/capabilities.test.ts:110` — "a backend cannot veto a
capability the shell has" — was **re-pointed at `canBrowseModelSites` by D** for exactly this reason:
D flipped the two slicer flags, the fixture stopped differing from the constant it spreads, and the
assertion decayed into "`true || false` is `true`". E flips the last shell-owned flag, so there is no
flag left in the real columns to carry that property. The fix is to stop spreading
`REMOTE_SHELL_CAPABILITIES` and build the fixture as a **literal** `Capabilities` with the shell rows
true and a backend with them false — the test is about the operator, not about today's constants, and
tying it to constants is what has now decayed it twice. Whoever lands E fixes it there rather than
leaving a third subsystem to find it.

The four assertions D named change again: `capabilities.test.ts:39` and `:50` (the two shell columns
asserted whole), `:67` (the local-mode deep-equal) and `:78` (the remote-mode union).

### 7.2 The seam: `SHELL_CLIENT` for the browser, `API_CLIENT` for the library

Both, and the split is the interesting part.

**The browser is `SHELL_CLIENT`** (`packages/web/src/app/core/api/api-client.token.electron.ts`).
The view, its bounds, its navigation and its downloads are all properties of _this process on this
machine_, and they must work in both modes — in remote mode `API_CLIENT` is `HttpApiClient`, which
reaches a server that has no `WebContentsView`. This is the same reasoning D's docblock already gives
for the slicer methods, applied unchanged.

**The library is `API_CLIENT`.** The project list the match runs over, and the project the user
creates, come from whichever transport the library is on. The `/browse` page injects both, which is
correct rather than awkward: it is a page about a machine capability that lands its result in a
library.

The methods go **on the `ApiClient` interface** and are refused by `HttpApiClient` with an
`AppError('Forbidden', …)`, exactly as `library.pick`, `library.connect` and the `slicers` block are.
That is what buys the compile-time guarantee: `DispatchTable` is a mapped type over `ApiClient`'s
dotted paths, so a method added to the interface and not implemented in the desktop shell **fails
`deno task typecheck`**, and the key-set test fails with it.

**Every `browse` entry is a `shellCall`, not a `libraryCall`** — the same structural consequence D
hit. `libraryCall` refuses a null session by design, and in remote mode `deps.session` _is_ null.
`browse.land` needs a library, but it resolves one itself the way `SlicerLauncher` does: through the
per-call session accessor in local mode, through `RemoteHost.proxy` in remote mode.

**And the security seam: the renderer names a `downloadId` and a `projectId`, never a path.** The
staging directory is the main process's, the download record is the main process's, and the only
strings that cross the boundary are ids the main process minted itself and matches against records it
enumerated itself. This is C's constraint 4, and it is what keeps `browse.land` from being a "read
this path and copy it into the library" primitive.

### 7.3 The interface additions

```ts
browse: {
  /** The site registry (4.4), so the page can render the start links without duplicating it. */
  sites(): Promise<ModelSiteDto[]>

  /**
   * Creates the browse view and shows it. Idempotent per window: an `attach` on a shell that
   * already has one destroys the previous view first (4.3).
   * `url` defaults to the last page of the previous session, then to nothing.
   */
  attach(bounds: BrowseBounds, url?: string): Promise<BrowseStateDto>

  /** Destroys the view. Safe to call when there is none. Called on route teardown (4.3). */
  detach(): Promise<void>

  /** CSS pixels in the host page's coordinate space; the shell converts and clamps (4.2). */
  setBounds(bounds: BrowseBounds): Promise<void>

  /** `http(s)` only — `browseNavigationPolicy` refuses the rest, in the shell (3.5). */
  navigate(url: string): Promise<BrowseStateDto>
  back(): Promise<BrowseStateDto>
  forward(): Promise<BrowseStateDto>
  reload(): Promise<BrowseStateDto>

  /** Polled while `/browse` is mounted: URL, title, loading, history. See 4.5 and 5.3. */
  state(): Promise<BrowseStateDto>

  /** Everything staged, including what previous runs left (5.3). */
  downloads(): Promise<BrowseDownloadDto[]>

  /**
   * Lands a staged download into a project as a new file (5.4). Local mode calls core's
   * `uploadFile`; remote mode streams it through the proxy. The bytes never cross IPC.
   * `name` defaults to the download's own `getFilename()`.
   */
  land(downloadId: string, projectId: string, opts?: { name?: string }): Promise<FileDto>

  /** Deletes a staged download and its directory. The only thing that removes one. */
  discard(downloadId: string): Promise<void>
}
```

```ts
ModelSiteDto {
  id: string
  displayName: string
  homeUrl: string
}

BrowseBounds { x: number; y: number; width: number; height: number }

BrowseStateDto {
  attached: boolean
  url: string | null
  title: string | null
  isLoading: boolean
  canGoBack: boolean
  canGoForward: boolean
  /** The registry row this URL belongs to, or null. Drives attribution, not permission (4.4). */
  siteId: string | null
  /** Set when the last navigation failed, so 4.5 can say what happened rather than spin. */
  lastError: string | null
}

BrowseDownloadDto {
  downloadId: string
  fileName: string
  /** `getURL()` — which may be a `blob:` (row 22). For display and attribution only. */
  sourceUrl: string
  /** The page the view was on when it started. This is what 6.2 matches on, never `sourceUrl`. */
  pageUrl: string | null
  siteId: string | null
  mimeType: string
  state: 'progressing' | 'completed' | 'cancelled' | 'interrupted'
  receivedBytes: number
  /** `getTotalBytes()`, which can be 0 for a server that sent no length. */
  totalBytes: number
  /** Row 25: recorded and shown, never acted on (5.2). */
  hadUserGesture: boolean
  startedAt: number
  /** True for a download staged by a previous run of the app (5.3). */
  isOrphan: boolean
}
```

**Why `pageUrl` and `sourceUrl` are two fields.** The download URL is not the model page and on
Thingiverse it is not a URL at all — it is a `blob:` (row 22), which identifies nothing and matches
nothing. What 6.2 matches on is **the page the browse view was on when the download started**, read
off the view's own `webContents` inside the `will-download` handler. Conflating the two is the defect
this pair of fields exists to prevent, and it would have shipped: the obvious field to match on is
the one the `DownloadItem` hands you.

### 7.4 `/browse` and the routes

Parent §6.3 lists `/browse` as electron-only. It is added to `routes.electron.ts` — whose docblock
already reserves the name — under `./features/desktop/browse/`, with `authGuard`, matching
`/settings/slicers`. In local mode `requiresAuth` is false and the guard passes on its first arm; in
remote mode an unauthenticated window has no business anywhere but `/login`.

It is reached from the app's own navigation, rendered only when `canBrowseModelSites` is true, by
`routerLink` **string** and nothing more — shared code must not import from `features/desktop/`
(parent §2.5), and CI's bundle greps enforce it. The route does not exist in the web build at all, so
a rendered link there would fall through to the `**` redirect; it is never rendered, because the
capability that gates it is false in the browser column. That is the capability model doing its job
in place of a build-time condition.

**CI gains a fifth grep pair**, matching the four that exist for the placeholder, connect and slicers
pages: the browse page's exported class name must be absent from `packages/web/dist/web/browser` and
present in `packages/web/dist/electron/browser`. It is the strongest case yet for that rule — the
browse page is the one desktop-only page whose leak into the web build would be a security-shaped
failure rather than a dead link, because it would ship a UI that expects a containment the browser
cannot provide.

### 7.5 `packages/core` does not change

Nothing in E needs it, and that is worth asserting rather than assuming.

- The **downloads** are a shell concern end to end: a session hook, a staging directory, a record.
- The **landing** uses `files.upload` unchanged, which parent §9 already named as E's seam and parent
  §5.6 already wrote the quota sentence for.
- The **matching** is a pure function in `contract` over a field `ProjectDto` already carries (6.4).
- The **project creation** in 6.3 is `projects.create` with a `website`, unchanged.

So **the Deno server's observable behaviour does not change** (C plan, constraint 2): no route is
added, no DTO changes shape, no core module is added or edited. That is assertable rather than
assumed, and 8.3 asserts it.

## 8. Testing

### 8.1 What the seams buy

The pure parts are pure. `matchKey` and the site registry are functions over strings, and the
download record lifecycle — stage, list, sweep at start, land, discard — is a function over a
directory. All of it runs under plain `node --test` with no Electron, no window and no network, the
same way D's launcher does with `spawn` injected.

What is left needs Electron: the view, its session, its policy hooks and its bridge-lessness. Those
go in a `browse.spec.ts` beside `shell.spec.ts`, driven by Playwright against the real app, and
pointed at a **local HTTP server the test starts** rather than at a live site. Nothing in CI may
depend on Thingiverse being up, on Cloudflare's mood, or on a challenge clearing in six seconds.

### 8.2 The one assertion the existing instrument cannot make

`getLastWebPreferences()` — which `shell.spec.ts:423` uses, correctly, for the three trust-model
flags — **does not report `preload`** (row 5). The full object on Electron 44 has 15 keys and
`preload` is not one of them, nor is `additionalArguments`. It is **byte-identical** for the host
window, which has a preload and a live bridge, and for an embedded view, which has neither.

So a test that asserts "the browse view has no preload" by reading that object **passes no matter
what**, including in the exact configuration measured to hand `ipcMain` to a third-party page. It is
worse than no test, because it looks like the property is covered.

**The only instrument that answered is reading `typeof window.spm` out of the embedded document**,
which is what the spike did in both directions and what 8.3's first assertion does.

For the session-preload defect (3.3) there is no runtime instrument at all in the ordinary case,
because it does not reach a partitioned view. What is asserted instead is the structural property
that makes the view immune — its session is not the default session — plus the source grep. Both are
in 8.3, and neither is a substitute for the sentence in 3.3, which is why 3.3 is written the way it
is.

### 8.3 What must be asserted

- **The browse view has no bridge.** `typeof window.spm` read _inside the embedded document_, at a
  non-`spm://` origin, expected `"undefined"` with `Object.keys` empty. Break it by adding
  `webPreferences.preload` to the view and confirm red — that configuration is measured to go green
  on every other test in the suite.
- **The browse view is not on the default session.** `webContents.session === session.defaultSession`
  expected `false`, and `getStoragePath()` expected to end in the partition name. This is the guard
  for 3.3 as well as for 3.4.
- **`spm://` is not handled on the browse partition.**
  `fromPartition('persist:spm-browse').protocol.isProtocolHandled('spm')` expected `false`, and
  `defaultSession`'s expected `true` in the same assertion so a null instrument is visible. Row 10
  says the platform permits registering it, so this is the assertion that keeps the property.
- **A top-level navigation to `spm://app/` from the browse view fails.** The positive form of the
  row above, and the one that is about the hazard rather than about the registration.
- **The navigation policy is attached to the view's own `webContents`.** Drive an in-page
  `location.href` to a blocked scheme in the view and assert the view stayed put. Row 11 is the trap:
  with the policy on the window instead, the navigation completes and the hook log is empty, so a
  test that only asserts "the policy function returns block" for that URL passes while the app is
  broken.
- **`setWindowOpenHandler` is attached to the view**, and a `window.open` from the embedded page
  creates **no** new `BrowserWindow` (count before and after) while the view itself navigates for an
  `http(s)` target (3.6).
- **The permission handler denies.** A `geolocation` request from the embedded page is refused, with
  the default-session handler asserted not to have fired — row 7 says each session's handler fires
  only for its own view, so an assertion that does not check which one fired can pass on the wrong
  one.
- **No `registerPreloadScript` and no `setPreloads` in `packages/desktop/src`** (3.3), as a source
  assertion.
- **`matchKey`, exhaustively, over the spike's own URLs as fixtures** — every canonical form, every
  `hreflang` alternate recorded in §9, the `?lang=`, `?from=recommend` and `#profileId-` variants, the
  sub-path forms of a Thingiverse thing, the MakerWorld no-slug 307 target, and an unrecognised host
  falling back. This is where §9's measurements become a test rather than a memory, and it is the
  only coverage 6.2's derived rule will ever get.
- **The staging lifecycle, against a temp directory**: a sweep at start **lists** an orphan rather
  than deleting it; `discard` is the only thing that removes one; a landed download's directory is
  removed only after the upload returned; a failed upload leaves it. D's equivalent rules were both
  defects in a first draft, which is the best available argument that they need tests rather than
  sentences.
- **The renderer never names a path.** `browse.land`'s dispatch entry takes two ids and an optional
  name; assert its schema refuses anything path-shaped, the way the slicer entries are asserted to.
- **The server is untouched** (7.5): no new route, no changed DTO, no edit under `packages/core`.
- **The web bundle carries no browse page**, and the electron bundle does (7.4).

### 8.4 What cannot be tested here

- **That any of the four sites still works.** Every site-facing row in §2 — the framing results, the
  challenge timings, the Thingiverse download, the URL shapes — is a measurement carried by the spike
  and by this document. It cannot become a test without making CI depend on four third parties, and
  a test that occasionally fails because Cloudflare was slow teaches people to ignore red.
- **That a download from Printables, Cults3D or MakerWorld intercepts.** Not measured at all (5.6),
  and untestable in CI for the same reason.
- **That the challenge clears in about six seconds.** Two observations on one afternoon (row 27).
  4.5's design deliberately does not depend on the number — it waits on a navigation, not a timer —
  which is what makes the untested number harmless.
- **`WebContentsView` layout, resize and focus in the real shell** (§11.9). A Playwright test can
  assert that `setBounds` was called with a clamped rectangle; it cannot assert that the result looks
  right, and nothing in the spike touched this at all.
- **macOS and Linux**, on any row.

## 9. Open questions

Answered where the evidence allows, and marked unmeasured with the cost of settling it where it does
not.

1. **Should a downloaded archive be extracted into the project?** **Answered: not in E** (5.5). It is
   a `core` change — a use case, a quota check over the expanded size, per-entry clash handling and a
   zip-slip guard — and browsing is a shell concern that the C plan's constraint 2 says must not leak
   into the server. The user's path today is to unzip into the project folder and rescan, which the
   parent's own design (§3.2, §3.5) supports as a first-class workflow. Core has the reader and a
   precedent (`importCuraManagerZip`), so this is a plausible follow-up with a known shape.
2. **Do Printables and Cults3D downloads actually intercept?** **Unmeasured** (§11.1, §11.2). The
   mechanism is measured end to end on Thingiverse and it is a session-level hook, so nothing in the
   design depends on which button started the download — but "the feature works on three of the four
   sites" is currently an inference. _To settle:_ one `sites4`-shaped run per site that waits out the
   challenge, dismisses the consent dialog **by a real click on its UI** (Cults3D offers no
   plainly-labelled reject control), clicks the button and reads `will-download`. Cheap.
3. **Does MakerWorld's `Open in Bambu Studio` reach anything?** **Unmeasured** (§11.5), and it is the
   only affordance that site offers a logged-out visitor. 3.5 blocks unknown custom schemes, which is
   the right answer under ignorance and is also a feature MakerWorld users will notice missing.
   _To settle:_ one run that clicks it and watches `will-navigate`, `setWindowOpenHandler` and
   `will-download` at once. If it is a custom-scheme navigation, the design question that follows —
   whether the app hands an arbitrary `bambustudio://` URL to `shell.openExternal` — is a real one
   and should be decided with the measurement in hand rather than now.
4. **Should navigation be restricted to a host allowlist?** **Answered: no** (3.5), with the reason
   stated as reasoning rather than measurement. Containment is the partition and the absent preload;
   a hostname list would read as the boundary while doing none of that work, and it would break a
   site's CDN, its consent vendor and any identity provider a login goes through. **Not measured** —
   no login was performed anywhere (§11.3) — so if a future measurement shows the four sites log in
   entirely first-party, this is worth revisiting as defence in depth. It would never become the
   boundary.
5. **`setPermissionCheckHandler`.** **Unmeasured.** Only `setPermissionRequestHandler` was tested
   (row 7). The check handler answers `navigator.permissions.query` and some paths that never raise a
   request, and E sets it to the same refusal for consistency. _To settle:_ a probe of the same shape
   as §3's permissions row, against the check handler.
6. **Do `WebContentsView` bounds, resize and focus behave acceptably in the real Angular shell?**
   **Unmeasured** (§11.9), and named by the spike as the famously fiddly part. 4.2's design — the
   renderer reports intent, the main process clamps and re-applies on the window's own resize — is
   reasoning. _To settle:_ build the route and use it; this is the one question that cannot be
   answered by a spike more cheaply than by the implementation.
7. **Should `slicers/remote-files.ts` move to `src/remote-files.ts`?** **Answered: yes, but not in
   E** (5.4). Its contents are generic and two subsystems now use them, so the folder is a lie. The
   move touches D's tests and its own docblock and belongs to its own change; E imports it where it
   is and records the debt rather than paying it in a document about browsing.
8. **Is `matchKey` right against a real library?** **Unmeasured** (6.2). The URL shapes were measured
   exhaustively; the key derived from them was never run against a set of real `projects.website`
   values. §9 of the spike states its own recommendation as a consequence of the rows rather than as
   a tested rule, and this document keeps that framing. _To settle:_ run `matchKey` over the
   `website` column of the developer's real library and eyeball the collisions and the misses. One
   query and a script.
9. **Does Cloudflare escalate under sustained use?** **Unmeasured beyond ~40 minutes** (§11.6). Four
   runs never produced an interactive challenge. If it ever does, 1.2's rule is unchanged: the user
   solves it in the view, because a human is driving and the app never attempts a bypass.
10. **Should the browse view keep a per-site scroll position or page across a route change?**
    **Answered: no** (4.3). A hidden live third-party page is a page still running script and still
    able to start a download nobody is watching. The persistent partition keeps what actually matters
    — the login — so the cost is a scroll position, and that is the right trade.
11. **macOS and Linux.** **Unmeasured, entirely** (§11.8). The partition storage path, the download
    path, `WebContentsView` layout and the challenge behaviour are all plausibly platform-sensitive.
    E ships what was measured on Windows 11. _To settle:_ a machine of each and a spike of the same
    shape as this one's.
