# Slicer Project Manager — Subsystem E: the model browser

- **Date:** 2026-08-28
- **Status:** Approved (design); implementation plan pending
- **Parent:** [`2026-08-22-slicer-project-manager-design.md`](2026-08-22-slicer-project-manager-design.md)
  — binding. Where this document and the parent disagree, the parent wins and this one is wrong —
  except at 1.3, where the parent is **corrected in place against a measurement**. D amended the
  parent too, but over a convention (which subsystems get their own spec), not over a measured claim;
  this is the first time a parent statement of fact has been re-measured and found to have the wrong
  reason attached, so the precedent is thinner than "the way D did it" and the correction is written
  to stand on the measurement rather than on the precedent.
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
  spoofing, no challenge solving, no CAPTCHA handling. On the UA, the spike's own words are the
  ceiling of what may be claimed: it was **not shown to matter** (row 28), which is weaker than
  "measured not to matter" and is the wording this document uses everywhere. If a site ever
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
`<iframe>` inside a plain HTTP page carrying no CSP of its own, and **all four of those same URLs
loaded as top-level `WebContentsView`s**, with real titles and real DOM.

`X-Frame-Options` and `frame-ancestors` govern embedding **as a frame**. A `WebContentsView` is a
separate top-level frame tree, not a subframe, so neither header applies to it. So the sentence is
"**a `WebContentsView` is not a frame**", not "the sites allow it". The practical conclusion — the
web build cannot offer this, an embedded native view can — is unchanged, and parent §9 is amended in
place to say so.

**What refused each one, because the one-line version misattributes half of them** — and the parent's
amendment carries this too, since the parent is binding and outlives this document:

| Site        | Framed response                                                                  | Whose header that is                                                               |
| ----------- | -------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| Thingiverse | **403 by Cloudflare**, `x-frame-options: SAMEORIGIN`                             | **The block page's.** The real top-level response for the same URL carried neither |
| Printables  | **403 by Cloudflare**, `x-frame-options: SAMEORIGIN`                             | The block page's                                                                   |
| Cults3D     | 200, `x-frame-options: SAMEORIGIN`, **no CSP header at all**                     | The site's                                                                         |
| MakerWorld  | 200, **both** `x-frame-options: SAMEORIGIN` **and** CSP `frame-ancestors 'none'` | The site's — and naming only the CSP for it is a second, smaller misattribution    |

So "these sites set `X-Frame-Options`" is a true statement about two of the four and a statement
about Cloudflare's block page for the other two. A design that read a site property off the block
page would be reading the wrong thing.

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
| 25  | Is a scripted download distinguishable from a user click?          | **No.** `hasUserGesture()` is `false` for `webContents.downloadURL()` and `true` for a real click — but a scripted click reports whichever `executeJavaScript(source, userGesture)` asked for. See 5.2.                 | §6, §12 |
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

The browse view runs on `persist:spm-browse`. What that buys, stated at the strength the
measurements actually support — **one decisive property, three real but lesser ones, and one item
that is a cost the partition creates rather than a benefit it confers.** The list is written this
way on purpose: a future author arguing to relax the partition should be arguing against the
accurate list, and an inflated one invites the argument "these all turned out to be nothing".

| What                                | Measured                                                                                                                              | What it is actually worth                                                                                                                                                                                                                    |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **`spm://` is not handled there**   | `isProtocolHandled('spm')`: `true` on the default session, `false` on the partition. A top-level navigation rejects `ERR_FAILED (-2)` | **The decisive one, and the only one of the five that changes what a site can reach.** See below                                                                                                                                             |
| Its own `will-download` stream      | Identical listeners on both sessions; only the partition's fired (row 19)                                                             | Real and structural: the browse interceptor cannot capture the app's own `spm://app/_spm/files/<id>/raw` downloads, and nothing on `defaultSession` sees a site's. The two streams cannot be confused because they are not the same stream   |
| Separate cookies and `localStorage` | Verified both directions: a value set in the partition was invisible from a default-session view at the same origin, and vice versa   | **Privacy and a deletable profile, not confidentiality.** A site could not read the app's storage on the default session either — the app's origin is `spm://app` and the same-origin policy already forbids it. Do not claim more than this |
| Separate storage directory          | `…\Roaming\<app>\Partitions\spm-browse` against `…\Roaming\<app>`                                                                     | The browsing profile is one directory the user can delete without touching the app's own state. Operational, not a boundary                                                                                                                  |
| Popups stay inside it               | A popup is created on the opener's session; storage path ended in the opener's partition (§14.2 `p17`)                                | A site's popup does not fall back to `defaultSession` — so the decisive row above covers popups too, without a second mechanism                                                                                                              |
| Its own permission handler          | `setPermissionRequestHandler` on each session fired only for its own view's request                                                   | **A cost, not a benefit.** The partition means the app's existing handling does not apply and E must write one (3.7), or the browse session runs on Electron's defaults. Listing it as a win is how it gets forgotten                        |

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

| Answer  | For                                                                     | Why                                                                                                                                                                                                       |
| ------- | ----------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `allow` | `http:` and `https:`                                                    | This is a browser. The inversion of the renderer's policy, and the reason it is a separate function rather than a flag                                                                                    |
| `allow` | **`blob:` and `data:`**                                                 | **A download depends on it.** See below — this is the arm a first draft of this document got wrong, and the wrongness was measured                                                                        |
| `allow` | `about:blank`                                                           | The deferred-popup idiom opens `about:blank` and assigns `location` afterwards (3.6, I6). Blocking it blocks the open, not the destination                                                                |
| `block` | `spm:`                                                                  | Belt-and-braces behind 3.4: the partition already refuses it with `ERR_FAILED`, and a policy that relies on a session property nothing in `urls.ts` can see is not a policy                               |
| `block` | `file:`                                                                 | **The one arm doing work Chromium does not already do**, and it is not theoretical: a file dropped onto a `webContents` is a `file:` navigation. Blocking it is how a dropped file does not become a page |
| `block` | everything else — `javascript:`, a custom scheme, an unparseable string | Same default as the renderer's: the list worth refusing is open-ended and the list worth allowing is short                                                                                                |

**`blob:` and `data:` must be `allow`, and a first draft of this section had them under the
catch-all `block`.** That draft would have broken downloading from the one site where a download was
ever measured. Row 22 says Thingiverse's download URL **is** a `blob:`, and a scratch app on
Electron 44 measured what the three DOM idioms that can start one actually do:

| Idiom                                     | Hooks that fired                                     | Download starts?   |
| ----------------------------------------- | ---------------------------------------------------- | ------------------ |
| `<a download href="blob:…">` + `.click()` | **none at all**                                      | **yes**            |
| `location.href = blobUrl`, policy on      | `will-frame-navigate` → blocked                      | **no**             |
| `location.href = blobUrl`, policy off     | `will-frame-navigate`, `will-navigate`, both `block` | **yes**, completes |
| `window.open(blobUrl)`, deny-all handler  | `window-open` → deny                                 | **no**             |

The control run is the decisive one: with the policy off, the same navigation produces a completed
download, and with it on the download never starts. So under a `block` for `blob:`, **whether E can
download from a site turns on which of three interchangeable DOM idioms that site's JavaScript
happens to use** — one of which is invisible to every hook and works regardless. That is not a
security property, it is a coin flip presented as one, and the document had presented the `block` as
costless.

Allowing them costs nothing that matters here. A `blob:` or `data:` document is same-origin-ish with
the page that made it and has no preload and no bridge; it cannot reach `spm://` on this partition;
and a navigation to one that is _not_ a download is a page the browse view can display and the user
can navigate away from. The download interceptor (5.1) is what actually decides the outcome, and it
sees the item either way.

**Which hooks enforce this, named**, because §3.9's property 5 turns on getting this list complete and an earlier draft named only one of them, and
`will-navigate` is not the whole surface. Measured on Electron 44:

- **`will-frame-navigate`** fires _first_, for the same URL, and covers subframes. `will-navigate` is
  main-frame only.
- **`will-navigate`** then fires for a main-frame navigation.
- **`will-redirect`** is the one a server-side redirect reaches. Measured with a 302 into
  `bambustudio://open?model=1`: it arrived at `will-redirect` and **not** at `will-navigate`. So
  3.5's custom-scheme arm — which is load-bearing for MakerWorld's only affordance — is enforced
  _there_ or it is not enforced at all.
- **`setWindowOpenHandler`** for a new window (3.6).

All four are attached to the browse view's own `webContents`, and all four consult
`browseNavigationPolicy`. Attaching three of the four is the kind of gap that passes every test
written against the fourth.

**No host allowlist**, and this is a decision rather than an omission. Containment comes from the
partition and the absent preload, not from a list of hostnames; a list would read as if it were the
security boundary while doing none of that work, and it would break real use — a site's own CDN, its
consent-management vendor, and the identity provider a user logs in through are all other hosts, and
5.7 says the login is the user's to perform. **Not measured:** no login was performed anywhere
(§11.3), so "logins go through other hosts" is reasoning about how the web works, not something this
spike observed. It is recorded as an open question (9.4) rather than presented as a finding.

**What this policy is actually for, since as a _filter_ it is the weakest of the three legs.** The
partition (3.4) and the absent preload (3.2) each remove a capability outright. This one mostly
duplicates decisions Chromium already makes: it cannot reach `spm://` on this partition anyway, and
`javascript:` and a bare custom scheme go nowhere useful on their own. Two things are genuinely its
own, and the section should say so rather than let a reader conclude the leg is decorative:

- **`file:`, which nothing else covers.** A file **dropped onto a `webContents`** is a `file:`
  navigation, and Chromium performs it. Without this arm, dragging a file onto the browse view turns
  the user's own disk into a page inside the app — the one concrete thing in this table that is not
  already refused somewhere else.
- **Keeping the renderer's policy _off_ this view.** `navigationPolicy` answers `external` for
  `http(s)` and `applyNavigationPolicy` hands that to `shell.openExternal`. Attached to the browse
  view — which is what a careless reuse of the existing function would do — every link in the model
  browser would fire the user's system browser and the view would never move. This is a **composition
  fix**, and rows 11 and 12 are its measurement: the existing policy does not reach an embedded view,
  and the fix is emphatically not "call the existing one here too".

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

**The handler still does real work that Chromium does not do for us**, and an earlier draft filed
that under "product rather than bridge", which undersells it. With no handler a site puts an
**unchromed top-level `BrowserWindow`** on the user's screen — no address bar, no back button, no
indication it is a site rather than the app, and outside whatever chrome `/browse` draws. Chromium
has no objection to that; the handler is the only thing that does. That is a security-shaped
property (a page that can present itself as the application) and not only a tidiness one.

**But deny-everything is wrong here, and this is where E's handler differs from the renderer's.**

- For a `target="_blank"` link on a model page — `http(s)` — the handler **navigates the browse view
  itself** and returns `{ action: 'deny' }`. The user goes where they expected, inside the chrome,
  with a back button.
- For a **popup the page actually needs to be a popup**, denying breaks a real and common thing:
  sign-in. The dominant idiom is `window.open(idp)` plus `opener.postMessage(...)`, and navigating
  in place destroys both halves — there is no opener left to message and no page left to return to.
  §5.7 makes logging in the user's job and §9.4 leans on identity providers being reachable, so a
  document that requires logins to work and removes the mechanism most of them use is arguing with
  itself.
  Worse, the _deferred_ form is denied by a rule that never considered it: measured, `const w =
window.open(); w.location = url` reaches the handler with the target `about:blank`, which the
  first draft of 3.5 did not list at all and the catch-all therefore blocked. The site never gets
  as far as naming its destination.

**So: `{ action: 'allow' }` for `http(s)`, `about:blank`, `blob:` and `data:` when the page asked
for a named or featured window rather than a plain `_blank` link, with `overrideBrowserWindowOptions`
pinning the trust flags explicitly — `sandbox: true`, `contextIsolation: true`,
`nodeIntegration: false`, `webSecurity: true`, the browse `partition`, and no `preload`. Everything
else is denied.** The measured table is what makes that safe rather than hopeful: a popup never has
a bridge of its own (row 14), it is created on the opener's session so it stays in the browse
partition (row 13, §14.2 `p17`), and `spm://` is not served there — so the one case that could reach
a bridge does not exist. Pinning the options is not decoration: `p11` measured that a
`webPreferences.preload` supplied through this very handler gives a popup a **full live bridge at any
origin**, so this handler is itself one of the two places the bridge can be handed away, and it must
name what it wants rather than inherit it.

**`noopener` is deliberately _not_ forced.** It is measured to sever the opener link (§14.2 `p05`,
`p22`), which is exactly what makes it useless here: `opener.postMessage` is the half of the login
idiom that carries the result back. The reach it severs is a reach that does not exist on this
partition anyway. It stays recorded as the mechanism to use if E ever needs to allow a popup whose
opener _does_ hold a bridge — which, by 3.4, is a configuration this design does not have.

**The popup that _is_ allowed gets no hooks of its own.** The three navigation listeners and the
window-open handler are attached to the browse view's `webContents` and to nothing else, so a popup
approved above is a new `webContents` with neither: it may navigate wherever it likes and open
further windows without E seeing either. That is written down rather than left to be discovered.
Containment does not rest on it — the popup is created on the opener's session and is therefore in
the browse partition (row 13), `spm://` is not served there (row 8), it has no preload of its own
(row 14), and Chromium refuses a renderer-initiated navigation to an unregistered custom scheme
without help from this app. What is missing is the refusal _record_: a scheme blocked inside a popup
produces no `lastError` for the user. Attaching the listeners through `did-create-window` would not
be a copy of the view's — the `navigate` arm loads into the _browse view_, which for a popup would
destroy the sign-in the popup exists to carry — so it needs its own decision table and its own
measurement. 9.19 carries it.

**None of this has been run against a real login.** No account was created anywhere (§11.3), so the
popup arm above is designed from the measured `window.open` table plus knowledge of the idiom, not
from watching a sign-in complete. 9.12 records it and says the settling cost is one hand-driven login
in the view.

### 3.7 The permission handler

Each session needs its own; the default session's handler fired only for the default session's view
(row 7). So a browse partition with none uses Electron's defaults, and **task 2 measured what those
are** rather than leaving it at "not a decision anyone made": in a fresh partition with no handler of
either kind, a page was **granted** geolocation and **granted** notifications with no prompt, and
`navigator.permissions.query({ name: 'geolocation' })` answered `"granted"`.

**`setPermissionRequestHandler` on the browse session denies everything.** A model site needs no
geolocation, no camera, no microphone, no notifications, no MIDI, no clipboard read, no pointer lock
and no persistent storage grant to show a page with a download button on it, and a browser embedded
in a project manager is not the place to start granting them. A denied permission is a degraded page;
a granted one is a capability the user was never asked about, in a window that looks like the app.

`setPermissionCheckHandler` — the synchronous sibling that answers `navigator.permissions.query` and
some checks that never raise a request — is set to the same refusal. ~~Not measured, and set for
consistency.~~ **Withdrawn: task 2 measured it, and it is not merely for consistency — it does work
the request handler does not.** Three partitions on Electron 44.0.0, one variable each: with the
_request_ handler alone, `navigator.permissions.query({ name: 'geolocation' })` answered
**`"granted"`** while the actual geolocation request was denied; with **both**, it answered
`"denied"` and the check handler fired for `media`, `web-app-installation`, `geolocation` and
`notifications`; with **neither**, the query answered `"granted"` and the request was granted
outright. So without the check handler a site reads a granted permission out of an API that never
raises a request, and whatever it draws from that answer is a decision nobody refused. 9.5 is closed
by this; Windows 11 only, as with everything else here.

**Nothing installs a permission handler on `defaultSession`, and the measurement above applies to it
too.** `grep -rn setPermissionRequestHandler packages/desktop/src` returns exactly one hit — the
browse session, above. So the app's own session is the "neither handler" column of that table: a
document on it that asks for geolocation or notifications is **granted, with no prompt**. This is
recorded rather than fixed, and the reason is not that it does not matter. The exposure is bounded by
what is on that session: the main window only ever loads `spm://app`, which is the app's own bundle,
and every remote document E introduces is on the browse partition — so nothing a site controls is in
a position to ask. And the one-line refusal is not free. `packages/web` calls
`navigator.clipboard.writeText` (`users.page.ts:460`), and **whether this Electron raises
`clipboard-sanitized-write` for it is unmeasured** — a blanket deny on `defaultSession` could
therefore remove a working feature, with no Electron-level test in the suite that would notice.
Refusing on the strength of an inference is the mistake this section exists to avoid. 9.20 carries it
with the cost of settling it, and it is the shell's decision to take, not E's.

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

### 3.9 The properties, in one place

An implementer or a reviewer should be able to check these without reading the argument again. Each
one has a measurement behind it and an assertion in 8.3.

1. The browse view is a `WebContentsView` with **no `preload`**, and the main window is never
   navigated to a site.
2. Its `webPreferences` carry **`sandbox: true`, `contextIsolation: true`, `nodeIntegration: false`
   and `webSecurity: true`** — explicitly, not by default. Row 3 proved these are **not sufficient**
   (the compromised configuration had all three of the first ones and a live bridge), which is why
   the document leads with property 1; it does not make them unnecessary. `webSecurity: false` on
   this one constructor would switch off the same-origin policy for third-party content in a process
   that serves the user's files, and **not one assertion in 8.3 as first drafted would have gone
   red**. It is exactly the "one line from being reversed" this section is built around.
3. It is on **`persist:spm-browse`**, and `spm://` is **not** handled on that session.
4. `packages/desktop/src` contains **no** `registerPreloadScript` and **no** `setPreloads`.
5. **All four navigation hooks** — `will-frame-navigate`, `will-navigate`, `will-redirect` and
   `setWindowOpenHandler` — are attached to **the view's own `webContents`** and consult
   `browseNavigationPolicy`, not the renderer's. Three of four is a gap that passes every test
   written against the fourth, and `will-redirect` is the one that carries the custom-scheme case
   (3.5).
6. The browse session has its **own permission handler**, denying everything.
7. **Every string that comes out of the browse view is untrusted data in the renderer** (3.10).

### 3.10 Site-controlled strings cross into the privileged renderer

`BrowseStateDto` and `BrowseDownloadDto` (7.3) carry six fields whose contents a site chooses:
`title`, `url` and `lastError` from the view, and `fileName`, `sourceUrl` and `pageUrl` from the
download. Every one of them is rendered inside `spm://app` — the document that holds the bridge —
and every one of them is written by the other side of the boundary this whole section is about.

Angular escapes interpolated text by default, so the default is safe. **That is a reason to write the
rule down, not a reason to leave it to whoever writes the page**: the safety is a property of one
templating idiom, and the page will want to render a URL as a link and a favicon as an image, which
are precisely the two places the default does not save you.

**The rule.** Values from these two DTOs are rendered **as text only**. Never into `innerHTML`,
`[innerHTML]`, `bypassSecurityTrust*`, a `[href]`, a `[src]`, a CSS `url()`, or a `window.open`. A
`title` is text. A `url` is text — shown, not linked; the way to go somewhere is `browse.navigate`,
which runs the URL through `browseNavigationPolicy` in the main process rather than handing it to
Chromium in the privileged document. And they are truncated for display, because a page can set a
title of any length and the app's own chrome should not be re-laid-out by one.

The same rule already applies to the remote server's strings and to file names off disk; this is the
first place in the app where the author of the string is a deliberate adversary rather than an
accident, which is why it gets a section instead of a habit.

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
  raises while browsing must first **hide** the view — `browse.hide()` / `browse.show()` in 7.3,
  which exist for exactly this and are the reason `detach` is not the answer: `detach` destroys, and
  a modal is not a reason to lose the page the user was on. (A first draft of this sentence said
  "shrink or detach", and offered an API that could do neither without side effects — shrinking to
  zero area is undefined against 4.2's clamp, and detaching throws the page away.)
- **It outlives its route unless something destroys it.** Angular unmounting the `/browse` component
  does nothing to a native view. A view that survives a route change is a site painted over the
  project list — which is not a cosmetic bug, it is a third-party page rendered inside what the user
  reads as the application.

### 4.2 Bounds, and who owns them

The renderer owns the _intent_; the main process owns the _rectangle_.

The `/browse` page renders an empty placeholder element and reports its bounding rectangle, in CSS
pixels, through `browse.setBounds`. The main process converts by the window's current
`zoomFactor`/scale and applies it **inside a rectangle the main process computes for itself**.

**Not "clamped to the content bounds", which was the first draft and does not achieve the property
it was written for.** A rectangle _equal to_ the content bounds **is** the whole window — so that
clamp stops `NaN`, negatives and off-screen values, and does nothing at all about "a site drawn over
the app's own chrome", which is the sentence it was written under. To hold that property the main
process must reserve the chrome band itself: it computes
`allowed = contentBounds minus the browse chrome inset`, a constant the main process owns, and
intersects the renderer's request with it. The renderer cannot widen `allowed`, because it never
names it.

**A minimum area, for the reverse attack.** A renderer that reports `1×1` keeps a live third-party
page running invisibly — which is precisely what 4.3 rejects hiding for, arrived at through the API
4.3 leaves open. So a request below a minimum area is treated as a request to **hide** (7.3's
`hide()`), not honoured as a rectangle: the page stops painting and stops being a thing the user
cannot see but which is nonetheless live. A renderer that wants the view gone still has to say so,
and saying so is a call the shell can act on rather than a geometry it has to interpret.

Reported on: element resize, window resize, and the page's own scroll. The main process also
re-applies on the window's `resize` event, so a resize between two renderer reports never leaves the
view stranded — the renderer's report is the intent and the window's event is the correction.

**This is designed, not measured.** §11.9 is explicit that nothing in the spike touched layout,
resize or focus, and it names this as the famously fiddly part of `WebContentsView`. Whether the
inset-and-intersect actually achieves the property — as against merely being a better-shaped rule
than the clamp — is 9.6, and it is unmeasured.

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

**A download in flight survives the detach, and that is the surprising direction.** Measured on
Electron 44: destroying the owning `WebContentsView` mid-download does **not** cancel an `http`
download. The `DownloadItem` lives on the _session_, `updated` went on firing, and the bytes went on
landing — 2.8 MB on disk at the moment of destruction, 25.9 MB four seconds later.

That is the right behaviour and 4.3 survives it: a user who navigates away from `/browse` while a
21 MB zip is coming down keeps the zip. But it settles two things the first draft left unnamed, and
they have different answers:

- **The `will-download` listener is attached to the _session_, once, for the life of the process —
  not to the view, per attach.** A view-lifetime listener would be removed by `detach`, so a download
  that started before it and completed after would lose its `done` handler and its record would never
  reach a terminal state. The listener is registered when the browse session is first created and
  outlives every view; it is the only thing that can be, given the item outlives the view.
- **After `detach` there is nothing polling** (5.3 polls only while `/browse` is mounted). So the
  completion surface cannot be the browse page. The record is written to disk as it goes (5.3, C2),
  and the app tells the user out of band — the same place 5.2's refusal notice appears — so a
  download that finished while they were elsewhere is offered rather than merely present.

**One useful corollary, measured in the same run:** a 700 MB `blob:` download was already fully
written at the first poll. Blob downloads are effectively instantaneous, because the bytes are
already in the page's memory when `will-download` fires. So for the Thingiverse shape — the one
download that was ever measured end to end — the window in which a detach can catch a download
mid-flight is negligible. The handling above exists for the `http` case, which is Printables and
Cults3D if they turn out to work that way (5.6), and which is unmeasured on those sites.

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

**What it never does:** spoof a user agent (row 28 — **not shown to matter**, which is the spike's
own wording and the strongest claim available: one run spoofed a plain Chrome UA and still saw the
interstitial, another used the default Electron UA and the challenge cleared, and the difference
between the runs was the polling wait rather than the UA. Nobody may re-add spoofing as a fix on the
strength of that row, and nobody may cite it as proof the UA is irrelevant either), retry in a loop,
solve a challenge, or present a
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

**Refused, synchronously: a download past the staging ceiling.** It exists because an unattended
`will-download` is a disk-fill primitive for any page that wants one, and because it is the only
refusal that needs no user input and therefore the only one that fits inside a handler where nothing
can be awaited.

**The numbers are a judgement, and are labelled one rather than presented as measured.** Nothing in
the spike bears on them; they are chosen against the one real download there is — 21 060 699 bytes
(row 20) — so that the honest case is nowhere near the limit and a malicious one hits it quickly:

| Cap                                 | Value | Reasoning                                                                                                                                         |
| ----------------------------------- | ----- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| Concurrent downloads in flight      | 4     | A user clicking download on four models before landing any is plausible; forty is not a user                                                      |
| Total **staged** bytes, all records | 4 GiB | ~200 Thingiverse-sized archives sitting undecided. A real backlog is single digits, and this is a ceiling on undecided files rather than on usage |
| Single download                     | 2 GiB | Above any model archive that has been observed, and below the size at which a staging directory becomes the user's disk problem                   |

They are constants in one place in `packages/desktop`, not settings: a user has no basis for choosing
them and a UI for them would imply the app knows what the right answer is. If a real library ever
pushes against them, that is a measurement and the constants move with it.

**What the user sees, because the page cannot be told.** `preventDefault()` destroys the item by the
next tick (row 21), so nothing is delivered to the site: no error event, no failed download entry, no
DOM change. From the page's point of view the click did nothing, which is indistinguishable from the
Cults3D consent-overlay case (row 30) — so silence here would train a user to believe the feature is
broken. The shell therefore raises the notice itself, out of band, in the same surface 4.3 uses for a
download that completed while the user was elsewhere: which download was refused, which cap it hit,
and a control that discards staged downloads to make room. Without that, the ceiling is a silent
failure mode with a plausible innocent explanation, which is the worst kind.

**Not refused: `hasUserGesture() === false`.** It is recorded on the download record and shown, never
acted on. Row 25 is why: the flag distinguishes `webContents.downloadURL()` from a real click, but a
scripted click reports ~~`false` as well~~ **whichever the driver asked for** — withdrawn and
corrected in task 3, which measured that `executeJavaScript(source, userGesture)` is what decides it
(`packages/desktop/test/browse.spec.ts:665-672`). The rule is unchanged and better justified: the
flag is evidence about how a download started, it can be made to say either thing, and it is never a
verdict. Refusing on it would also silently break sites whose download button is a scripted `blob:`
construction. Which is Thingiverse's, the one download that was actually measured.

### 5.3 Where the bytes go, and the record beside them

`<userData>/model-downloads/<downloadId>/` holds **two** files: the downloaded bytes, and
`download.json` beside them. That is D's per-launch shape, and taking only the first half of it —
which a first draft of this section did, while citing D — is a defect with a measurement behind it.

**Why the record is not optional.** Two independent reasons, and the second is the serious one.

**One: nothing in `BrowseDownloadDto` is recoverable from a directory listing.** 7.3 requires
`sourceUrl`, `pageUrl`, `siteId`, `mimeType`, `totalBytes`, `hadUserGesture`, `startedAt` and a
terminal `state`, and 8.3 requires `browse.downloads()` to answer for a directory found at the next
app start with `isOrphan: true`. The process that knew those values is gone. Only a file can carry
them across, which is exactly the argument `SlicerLaunchRecord`'s docblock already makes — "the app
that created it may have been killed … the only thing that can say which project a returning `.3mf`
belongs to is this file sitting next to it".

**Two: with `setSavePath()` in use there is no marker distinguishing a truncated file from a complete
one.** Measured on Electron 44: Chromium writes **straight to the final path** — no `.crdownload`, no
partial suffix, no sidecar of its own. Destroying the owning view mid-download left `dl2-big.bin` at
**26 214 400 of 41 943 040 bytes**, sitting at its final name, byte-for-byte indistinguishable from a
completed download of a 26 MB file. A sweep with nothing but a directory listing enumerates it, offers
it, and `browse.land` uploads a **truncated archive into the user's project, silently**. That is D's
data-loss class with a corrupt file where D had a deleted one, and D's fix is the one that applies:
a record that outlives the process.

```
download.json
  downloadId, startedAt
  fileName                 the sanitised basename beside this file
  sourceUrl, pageUrl, siteId, mimeType, hadUserGesture
  totalBytes               getTotalBytes() at will-download; 0 when the server sent no length
  state                    'progressing' until done, then 'completed' | 'cancelled' | 'interrupted'
  receivedBytes            last observed; rewritten on the terminal transition, not per tick
  library                  which library this was staged against — D's libraryKeyOf, same reason
```

Written through `json-store.ts` — the atomic `write, fsync, rename` this process already uses for
`state.json` and `slicers.json`, and which exists for precisely this. Written **before**
`setSavePath()` returns, so a kill one millisecond later still leaves a directory that explains
itself; rewritten once on `done`. Not per `updated` tick: that is five writes on a 21 MB download
(row 24) and an fsync each, for a number the poll already has in memory.

**No `version` key**, following `SlicerLaunchRecord`'s reasoning rather than `slicers.json`'s: this
is written once and only ever read, so a reader that does not understand a record can say so from the
fields it finds, and a version gate would help with nothing that is currently foreseeable.

**The sweep refuses what it cannot vouch for.** At start, for each directory:

- No `download.json`, or unparseable → the file is listed as **unverifiable** and cannot be landed.
  It can be discarded, or revealed in local mode. It is never deleted implicitly (D's rule, and the
  whole point of a sweep that enumerates rather than tidies).
- `state` not `'completed'` → same. A record that never reached its terminal transition is a process
  that died mid-download.
- `state: 'completed'` but the bytes on disk do not match the record's size → same, and this is the
  assertion the measurement above exists for. When `totalBytes` is `0` (no `content-length`) the size
  cannot be checked at all, and the file is **unverifiable** rather than assumed good — an unknown
  is not a pass.
- Everything agreeing → an ordinary staged download with `isOrphan: true`.

The filename is `item.getFilename()`. **Not `Content-Disposition`** — row 23: it was an empty string
on the real download, while `getFilename()` was populated and sane in every case measured. Sanitised
through the same rules `files.upload` already applies (core's `safeJoin` refuses separators and
traversal), because the name comes from a remote server.

Progress is real (row 24): `updated` fires repeatedly with `getReceivedBytes()`,
`getPercentComplete()` and `getCurrentBytesPerSecond()` populated, and `done` fires once. The
in-memory record carries them; the `/browse` page polls `browse.downloads()` while it is mounted,
which is the same request/response shape D's session card uses rather than a new event channel.

`getETag()` and `getLastModifiedTime()` came back **empty on every download measured** (row 23), so
nothing in the design may use them — no caching, no "have I downloaded this before" check built on
them, and in particular no integrity check. The record's own `totalBytes` is the only integrity
signal there is, which is why the sweep leans on it and why a `0` there is treated as ignorance.

**Swept at start, never deleted implicitly.** Exactly as D's `sessions.sweepAtStart()` enumerates
unfinished launches and deletes nothing. A user who quit mid-decision gets their file back rather
than losing it silently — and, now, gets told when what came back cannot be trusted.

### 5.4 Landing a download into a project

**Never automatic.** The user names the project, always. 6.3 says why this is not merely caution: the
common case is that nothing matches.

The landing is a `shellCall` — `browse.land(downloadId, projectId, { name })` — and it resolves the
bytes itself. It refuses a download the sweep marked unverifiable (5.3) before it opens anything. In
**local mode** it calls core's `uploadFile` with a `createReadStream` of the staged file, wrapped to
the streaming `UploadBody` core takes. In **remote mode** it calls `remoteUpload` in
`packages/desktop/src/slicers/remote-files.ts`, which posts to `/projects/:id/files` through
`RemoteHost.proxy` with the session cookie, the `UPLOAD_LENGTH_HEADER` the server's quota check
requires, and the percent-encoded name header. `remoteUpload` takes a `ReadableStream` and a size —
**the caller builds the stream**, so the `createReadStream` and the `Readable.toWeb` are E's, the
same way `SlicerSessions` does it; the function does not read a directory for you.

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
they get one `.zip` in the project with no preview and no model rows.

**In local mode there is a remedy and it works today**: unzip into the project folder and rescan.
That needs nothing from E and is correct by the parent's own design — disk is the source of truth for
which files exist (§3.2), a rescan adopts what it finds, classifies it and seeds previews (§3.5), and
dropping files into project folders by hand is a first-class workflow the parent explicitly supports.

**In remote mode there is no remedy at all, and 7.1 ships the capability there anyway.** The first
draft of this section cited the unzip-and-rescan remedy without qualification, which is wrong for half
the users E is enabled for. The project folder is on the server; `canPickLocalFolder` is false in that
column by design (parent §2.4); a rescan there rescans the server's disk, not anything the user can
reach; and the app has **no reveal-in-folder affordance anywhere** — `showItemInFolder` and `openPath`
occur nowhere in `packages/desktop/src` or `packages/web/src`. So a remote user who takes the one
download flow that was measured end to end — the 21 MB Thingiverse zip — gets an opaque file in their
library with no models, no previews and **no route to the contents from inside the app**. Their real
options are to unzip on the machine hosting the server, or to download the model again in their own
browser and upload the pieces, which is the feature not working.

Three ways out were considered:

| Option                                        | Verdict                                                                                                                                                                                                                                                                                       |
| --------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Gate `canBrowseModelSites` to local mode only | **Rejected.** It is a shell capability and the union exists for exactly this row (7.1); and single-file downloads — which is what Printables and Cults3D may well produce (5.6, unmeasured) — work fine remotely. Removing the whole feature to avoid one file shape costs more than it saves |
| Land the archive and say nothing              | **Rejected.** That is what the first draft did by omission                                                                                                                                                                                                                                    |
| **Land the archive and say so, in the UI**    | **Taken for E.** When the landed file is an archive and the mode is remote, the app says the archive cannot be expanded from here and names what that costs. A user who knows is a user who can decide; a user who does not is a user with a broken library entry                             |

**And the honest scoping of extraction changes with it.** Extraction is not a nice-to-have deferred
for tidiness: **it is a precondition for E being fully useful in remote mode**, and 9.1 now says that
rather than filing it under "plausible follow-up". It stays out of E because it is a `core` change and
the C plan's constraint 2 points the other way — it needs a use case that expands an archive into a
project, a quota check over the _expanded_ size, per-entry name-clash handling and a zip-slip guard.
Core has the reader (`files/zip.ts`) and a precedent for walking an archive into a library
(`importCuraManagerZip`), so the shape is known. What has changed is the priority, not the scope.

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

Both docblocks in that file carry a sentence that goes with the flip, and they are **not** the same
sentence — `LOCAL_SHELL_CAPABILITIES`' says "`canBrowseModelSites` stays false until E ships it,
which is a deliberate departure from the spec table: a capability whose feature does not exist lights
up UI that goes nowhere", while `REMOTE_SHELL_CAPABILITIES`' says only "`canBrowseModelSites` is
false until E, as above". Both are edited; quoting the long one for both, as a first draft did, is the
kind of small inaccuracy that sends an implementer looking for text that is not there.

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
   * `url` defaults to the last page of the previous session, then to the registry's start list.
   * That default is **persisted third-party browsing history**, one entry long, in `userData`
   * — so it is named as such, it is cleared with the browse profile, and 9.14 asks whether it
   * should exist at all.
   */
  attach(bounds: BrowseBounds, url?: string): Promise<BrowseStateDto>

  /** Destroys the view. Safe to call when there is none. Called on route teardown (4.3). */
  detach(): Promise<void>

  /**
   * Stops the view painting without destroying it, and puts it back (4.1).
   * **The answer for a modal**, which must not cost the user the page they were on — `detach`
   * would. A hidden view is still live, which is why it is a modal's tool and never a route
   * change's: 4.3 destroys on teardown and that does not change.
   */
  hide(): Promise<void>
  show(): Promise<BrowseStateDto>

  /**
   * CSS pixels in the host page's coordinate space. The shell converts, then intersects with a
   * rectangle it computes itself — never a clamp to the whole content area (4.2). A request below
   * the minimum area is treated as `hide()`, not honoured.
   */
  setBounds(bounds: BrowseBounds): Promise<void>

  /** `browseNavigationPolicy` decides, in the shell — `http(s)`, `blob:`, `data:` (3.5). */
  navigate(url: string): Promise<BrowseStateDto>
  back(): Promise<BrowseStateDto>
  forward(): Promise<BrowseStateDto>
  reload(): Promise<BrowseStateDto>

  /** Polled while `/browse` is mounted: URL, title, loading, history. See 4.5 and 5.3. */
  state(): Promise<BrowseStateDto>

  /** Everything staged, including what previous runs left (5.3). */
  downloads(): Promise<BrowseDownloadDto[]>

  /**
   * The out-of-band record, oldest first, and the dismissal of one entry (E plan decision 7).
   * A refusal appends one and raises a native notification; so does a download that completed
   * while no view was attached. **Not in the first draft of this block** — 9.15 said a surface
   * must exist and deliberately did not design one, and the plan's decision 7 is where it was.
   */
  notices(): Promise<BrowseNoticeDto[]>
  dismissNotice(id: string): Promise<void>

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
  /**
   * The sweep could vouch for the bytes (5.3). **`land` refuses a `false`, and `discard` is the
   * only way out of one.** Not in the first draft of this block: 5.3 already required the sweep
   * to make this judgement, and without a field for it the judgement reached nothing.
   */
  isVerifiable: boolean
}

BrowseNoticeDto {
  id: string
  kind: 'refused' | 'completed'
  /** A remote server's `getFilename()`. Rendered as text only, and arrives truncated. */
  fileName: string
  /** One sentence: for a refusal, which cap it hit. Written by the main process. */
  detail: string
  at: number
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
- **The browse view keeps its four trust flags.** `getLastWebPreferences()` on the _view's_
  `webContents`, expected `sandbox: true`, `contextIsolation: true`, `nodeIntegration: false`,
  `webSecurity: true` — the same instrument `shell.spec.ts:423` uses on the window, for the same
  three flags plus the one that matters most here. 8.2 says this object cannot answer the _preload_
  question; that is not a reason to stop asking it the questions it can answer. Row 3 showed these
  are not **sufficient**; nothing showed they are unnecessary, and without this assertion
  `webSecurity: false` on that one constructor turns nothing red.
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
- **A `blob:` download completes through all three idioms** (3.5): `<a download>` plus `.click()`,
  `location.href = blobUrl`, and `window.open(blobUrl)` — each against a blob the test page builds
  itself, with the policy on. All three must produce a staged download. This is the assertion the
  first draft's `block` for `blob:` would have failed, and it is the one that keeps E's only measured
  download shape working; asserting `browseNavigationPolicy('blob:…') === 'allow'` as a unit test is
  necessary and does **not** substitute for it, because the defect was in which hook sees what.
- **`will-redirect` enforces the policy.** A local server answering 302 into a custom scheme,
  asserted refused. Measured: that redirect reaches `will-redirect` and **not** `will-navigate`
  (3.5), so a suite that only drives `will-navigate` is green with the arm missing.
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
- **The sweep refuses what it cannot vouch for** (5.3), against a temp directory, four cases: no
  `download.json`; an unparseable one; `state: 'progressing'`; and `state: 'completed'` with a file
  **shorter than the recorded `totalBytes`** — the truncation case, which is the one with a
  measurement behind it and which a directory listing cannot see. Each must come back unlandable, and
  `browse.land` must refuse each. Break it by having the sweep trust the listing and confirm a
  truncated archive uploads clean, because that is exactly what the first draft specified.
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

1. **Should a downloaded archive be extracted into the project?** **Answered: not in E, and E is
   incomplete in remote mode because of it** (5.5). It is a `core` change — a use case, a quota check
   over the expanded size, per-entry clash handling and a zip-slip guard — and browsing is a shell
   concern that the C plan's constraint 2 says must not leak into the server. In **local** mode the
   user unzips into the project folder and rescans, which the parent's design (§3.2, §3.5) supports
   as a first-class workflow. In **remote** mode **there is no remedy at all**: the folder is on the
   server, `canPickLocalFolder` is false, a rescan rescans the server's disk, and no
   `showItemInFolder`/`openPath` affordance exists anywhere in the app. So for the one download flow
   ever measured end to end, a remote user gets an opaque file and no route to its contents.
   Extraction is therefore a **precondition for E being fully useful in remote mode**, not a
   nice-to-have; E ships the archive whole and says so in the UI. Core has the reader and a precedent
   (`importCuraManagerZip`), so the shape is known and only the priority changed.
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
5. **`setPermissionCheckHandler`.** ~~Unmeasured.~~ **Answered by task 2's implementation probe, and
   the answer changes why the line exists** (3.7). Three partitions on Electron 44.0.0: request
   handler alone → `navigator.permissions.query({name:'geolocation'})` answers **`"granted"`** while
   the request itself is denied; both handlers → `"denied"`, with the check handler firing for
   `media`, `web-app-installation`, `geolocation` and `notifications`; neither → the query answers
   `"granted"` and the request is granted. It is therefore not "the same refusal for consistency" —
   it is the only thing that answers the query API at all, and `browse.spec.ts` pins it. Windows 11
   only.
6. **Do `WebContentsView` bounds, resize and focus behave acceptably in the real Angular shell?**
   **Unmeasured** (§11.9), and named by the spike as the famously fiddly part. 4.2's design — the
   renderer reports intent, the main process intersects with an inset it computes itself, and a
   sub-minimum request becomes a `hide` — is reasoning, and specifically it is **not established that
   the inset achieves the property it is written for** rather than merely being a better-shaped rule
   than the clamp it replaced. _To settle:_ build the route and use it; this is the one question that
   cannot be answered by a spike more cheaply than by the implementation.
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
12. **Do popup-based logins work under 3.6's handler?** **Unmeasured.** No login was performed
    anywhere (§11.3), so the popup arm is designed from the measured `window.open` table plus
    knowledge of the idiom — including the deferred `window.open()`-then-assign-`location` form,
    which reaches the handler with the target `about:blank` and which a deny-all handler kills before
    the site names its destination. This matters because §5.7 makes logging in the user's job and 9.4
    leans on identity providers being reachable. _To settle:_ one hand-driven sign-in in the view on
    any of the four sites, watching `setWindowOpenHandler`, `did-create-window` and whether the
    result comes back. Cheap, and it settles 9.4 and 9.13 at the same time.
13. **What does a `WebContentsView` popup, as opposed to a `BrowserWindow` popup, do?** **Unmeasured**
    (§14.7). Only `BrowserWindow` popups — what `window.open` actually makes — were measured. If 3.6's
    allow arm is ever reshaped to render a popup inside the app's own frame rather than as a separate
    window, that is a configuration nothing here covers.
14. **Should `attach` remember the last page?** **Unresolved, and it is a privacy question rather than
    a technical one.** 7.3 defaults `url` to the previous session's last page, which is one entry of
    persisted third-party browsing history in `userData` — small, but it is history, and the user did
    not ask for it. It is cleared with the browse profile. _To settle:_ a decision, not a measurement:
    either keep it and say so where the user can see it, or drop it and always open on the registry's
    start list. E ships it because returning to a half-finished search is the common case, and records
    that the argument is not strong.
15. **What tells the user about a download that finished, or was refused, while they were elsewhere?**
    **Designed, not settled** (4.3, 5.2). The item outlives the view and the poll does not, and
    `preventDefault()` tells the page nothing — so both need a surface outside `/browse`. This
    document says one must exist and does not design it, because that is a UI question about the whole
    app's notification surface rather than about browsing, and the app does not currently have one.
16. **Where does the download record belong if a second subsystem ever wants one?** `download.json`
    beside the bytes (5.3) is D's shape and the right one for E. If a third staging area appears, the
    sweep-and-verify logic will exist three times. Recorded now because that is the moment to extract
    it, and not before.
17. **Which download idiom do the other three sites use?** **Answered for the policy, open for the
    sites.** 3.5 measures what all three idioms do under both policies and allows `blob:`/`data:` so
    that none of them turns on a coin flip — but only Thingiverse's shape was ever observed, and it is
    a `blob:` built by script. Whether Printables serves a plain `https` redirect, a signed URL or a
    blob is unmeasured (§11.4) and would change nothing in the policy; it would change what 4.3's
    in-flight handling is exercised by, since a blob download is effectively instantaneous and an
    `https` one is not. _To settle:_ folded into 9.2.
18. **Are the staging caps the right numbers?** **A judgement, labelled as one** (5.2): 4 concurrent,
    4 GiB staged, 2 GiB single, chosen against the one real download there is (21 060 699 bytes) so
    that an honest backlog is nowhere near them. Nothing measured bears on them. _To settle:_ they are
    constants in one place; if a real library pushes against them that is the measurement, and the
    constants move with it.
19. **Should the popup the window-open handler allows be policed too?** **Open, and named in 3.6
    rather than left silent.** An allowed popup is a `webContents` with no navigation policy and no
    window-open handler of its own; containment holds without them (browse partition, no `spm://`,
    no preload, and Chromium's own refusal of unregistered schemes), and what is missing is the
    refusal record and a second line behind Chromium's. _To settle:_ it is not a copy of the view's
    hooks — the `navigate` arm loads into the browse view, which for a popup would destroy the
    sign-in it exists to carry — so it needs its own decision table, and the measurement that
    motivates one is a real login (9.12) showing what a popup actually navigates to.
20. **Should `defaultSession` have a permission handler?** **Open. The exposure is measured and
    written down (3.7); the fix is not taken here.** The app installs none, so its own session is
    the "neither handler" case: geolocation and notifications are granted with no prompt. Bounded by
    the main window only ever loading `spm://app`. _To settle:_ one run with a _recording_ handler on
    `defaultSession` while the app is exercised, to learn which permissions the app's own renderer
    raises — `navigator.clipboard.writeText` in `users.page.ts:460` is the only known candidate and
    it is **unmeasured** whether it raises `clipboard-sanitized-write` at all. A blanket deny written
    without that reading is a change that can remove a working feature with nothing to catch it.
