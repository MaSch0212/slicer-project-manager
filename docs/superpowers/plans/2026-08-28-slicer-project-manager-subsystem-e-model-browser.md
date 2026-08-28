# Slicer Project Manager — Subsystem E: the model browser

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to
> implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** put a real browser inside the desktop app, pointed at the four model sites, so a user can
find a model and land its download into a project without leaving the app — and contain that
browser, because it is arbitrary third-party web content running inside a process whose renderer
holds an IPC bridge to the user's filesystem.

**Architecture:** everything that browses lives in `packages/desktop` — a `WebContentsView` on
`persist:spm-browse` with no preload, its own four navigation hooks, its own window-open handler,
its own permission handler, its own `will-download` stream, a staging directory under `userData`
with a `download.json` beside every download, and a landing path that streams bytes into
`files.upload` without them ever crossing IPC. `packages/contract` gains a `browse` block on
`ApiClient`, reached over `SHELL_CLIENT` because browsing is a property of the machine and must
work in both library modes, plus one pure `matchKey`. `packages/web` gains one electron-only route,
one page and one capability-gated link. **`packages/core` is not touched at all.**

**Spec:**
[`2026-08-28-slicer-project-manager-subsystem-e-model-browser.md`](../specs/2026-08-28-slicer-project-manager-subsystem-e-model-browser.md)
— references of the form "spec 3.4" are to it. Its parent,
[`2026-08-22-slicer-project-manager-design.md`](../specs/2026-08-22-slicer-project-manager-design.md),
is binding: where E and the parent disagree, the parent wins — except at spec 1.3, where the parent
is corrected in place against a measurement.

**Measurements:** `.superpowers/spikes/2026-08-28-model-browser-facts.md`, both probe runs plus §14,
on one Windows 11 machine against Electron 44.0.0, Chromium 152.0.7977.54, and the four live sites.

**Prior plans:** [A](2026-08-22-slicer-project-manager-subsystem-a.md),
[B1](2026-08-23-slicer-project-manager-subsystem-b1-rasterizer.md),
[B1 follow-ups](2026-08-24-slicer-project-manager-b1-followups.md),
[B2](2026-08-25-slicer-project-manager-subsystem-b2-viewer.md),
[C](2026-08-26-slicer-project-manager-subsystem-c-electron.md),
[D](2026-08-28-slicer-project-manager-subsystem-d-slicers.md).

---

## What was measured before this plan was written

Every row was run and observed on Electron 44.0.0, not read in vendor documentation. **A task that
contradicts one of these is wrong.**

| Question                                                        | Measured                                                                                                                                                                                 |
| --------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Which embedding primitive is current?                           | **`WebContentsView`.** `BrowserView` carries `@deprecated` on every member; `<webview>` is off by default and its own types warn its preload gets Node                                   |
| Does a bare `WebContentsView` reach `window.spm`?               | **No.** `typeof window.spm === "undefined"`, `Object.keys` empty, no `require`, no `process`, read at a third-party origin                                                               |
| Can it be handed the bridge by mistake?                         | **Yes, in one line.** Given `webPreferences.preload`, a sandboxed context-isolated view at a third-party origin got `typeof window.spm === 'object'` and reached `ipcMain`               |
| Is there a second, invisible way to hand it over?               | **Yes.** `session.registerPreloadScript({type:'frame'})` on `defaultSession` reached a `WebContentsView` created **afterwards**; the same probe on another partition: undefined          |
| Does `getLastWebPreferences()` report `preload`?                | **No.** 15 keys, `preload` not among them, byte-identical for the bridge-holding window and a bridge-less view. `shell.spec.ts`'s instrument cannot answer this                          |
| Does a bare view get its own session?                           | **No — `defaultSession`**, the same one the app renderer is on                                                                                                                           |
| Is `spm://` reachable from `persist:spm-browse`?                | **No.** `isProtocolHandled('spm')` true on default, false on the partition; a top-level navigation rejects `ERR_FAILED (-2)`                                                             |
| …and from a view on the **default** session?                    | **A top-level navigation succeeds.** `fetch()` fails on both. The partition is the discriminator for **navigation**, not for fetch                                                       |
| Could the partition be given `spm://` anyway?                   | **Yes** — `browseSession.protocol.handle('spm', …)` succeeds. It is a property to keep on purpose                                                                                        |
| Does the window-level navigation policy cover an embedded view? | **No.** With `applyNavigationPolicy(window)` attached exactly as `app.ts` does it, `loadURL` and an in-page `location.href` in the view both completed with an **empty hook log**        |
| …attached to the view's own `webContents`?                      | **Yes.** The same function logged `will-navigate` and the view stayed put                                                                                                                |
| Which hooks see what?                                           | `will-frame-navigate` fires first and covers subframes; `will-navigate` is main-frame only; a **302 into a custom scheme reached `will-redirect` and not `will-navigate`**               |
| Does a popup inherit the opener's preload?                      | **Never.** 20 popups across 21 variants, all `undefined`; `did-create-window` hands over merged options with no `preload` key. What a popup has is `window.opener.spm`, same-origin only |
| Where is a popup created?                                       | **On the opener's session** — partition preserved, security flags inherited, no bridge. With a handler installed, zero windows                                                           |
| Does `will-download` fire inside embedded content, and where?   | **Yes**, and on **the view's own session and only that one**. Identical listeners on `defaultSession` and the partition; only the partition's fired                                      |
| Does `setSavePath()` redirect a real download?                  | **Yes.** Thingiverse "Download all files" → `completed`, **21 060 699 bytes** at the chosen path, ZIP magic `504b0304`, and nothing in the user's Downloads folder                       |
| Can a download be refused?                                      | **Yes** — `preventDefault()` wrote nothing and the item was destroyed by the next tick. **All-or-nothing, decided synchronously in the handler**                                         |
| Is the download URL re-requestable?                             | **No.** Thingiverse's `getURL()` and whole chain were one `blob:`. "Capture the URL, fetch it later" fails there                                                                         |
| Which `<a download>` idiom does the policy see?                 | `<a download href="blob:…">` + `.click()` fired **no hook at all** and downloaded; `location.href = blobUrl` was **blocked** by the policy; `window.open(blobUrl)` hit the handler       |
| Is there a truncation marker?                                   | **No.** Chromium writes straight to the final path — no `.crdownload`, no sidecar. Measured **26 214 400 of 41 943 040 bytes** at the final name after a mid-download destroy            |
| Does a download survive its view being destroyed?               | **Yes.** The `DownloadItem` lives on the session; `updated` went on firing and bytes went on landing four seconds after the view was gone                                                |
| Where does the filename come from?                              | **`getFilename()`.** `getContentDisposition()` was an **empty string** on the real download; `getETag()` and `getLastModifiedTime()` were empty on every download measured               |
| Do the four sites load as top-level views?                      | **Yes, all four**, with real titles — the same four URLs that were refused as iframes. A `WebContentsView` is not a frame                                                                |
| Is there an interstitial, and does it clear?                    | **Printables 5 573 ms, Cults3D 6 374 ms** under a 2 s poll, from a Cloudflare 403. **No CAPTCHA was presented and none was solved.** The UA was **not shown to matter**                  |
| What is stable in a model URL?                                  | `thing:<id>`; `/model/<id>-<slug>`; `/models/<id>-<slug>` with locale as a path segment; and for Cults3D **the last path segment only** — the whole path translates across 8 locales     |

**Three rows carry the whole security argument and are repeated as global constraints 8, 10 and 11**
because a reviewer sees only the diff, the task text and those constraints.

---

## Scope

| In this plan                                                                    | Not in this plan                                        |
| ------------------------------------------------------------------------------- | ------------------------------------------------------- |
| `browseNavigationPolicy`, the site registry, `matchKey`                         | Any change under `packages/core`                        |
| The `WebContentsView`, its partition, its four hooks, its permission handler    | Automating a login or storing a third-party credential  |
| Bounds, attach/detach/hide/show, and the three lifecycle backstops              | Anything that would defeat bot protection or a CAPTCHA  |
| `will-download` interception, the staging caps, `download.json`, the sweep      | Extracting a downloaded archive into a project          |
| `browse.land` through `files.upload` / `remoteUpload`, bytes never crossing IPC | Scraping, bulk download, metadata harvesting, site APIs |
| `/browse`, the `canBrowseModelSites` flip, the CI bundle-grep pair              | macOS and Linux                                         |

**Deliberately deferred, with reasons:**

- **Archive extraction.** Spec 9.1 is explicit that this is **not** a nice-to-have: it is a
  precondition for E being fully useful in **remote** mode, because the project folder is on the
  server, `canPickLocalFolder` is false in that column, a rescan rescans the server's disk, and the
  app has **no** `showItemInFolder` or `openPath` affordance anywhere (verified: neither identifier
  occurs in `packages/desktop/src` or `packages/web/src`). It stays out of E because it is a `core`
  change — a use case, a quota check over the _expanded_ size, per-entry clash handling and a
  zip-slip guard — and the C plan's constraint 2 says browsing must not leak into the server. E
  ships the archive whole **and says so in the UI** (task 5), which is the obligation that comes
  with the deferral.
- **macOS and Linux.** Every measurement was taken on Windows 11. The partition storage path, the
  download path, `WebContentsView` layout and the challenge behaviour are all plausibly
  platform-sensitive. E ships what was measured and says so.
- **A host allowlist.** Rejected rather than postponed. Containment is the partition and the absent
  preload; a hostname list would read as if it were the boundary while doing none of that work, and
  it would break a site's CDN, its consent vendor and any identity provider a login goes through.
- **Moving `slicers/remote-files.ts` to `src/remote-files.ts`.** Two subsystems now use it and the
  folder is a lie, but the move touches D's tests and its own docblock. E imports it where it is and
  records the debt (spec 9.7).

---

## Global constraints

A reviewer should treat a violation as a defect regardless of what a task says. 1–7 are carried from
the C and D plans and still bind; 8–15 are E's own, and 8, 10 and 11 are the three legs the whole
subsystem rests on.

1. **The renderer is the existing Angular app, unmodified except at the named seams** —
   `API_CLIENT`, `SHELL_CLIENT` (`packages/web/src/app/features/desktop/shell-client.token.ts`),
   `routes.electron.ts`, one capability-gated link in `packages/web/src/app/app.ts`, and the new
   page under `features/desktop/browse/`. A component that has to know it is running in Electron is
   a design failure.
2. **No change to how the Deno server behaves, and no edit under `packages/core` at all.** No route
   is added, no DTO changes shape, no core module is added or edited. Assert it (task 4).
3. **The main process is the only thing that touches the filesystem, the database or a subprocess.**
   The main window keeps `nodeIntegration: false`, `contextIsolation: true`, `sandbox: true`, and it
   is **never navigated to a model site**: `/browse` is a `spm://app` route hosting a native sibling
   view, not a page the window navigates to.
4. **Every IPC channel validates its input in the main process, and the renderer never names a
   filesystem location.** `browse.land` takes a `downloadId` and a `projectId`, never a path. The
   preload already strips `localPath` from every argument at every depth
   (`packages/desktop/src/sanitise-args.ts`) — no change to that file is needed and no exception is
   added.
5. **Errors keep their identity across the boundary.** `AppError.code` survives; a refusal arrives
   as an `AppError` the UI can switch on.
6. **`deno task verify` stays green**, and the contract typechecks at the end of every task — see
   decision 3 on why the `browse` interface grows in three instalments rather than one.
7. **Every assertion must be able to fail** — break the code it covers, confirm red, restore.
8. **The browse view never gets a preload.** Measured both ways: bare it cannot see `window.spm`;
   given one, a third-party page called `invoke()` and got a real `ipcMain` answer. The view is
   constructed in **exactly one place**, and that constructor's `webPreferences` names `partition`,
   `sandbox: true`, `contextIsolation: true`, `nodeIntegration: false` and `webSecurity: true` and
   **nothing else**. A helper that spreads the main window's `webPreferences` into it is the defect.
9. **The assertion that catches a regression in 8 is not `getLastWebPreferences()`.** That object
   has 15 keys and `preload` is not one of them, and it is byte-identical for the bridge-holding
   window and a bridge-less view — so a test that reads it to assert "no preload" passes in the
   exact configuration measured to hand `ipcMain` to a model site. The only instrument that answered
   is `typeof window.spm` read **inside the embedded document**.
10. **`packages/desktop/src` contains no `registerPreloadScript` and no `setPreloads`.**
    `registerPreloadScript` on `defaultSession` reached a `WebContentsView` created **afterwards** on
    that session, and `ses.setPreloads` is deprecated in favour of it in this Electron's own types —
    so a plausible tidy-up ("move the preload off `webPreferences`, the session API is the modern
    one") is a direct route into handing the bridge to the browser, arrived at by someone following a
    deprecation notice. Neither identifier occurs in the tree today; task 2 asserts they never do.
11. **The browse view is on `persist:spm-browse`, `spm://` is never registered on that session, and
    all four navigation hooks are attached to the view's own `webContents`.** The four are
    `will-frame-navigate`, `will-navigate`, `will-redirect` and `setWindowOpenHandler`, and all four
    consult `browseNavigationPolicy` — **never** `navigationPolicy`, which answers `external` for
    `http(s)` and would fire the user's system browser for every link in the model browser. Attaching
    three of the four is the kind of gap that passes every test written against the fourth, and
    `will-redirect` is the one a server-side redirect into a custom scheme actually reaches.
12. **`blob:`, `data:` and `about:blank` are allowed** by both the policy and the window-open
    handler. The only download this project has ever completed came down a `blob:` URL, and a naive
    `http(s)`-only policy blocks it. Measured: with the policy off the same navigation completes a
    download and with an `http(s)`-only policy on it never starts, while the `<a download>` idiom
    fires no hook at all and downloads regardless — so a `block` there makes whether E can download
    from a site turn on which of three interchangeable DOM idioms that site happens to use.
13. **Every string that comes out of the browse view is untrusted data in the renderer.** `title`,
    `url`, `lastError`, `fileName`, `sourceUrl` and `pageUrl` are rendered **as text only** — never
    into `innerHTML`, `[innerHTML]`, `bypassSecurityTrust*`, a `[href]`, a `[src]`, a CSS `url()` or
    a `window.open` — and truncated for display. The way to go somewhere is `browse.navigate`, which
    runs the URL through `browseNavigationPolicy` in the main process.
14. **A staged download is unlandable unless its record vouches for it.** A truncated download is
    byte-for-byte indistinguishable from a complete one — measured at 26 214 400 of 41 943 040 bytes
    sitting at its final name with no marker of any kind — so the sweep refuses four cases: no
    `download.json`, an unparseable one, a non-terminal `state`, and a size mismatch. **`totalBytes:
0` is unverifiable, not a pass.**
15. **The sweep surfaces and never deletes.** A staged download from a previous run is a decision the
    user has not made yet, not litter. `discard` is the only thing that removes one, and a landed
    download's directory goes only after the upload has returned.

---

## Decisions taken up front

1. **`browseNavigationPolicy` is a second exported function in `urls.ts`, beside `navigationPolicy`
   and tested the same way.** _Rejected:_ a mode parameter or a flag on the existing function. The
   two policies **invert** on the arm that matters — the renderer's sends `http(s)` to
   `shell.openExternal`, and a browser that did that would never move — so a shared function would
   be one `if` away from a browse view whose every link fires the system browser.
2. **`blob:`, `data:` and `about:blank` are `allow`; `spm:`, `file:` and everything else are
   `block`.** _Rejected:_ the `http(s)`-only catch-all that a first draft of the spec had, measured
   to break the one download shape this project has ever completed. The `file:` arm is the one doing
   work Chromium does not already do: a file **dropped onto a `webContents`** is a `file:`
   navigation, and blocking it is how a dropped file does not become a page inside the app.
3. **The `browse` interface grows in three instalments, one per task that implements it.**
   `DispatchTable` is a mapped type over `ApiClient`, so a method added to the interface without a
   dispatch entry fails `deno task typecheck` — which is the guarantee we want, and which means each
   contract addition must be atomic with its implementation. Task 2 adds the eleven view methods,
   task 3 adds `downloads` / `discard` / `notices` / `dismissNotice`, task 4 adds `land`. _Rejected:_
   the whole block in task 2, which leaves two tasks' worth of red typecheck.
4. **The `will-download` listener is attached to the browse **session**, once, when the session is
   first created, and it outlives every view.** Measured: destroying the owning view mid-download
   does not cancel an `http` download — the item lives on the session, `updated` went on firing and
   bytes went on landing. A view-lifetime listener would be removed by `detach`, so a download that
   started before it and finished after would lose its `done` handler and its record would never
   reach a terminal state. _Rejected:_ registering it per `attach`.
5. **`download.json` beside the bytes, written through `json-store.ts` before `setSavePath()`
   returns and rewritten once on `done`.** _Rejected:_ a sweep over a directory listing, which is
   what the spec's first draft specified and which cannot see the truncation case at all (constraint
   14). Also rejected: a rewrite per `updated` tick — five fsyncs on a 21 MB download for a number
   the poll already has in memory.
6. **No `version` key in `download.json`**, following `SlicerLaunchRecord`'s reasoning rather than
   `slicers.json`'s: it is written once and only ever read, so a reader that does not understand a
   record can say so from the fields it finds.
7. **The out-of-band surface is `browse.notices()` plus a native Electron `Notification`.** Spec 9.15
   says a surface must exist and deliberately does not design one, and two task bullets need it: a
   download that completed while the user was elsewhere (nothing polls after `detach`), and a refusal
   (`preventDefault()` destroys the item, so the page gets no error, no failed entry and no DOM
   change — indistinguishable from a consent overlay eating the click). _Rejected:_ a badge in the
   shared app nav — `packages/web/src/app/app.ts` is shared code and cannot import `SHELL_CLIENT`
   from `features/desktop/`. _Rejected:_ silence, which trains a user to believe the feature is
   broken. The notification is the promptness and the list is the record, the same shape D gave its
   watch-versus-poll rule.
8. **The last-page memory is one entry in `browse.json` under `userData`, written through
   `json-store.ts`.** _Rejected:_ a fourth key in `state.json` (D decision 4's reasoning, unchanged).
   **And the spec's own docblock is corrected here:** spec 7.3 says that entry is "cleared with the
   browse profile", which is not true of a file under `userData` — deleting
   `…\Partitions\spm-browse` leaves it. It is deleted by `browse.clearLastPage()`, which task 2 adds
   for exactly this reason, and spec 9.14 stays open on whether it should exist at all.
9. **`matchKey` is a pure function in `packages/contract`, and matching runs in the renderer over
   `projects.list`.** `ProjectDto` already carries `website`, and the page needs the full project
   list anyway for its picker. _Rejected:_ a `website` filter on `ProjectQuery` (a change to the
   server's observable behaviour, constraint 2, for a filter that saves nothing); a normalised column
   in `core` (a column, a migration and a backfill for a rule spec 6.2 admits is derived rather than
   measured); and matching in the main process (two call sites for one list).
10. **The source assertion for constraint 10 is a `node --test` walk of `packages/desktop/src`, not a
    CI bundle grep.** CI's four existing grep pairs check **built web bundles** for an exported class
    name; `registerPreloadScript` is a main-process identifier that is not in those bundles under any
    circumstances, so the established instrument answers a different question. _Rejected:_ adding a
    sixth CI grep pair over `dist`.
11. **Bounds are inset-and-intersect, and a sub-minimum request means `hide`.** The main process
    computes `allowed = contentBounds minus BROWSE_CHROME_INSET`, a constant it owns and the renderer
    never names, and intersects the renderer's request with it. _Rejected:_ clamping to the content
    bounds, which is what a first draft said and which achieves nothing it was written for — a
    rectangle _equal to_ the content bounds **is** the whole window, so the clamp stops `NaN` and
    negatives and does nothing at all about a site painted over the app's own chrome.
12. **`{ action: 'allow' }` for a genuine popup, `deny`-and-navigate-in-place for a `_blank` link,
    with `overrideBrowserWindowOptions` pinning the trust flags explicitly.** _Rejected:_
    deny-everything, which kills the dominant sign-in idiom (`window.open(idp)` plus
    `opener.postMessage`) that spec 5.7 and 9.4 both lean on, and which kills the **deferred** form —
    `const w = window.open(); w.location = url` reaches the handler with the target `about:blank`,
    before the site has named its destination. _Rejected:_ forcing `noopener`, which severs the half
    of the login idiom that carries the result back, to remove a reach that does not exist on this
    partition anyway.

---

## Tasks

Five tasks. The split follows the dependency edges the code actually has: task 1 is pure, Electron-
free and dual-testable, and nothing above it can be written without it; task 2 is the contained view,
which every later task assumes; task 3 hangs off the session task 2 created; task 4 hangs off the
record task 3 writes; task 5 is the only Angular diff and the only thing that lights the capability
up. **Between tasks 2 and 5 the shell can create a browse view that no route reaches** — that is
stated rather than hidden, and task 5 closes it.

Two notes on form, learned the hard way in D: Prettier reflows markdown, and it is **not idempotent
for tables, fenced blocks or sub-lists nested inside a `- [ ]` item** — it re-indents them further on
every pass, so `deno task fmt:check` can never go green. Every table and code block below therefore
sits at column 0 between list segments, and no list is nested.

### Task 1 — `browseNavigationPolicy`, the site registry, and `matchKey`

Pure. Nothing in this task imports `electron`, so all of it runs under `node --test`
(`deno task test:desktop:unit`) and `deno task test:contract`.

- [ ] Add `browseNavigationPolicy(url: string): 'allow' | 'block'` to
      `packages/desktop/src/urls.ts`, beside the existing `navigationPolicy` and exported the same
      way. **Two answers, not three:** the renderer's third answer is `external`, which hands a URL
      to `shell.openExternal`, and a browse view that did that would fire the system browser for
      every link and never move. The arms are the table below.

| Answer  | For                                                                       |
| ------- | ------------------------------------------------------------------------- |
| `allow` | `http:` and `https:`                                                      |
| `allow` | `blob:` and `data:`                                                       |
| `allow` | `about:blank`                                                             |
| `block` | `spm:`                                                                    |
| `block` | `file:`                                                                   |
| `block` | everything else — `javascript:`, any custom scheme, an unparseable string |

- [ ] Write the reasoning into `browseNavigationPolicy`'s docblock, in the shape `navigationPolicy`'s
      already has: that `blob:`/`data:` are load-bearing because the one download this project ever
      completed came down a `blob:` URL and an `http(s)`-only policy stops it; that `about:blank` is
      the deferred-popup idiom's target and blocking it blocks the open rather than the destination;
      that `spm:` is belt-and-braces behind the partition, which already refuses it with `ERR_FAILED`;
      that `file:` is the one arm doing work Chromium does not already do, because a file **dropped
      onto a `webContents`** is a `file:` navigation; and that the custom-scheme block is the
      measured-ignorance answer for MakerWorld's `Open in Bambu Studio`, whose behaviour was never
      measured (spec 9.3).
- [ ] `packages/desktop/src/browse/registry.ts`: a static table, one row per site, code and not
      configuration, the same shape and the same reasoning as D's slicer registry. The type is the
      block below and the four rows are the four sites the spike measured. It drives the start page,
      the URL matching, and the label a download is attributed to — and **it does not restrict
      navigation.** Nothing stops a user typing another URL; they simply get no site identity.

```ts
export type ModelSiteDef = {
  id: 'thingiverse' | 'printables' | 'makerworld' | 'cults3d'
  displayName: string
  /** Matched against a URL's host with a leading `www.` stripped, lowercased. */
  hosts: string[]
  /** Where "browse this site" starts. */
  homeUrl: string
  /** Returns the site-stable identity of a model URL, or null if this is not one. */
  identity(url: URL): string | null
}
```

| id            | hosts             | homeUrl                        | identity                                                    |
| ------------- | ----------------- | ------------------------------ | ----------------------------------------------------------- |
| `thingiverse` | `thingiverse.com` | `https://www.thingiverse.com/` | the `<id>` in a `/thing:<id>` path segment                  |
| `printables`  | `printables.com`  | `https://www.printables.com/`  | the `<id>` in `/model/<id>-<slug>`                          |
| `makerworld`  | `makerworld.com`  | `https://makerworld.com/`      | the `<id>` in `/models/<id>-<slug>`, locale segment ignored |
| `cults3d`     | `cults3d.com`     | `https://cults3d.com/`         | the **final path segment**, percent-decoded, lowercased     |

- [ ] `packages/contract/src/match-key.ts`: `matchKey(url: string, sites: ModelSiteIdentity[])` —
      lowercase the host, strip a leading `www.`, **drop the query and the fragment entirely**, then
      use the matching site's identity prefixed with its id (`"thingiverse:7401409"`), falling back to
      lowercased `host + pathname` with a trailing slash removed. Export it from
      `packages/contract/src/index.ts`. It is in `contract` because it belongs beside the schema that
      validates the URL it parses (`schemas.ts`'s `z.url()` on `website`) and because the renderer is
      the only caller. **It adds no method to `ApiClient`**, so the contract still typechecks with no
      dispatch change.
- [ ] Every clause of `matchKey` answers a measured row, and the docblock says which: query and
      fragment go because Printables puts the locale in `?lang=de` and MakerWorld appends
      `?from=recommend` and a `#profileId-<n>` fragment at runtime; a per-site identity rather than
      `host + pathname` because a naive path match fails on exactly the two sites with `hreflang`
      alternates; Cults3D is the final segment alone because **both** the type segment and the
      category segment translate per locale and the category also differs per model; `<id>-<slug>`
      matches on the id because the slug derives from the title.
- [ ] The docblock must also say, in these words or their equivalent, that **this is a consequence of
      the measured rows and not a rule that was tested** against real `projects.website` values (spec
      9.8). Do not upgrade it to a certainty.
- [ ] Tests, the policy: every arm of the table above, each asserted by value —
      `https://www.thingiverse.com/thing:1` allow, `blob:https://www.thingiverse.com/ae5e-…` allow,
      `data:text/html,x` allow, `about:blank` allow, `spm://app/` block, `spm://app/_spm/files/1/raw`
      block, `file:///C:/Users/x/secret.stl` block, `javascript:alert(1)` block,
      `bambustudio://open?model=1` block, and the string `not a url` block. Then assert
      `navigationPolicy('https://example.com/') === 'external'` in the same file, so the two functions
      are visibly different and a later merge of them goes red.
- [ ] Tests, `matchKey`, exhaustively over the spike's own URLs as fixtures — this is the only
      coverage the derived rule will ever get. All of the following must hold: the four canonical
      forms map to their four keys; `https://www.thingiverse.com/thing:7401409/files`,
      `/comments`, `/apps` and `/makes` all map to `thingiverse:7401409`;
      `https://www.printables.com/model/1807378-universal-clip-self-tightening?lang=de` and the
      un-suffixed form map to the same key; `https://makerworld.com/de/models/2093108-dji-neo-2-the-box`,
      `.../en/models/2093108-dji-neo-2-the-box?from=recommend` and `...#profileId-9` all map to
      `makerworld:2093108`; `https://cults3d.com/en/3d-model/various/hyper-hopper`,
      `/de/modell-3d/verschiedene/hyper-hopper`, `/ja/3d-moderu/iroiro/hyper-hopper` and
      `/zh/3d-m%C3%B3x%C3%ADng/du%C5%8Dxi%C3%A0ng/hyper-hopper` all map to `cults3d:hyper-hopper`;
      and `https://example.com/some/path/` falls back to `example.com/some/path`. Then delete the
      query-dropping clause and confirm the Printables and MakerWorld rows go red.
- [ ] Tests, the registry: every `hosts` entry is lowercase and carries no `www.`; every `homeUrl`
      parses and is `https:`; and `identity()` returns `null` for the site's own home URL, because a
      home page is not a model.

**Interface handed to tasks 2–5 (an asserted invariant, not a summary — in D the launch record's
field list was handed over verbatim for exactly this reason and still drifted by four fields):**
`browseNavigationPolicy(url: string): 'allow' | 'block'` from `packages/desktop/src/urls.ts`;
`ModelSiteDef` and the four-row table from `packages/desktop/src/browse/registry.ts`; and
`matchKey` from `@spm/contract`. The controller hands the exact exported signatures to the next task.

### Task 2 — The contained view

Main process only, plus the contract instalment that makes it reachable. This task carries all three
legs of the containment (constraints 8, 10, 11) and the whole of spec §3.

- [ ] `packages/desktop/src/browse/host.ts`: a `BrowseHost` class holding **at most one**
      `WebContentsView` for the shell, created in **exactly one place** in this file. The constructor
      call takes `webPreferences: { partition: 'persist:spm-browse', sandbox: true, contextIsolation:
true, nodeIntegration: false, webSecurity: true }` and **nothing else** — no `preload`, no
      `additionalArguments`, and no spread of the main window's `webPreferences` (constraint 8).
- [ ] The browse session is obtained once, with `session.fromPartition('persist:spm-browse')`, and
      **`protocol.handle` is never called on it.** `browseSession.protocol.handle('spm', …)` is
      measured to succeed, so this is a property kept on purpose and not one the platform enforces.
      Say so in a comment where a future author would otherwise add it.
- [ ] Attach all four navigation hooks to **the view's own `webContents`** (constraint 11), each
      consulting `browseNavigationPolicy` from task 1: `will-frame-navigate` (fires first, covers
      subframes), `will-navigate` (main frame only), `will-redirect` (**the only hook a 302 into a
      custom scheme reaches — measured, it did not reach `will-navigate`**), and
      `setWindowOpenHandler`. Do not call `applyNavigationPolicy` on the view: it hooks
      `window.webContents`, and with it attached exactly as `app.ts` does it a `loadURL` and an
      in-page `location.href` inside an embedded view **both completed with an empty hook log**.
- [ ] `setWindowOpenHandler` on the view: for an `http(s)` target opened as a plain `_blank` link,
      **navigate the browse view itself** and return `{ action: 'deny' }` — the user goes where they
      expected, inside the chrome, with a back button. For a target the page asked to be a real popup
      (a named or featured window) whose URL is `http(s)`, `about:blank`, `blob:` or `data:`, return
      `{ action: 'allow', overrideBrowserWindowOptions: { webPreferences: { partition:
'persist:spm-browse', sandbox: true, contextIsolation: true, nodeIntegration: false, webSecurity:
true } } }` — **naming the flags rather than inheriting them**, because a `webPreferences.preload`
      supplied through this very handler was measured to give a popup a full live bridge at any
      origin, which makes this handler one of the two places the bridge can be handed away. Deny
      everything else. Do **not** force `noopener`.
- [ ] `setPermissionRequestHandler` **and** `setPermissionCheckHandler` on the browse session, both
      refusing everything. Each session needs its own — the default session's handler fired only for
      the default session's view — so a browse partition with none runs on Electron's defaults, which
      is not a decision anyone made. ~~Mark `setPermissionCheckHandler` **unmeasured** in a comment
      (spec 9.5): only the request handler was probed, and the check handler is set to the same
      refusal for consistency.~~ **Withdrawn during task 2, which measured it** — it is not for
      consistency, it is the only thing that answers `navigator.permissions.query`, which reads
      `"granted"` with the request handler alone. See spec 3.7 and 9.5, both corrected, and the
      docblock on `BrowseHost.session`. Electron's defaults were measured at the same time: a
      partition with neither handler **grants** geolocation and notifications with no prompt.
- [ ] Bounds (decision 11): `BROWSE_CHROME_INSET` and `BROWSE_MIN_AREA` are constants in this file
      and the renderer never names either. The renderer reports a rectangle in CSS pixels; the main
      process converts by the window's current `zoomFactor`/scale, computes
      `allowed = contentBounds minus BROWSE_CHROME_INSET`, and applies the **intersection**. A
      request whose intersected area is below `BROWSE_MIN_AREA` is treated as a call to `hide()`, not
      honoured as a rectangle — a renderer that reports `1×1` would otherwise keep a live third-party
      page running invisibly. Use `{ top: 120, right: 0, bottom: 0, left: 0 }` CSS px and a minimum of
      `200 × 200` CSS px; **both are judgements, labelled as such in a comment**, and spec 9.6 says it
      is unmeasured whether the inset achieves the property it is written for.
- [ ] Re-apply the bounds on the host window's `resize` event as well as on every renderer report, so
      a resize between two reports never leaves the view stranded. The renderer's report is the intent
      and the window's event is the correction.
- [ ] Lifecycle (spec 4.3): `attach` **destroys** any existing view first; the view is destroyed on
      the host window's `closed`; and the view is destroyed on a **transport change** —
      `replaceWindows` in `app.ts` builds a new window and destroys the old, in that order, so a
      browse view the shell still held would be a handle on a destroyed window. This is `ShellHost`'s
      existing "switching modes must not leak the previous mode's client" property and E's view joins
      the things it covers.
- [ ] `detach` **destroys** and does not hide. A hidden view is a live third-party page still running
      script, still holding sockets, still able to start a download nobody is watching, and one bounds
      bug from being visible on a page it has nothing to do with. The cost is a scroll position and
      not a login: the partition is persistent, so cookies and `localStorage` survive.
- [ ] `hide()` / `show()` exist for **a modal only** — the view paints over the renderer
      unconditionally, with no z-index relationship to negotiate, so any dialog, toast or dropdown the
      app raises under the view's rectangle is invisible. They are never a route change's tool.
- [ ] `packages/desktop/src/browse/last-page.ts`: one entry, `{ url: string }`, in `browse.json` under
      `app.getPath('userData')`, written through `json-store.ts`'s `writeJsonFile`. `attach`'s `url`
      defaults to this, then to the registry's first `homeUrl`. **Name it in the docblock for what it
      is** — persisted third-party browsing history, one entry long, which the user did not ask for —
      and note that spec 7.3's claim that it is "cleared with the browse profile" is inaccurate for a
      file under `userData`, which is why `clearLastPage()` exists (decision 8). Spec 9.14 stays open.
- [ ] Add to `packages/contract/src/api-client.ts` a `browse` block with **eleven** methods and their
      DTOs in `dtos.ts`, exactly as the two blocks below. Wire all eleven into
      `packages/desktop/src/dispatch.ts` as **`shellCall`** entries, each with its own `z.tuple`
      schema, add them to `ShellApi` in `dispatch.ts`, implement them on `ShellHost` in `app.ts` over
      `BrowseHost`, and refuse all eleven in
      `packages/web/src/app/core/api/http-api-client.ts` with
      `AppError('Forbidden', 'this shell cannot embed a model browser')`, exactly as `library.pick`
      and the seven `slicers` methods already are. **Not `libraryCall`**: in remote mode
      `deps.session` is null and `libraryCall` refuses a null session by design.

```ts
browse: {
  sites(): Promise<ModelSiteDto[]>
  attach(bounds: BrowseBounds, url?: string): Promise<BrowseStateDto>
  detach(): Promise<void>
  hide(): Promise<void>
  show(): Promise<BrowseStateDto>
  setBounds(bounds: BrowseBounds): Promise<void>
  navigate(url: string): Promise<BrowseStateDto>
  back(): Promise<BrowseStateDto>
  forward(): Promise<BrowseStateDto>
  reload(): Promise<BrowseStateDto>
  state(): Promise<BrowseStateDto>
  clearLastPage(): Promise<void>
}
```

```ts
type ModelSiteDto = { id: string; displayName: string; homeUrl: string }

type BrowseBounds = { x: number; y: number; width: number; height: number }

type BrowseStateDto = {
  attached: boolean
  url: string | null
  title: string | null
  isLoading: boolean
  canGoBack: boolean
  canGoForward: boolean
  /** The registry row this URL belongs to, or null. Drives attribution, not permission. */
  siteId: string | null
  /** Set when the last navigation failed, so the UI can say what happened rather than spin. */
  lastError: string | null
}
```

- [ ] `browse.navigate` runs its argument through `browseNavigationPolicy` **in the main process**
      before touching the view, and rejects a blocked URL with an `AppError`. The renderer never hands
      a URL to Chromium in the privileged document (constraint 13).
- [ ] Tests, `browse.spec.ts` beside `shell.spec.ts`, Playwright against the real app, pointed at **a
      local HTTP server the test starts** — nothing in CI may depend on Thingiverse being up or on a
      Cloudflare challenge clearing. **The browse view has no bridge:** `typeof window.spm` read
      _inside the embedded document_ at a non-`spm://` origin, expected `"undefined"` with
      `Object.keys(window.spm ?? {})` empty. Break it by adding `webPreferences.preload` to the view
      and confirm red — that configuration is measured to go green on every other test in the suite.
- [ ] Tests: **the view keeps its four trust flags.** `getLastWebPreferences()` on the _view's_
      `webContents`, expected `sandbox: true`, `contextIsolation: true`, `nodeIntegration: false`,
      `webSecurity: true`. This object cannot answer the preload question (constraint 9); that is not
      a reason to stop asking it the questions it can answer, and without this assertion
      `webSecurity: false` on that one constructor turns nothing red.
- [ ] Tests: **the view is not on the default session** — `webContents.session ===
session.defaultSession` expected `false`, and `getStoragePath()` expected to end in `spm-browse`.
      This is the runtime guard for the session-preload defect as well as for the partition.
- [ ] Tests: **`spm://` is not handled on the browse partition** —
      `fromPartition('persist:spm-browse').protocol.isProtocolHandled('spm')` expected `false` **and
      `defaultSession`'s expected `true` in the same assertion**, so a null instrument is visible. Then
      the positive form: a top-level navigation to `spm://app/` from the browse view fails.
- [ ] Tests: **the navigation policy is attached to the view's own `webContents`.** Drive an in-page
      `location.href` to a blocked scheme inside the view and assert the view's `getURL()` did not
      move. Asserting `browseNavigationPolicy(url) === 'block'` as a unit test is necessary and does
      **not** substitute for this: with the policy on the window instead, the navigation completes and
      the hook log is empty.
- [ ] Tests: **`will-redirect` enforces the policy.** The local server answers 302 into
      `bambustudio://open?model=1`; assert the navigation was refused and the view stayed put. Measured:
      that redirect reaches `will-redirect` and **not** `will-navigate`, so a suite that only drives
      `will-navigate` is green with the arm missing.
- [ ] Tests: **`setWindowOpenHandler` is attached to the view.** A `window.open` from the embedded page
      creates **no** new `BrowserWindow` (count before and after) while the view itself navigates for
      an `http(s)` `_blank` target; and a deferred `const w = window.open(); w.location = url` is not
      denied at the `about:blank` step.
- [ ] Tests: **the permission handler denies**, and it is the browse session's that fired. A
      `geolocation` request from the embedded page is refused **with the default-session handler
      asserted not to have fired** — each session's handler fires only for its own view, so an
      assertion that does not check which one fired can pass on the wrong one.
- [ ] Tests, source assertion (decision 10): a `node --test` that walks every `.ts` file under
      `packages/desktop/src` and asserts neither `registerPreloadScript` nor `setPreloads` occurs.
      Prove it can fail by adding the identifier to a scratch file, confirming red, and removing it.
- [ ] Tests, bounds and lifecycle, under `node --test` with the Electron surface injected: a request
      taller than the content area is intersected down and **never covers the chrome inset** — assert
      the applied rectangle's `y` and `height`, then change the code to clamp to the content bounds and
      confirm red; a request of `1×1` results in `hide()` and **not** a `setBounds` call; a second
      `attach` destroys the first view — assert the destroy call count, not that a view exists.

**Interface handed to task 3 (an asserted invariant):** `BrowseHost`'s browse `Session` accessor, the
partition string `'persist:spm-browse'`, `ModelSiteDef`/the registry lookup by URL, and the
`BrowseStateDto` field list above. The controller hands these over verbatim.

### Task 3 — Download interception, the staging record, and the sweep

Main process only. Everything in this task except the `will-download` registration itself runs under
plain `node --test` against a temporary directory, with the `DownloadItem` surface injected.

- [ ] `packages/desktop/src/browse/downloads.ts`: a `BrowseDownloads` class. Its `will-download`
      listener is registered on the **browse session**, once, when the session is first created, and it
      outlives every view (decision 4). Do not register it per `attach`.
- [ ] The handler makes **exactly one decision, synchronously**, and stages everything it does not
      refuse. `preventDefault()` wrote nothing anywhere and the item was destroyed by the next tick —
      `getState()` afterwards threw — so there is no "ask the user first" inside the handler, because
      there is no await that leaves an item alive.
- [ ] **Default: accept and stage.** `item.setSavePath(<userData>/model-downloads/<downloadId>/<name>)`.
      Staging is safe because a staged file is inert: it is under `userData`, it is in no project, no
      `files` row exists for it, and nothing has been uploaded. The user decides afterwards, with time.
- [ ] **The one refusal: a download past a staging ceiling.** The three caps are the table below.
      They are constants in **one place** in `packages/desktop/src/browse/downloads.ts`, not settings —
      a user has no basis for choosing them and a UI for them would imply the app knows the right
      answer. **They are judgements, labelled as such in a comment**, chosen against the one real
      download there is (21 060 699 bytes) so the honest case is nowhere near the limit.

| Cap                                 | Value | Reasoning                                                                      |
| ----------------------------------- | ----- | ------------------------------------------------------------------------------ |
| Concurrent downloads in flight      | 4     | Four models before landing any is plausible; forty is not a user               |
| Total **staged** bytes, all records | 4 GiB | ~200 Thingiverse-sized archives sitting undecided                              |
| Single download                     | 2 GiB | Above any observed model archive, below a staging directory becoming a problem |

- [ ] **Not refused: `hasUserGesture() === false`.** It is recorded on the record and shown, never
      acted on. The flag distinguishes `webContents.downloadURL()` from a real click, but a click driven
      by `executeJavaScript` also reports `false` — so it is evidence about how a download started and
      not a verdict, and refusing on it would break sites whose download button is a scripted `blob:`
      construction. Which is Thingiverse's, the one download that was actually measured.
- [ ] The filename is **`item.getFilename()`**, sanitised through the same rules `files.upload` applies
      (core's `safeJoin` refuses separators and traversal), because the name comes from a remote server.
      **Not `Content-Disposition`**: `getContentDisposition()` was an empty string on the real download
      while `getFilename()` was populated and sane in every case measured.
- [ ] **Nothing in the design may use `getETag()` or `getLastModifiedTime()`** — both came back empty on
      every download measured. No caching, no "have I downloaded this before", and in particular no
      integrity check. The record's own `totalBytes` is the only integrity signal there is.
- [ ] `<userData>/model-downloads/<downloadId>/` holds **two** files: the bytes, and `download.json`
      beside them. The record is written through `json-store.ts`'s `writeJsonFile` **before
      `setSavePath()` returns**, so a kill one millisecond later still leaves a directory that explains
      itself, and **rewritten exactly once on `done`**. Not per `updated` tick: that is five writes and
      five fsyncs on a 21 MB download for a number the poll already has in memory. **No `version` key**
      (decision 6). The field list is the block below, and it is the handover to task 4.

```
download.json
  downloadId               the directory name, minted by the main process
  startedAt                epoch ms
  fileName                 the sanitised basename beside this file
  sourceUrl                item.getURL() — may be a blob:, for display and attribution only
  pageUrl                  the page the view was on when it started; null if unknown
  siteId                   the registry row for pageUrl, or null
  mimeType                 item.getMimeType()
  hadUserGesture           recorded, never acted on
  totalBytes               getTotalBytes() at will-download; 0 when the server sent no length
  state                    'progressing' until done, then 'completed' | 'cancelled' | 'interrupted'
  receivedBytes            last observed; rewritten on the terminal transition, not per tick
  library                  which library this was staged against — D's libraryKeyOf, same reason
```

- [ ] `pageUrl` is read off **the view's own `webContents`** inside the `will-download` handler, and it
      is what matching runs on. `sourceUrl` is what the `DownloadItem` hands you, and on Thingiverse it
      is a `blob:` that identifies nothing and matches nothing. Conflating the two is the defect this
      pair of fields exists to prevent, and the obvious field to match on is the wrong one.
- [ ] `library` comes from D's `libraryKeyOf(isRemote, session, remote)` in
      `packages/desktop/src/slicers/launch.ts`, imported and not reimplemented, for the reason D's
      docblock gives: ids are per-library and the staging directory is per-**machine**.
- [ ] **The sweep at start refuses what it cannot vouch for** (constraint 14). For each directory under
      `model-downloads/`: no `download.json`, or unparseable → **unverifiable**, and it cannot be
      landed; `state` not `'completed'` → unverifiable, because a record that never reached its terminal
      transition is a process that died mid-download; `state: 'completed'` but the bytes on disk do not
      match `totalBytes` → unverifiable; **`totalBytes: 0` → unverifiable, because the size cannot be
      checked at all and an unknown is not a pass.** Everything agreeing → an ordinary staged download
      with `isOrphan: true`.
- [ ] Write the reason into the sweep's docblock: with `setSavePath()` in use Chromium writes **straight
      to the final path** — no `.crdownload`, no partial suffix, no sidecar — and a mid-download destroy
      left a file at **26 214 400 of 41 943 040 bytes** at its final name, byte-for-byte
      indistinguishable from a complete download of a 26 MB file. A sweep with nothing but a directory
      listing enumerates it, offers it, and `land` uploads a truncated archive into the user's project
      silently.
- [ ] **The sweep surfaces and never deletes** (constraint 15). An unverifiable file is listed, can be
      discarded by the user, and is never removed implicitly. This is D's rule and the whole point of a
      sweep that enumerates rather than tidies.
- [ ] `packages/desktop/src/browse/notices.ts`: an in-memory list held for the life of the process
      (decision 7), holding `{ id, kind: 'refused' | 'completed', fileName, detail, at }`. A refusal
      appends one **and raises a native Electron `Notification`**; a `done` with `state: 'completed'`
      that arrives while no view is attached does the same. Say in the docblock that the notification is
      the promptness and the list is the record — an OS that suppresses notifications costs the user
      nothing, because `browse.notices()` and `browse.downloads()` both still answer. Spec 9.15 stays
      open on the app's general notification surface; this is E's local answer and is scoped to browsing.
- [ ] A refusal notice must name **which download and which cap it hit**, and the UI offers a control
      that discards staged downloads to make room. `preventDefault()` delivers nothing to the site — no
      error event, no failed entry, no DOM change — so from the page's point of view the click did
      nothing, which is indistinguishable from a consent overlay eating it. Silence here trains a user to
      believe the feature is broken.
- [ ] Add the **second contract instalment**: `browse.downloads()`, `browse.discard(downloadId)`,
      `browse.notices()` and `browse.dismissNotice(id)` on `ApiClient`, plus `BrowseDownloadDto` and
      `BrowseNoticeDto` in `dtos.ts` exactly as the block below. All four are `shellCall`s with their own
      `z.tuple` schemas, all four are added to `ShellApi` and implemented on `ShellHost`, and all four are
      refused by `HttpApiClient` with `AppError('Forbidden', …)`.

```ts
type BrowseDownloadDto = {
  downloadId: string
  fileName: string
  /** `getURL()` — which may be a `blob:`. For display and attribution only. */
  sourceUrl: string
  /** The page the view was on when it started. This is what matching uses, never `sourceUrl`. */
  pageUrl: string | null
  siteId: string | null
  mimeType: string
  state: 'progressing' | 'completed' | 'cancelled' | 'interrupted'
  receivedBytes: number
  /** `getTotalBytes()`, which can be 0 for a server that sent no length. */
  totalBytes: number
  /** Recorded and shown, never acted on. */
  hadUserGesture: boolean
  startedAt: number
  /** True for a download staged by a previous run of the app. */
  isOrphan: boolean
  /** The sweep could not vouch for the bytes. `land` refuses it; `discard` is the way out. */
  isVerifiable: boolean
}

type BrowseNoticeDto = {
  id: string
  kind: 'refused' | 'completed'
  fileName: string
  detail: string
  at: number
}
```

- [ ] Tests, the sweep, against a temp directory, **all four refusal cases**: a directory with bytes and
      no `download.json`; one with an unparseable `download.json`; one with `state: 'progressing'`; and
      one with `state: 'completed'` and a file **shorter than the recorded `totalBytes`**. Each must come
      back with `isVerifiable: false`. Then a fifth: `state: 'completed'` with `totalBytes: 0` must also
      come back `isVerifiable: false`. Break it by having the sweep trust the directory listing and
      confirm the truncated case comes back landable — that is exactly what the spec's first draft said.
- [ ] Tests, the staging lifecycle: a sweep at start **lists** an orphan rather than deleting it — assert
      the directory still exists **and** that it appears in `downloads()`, then change the sweep to delete
      and confirm red; `discard` is the only thing that removes a directory; a record is on disk with
      `state: 'progressing'` **before** `setSavePath` returns — assert the write happened first, by
      ordering, not by the file merely existing at the end.
- [ ] Tests, the caps: a fifth concurrent download is refused and `setSavePath` was **never called** —
      assert the call count, not only that an event was prevented; a single download declaring more than
      2 GiB is refused; a download that would push total staged bytes past 4 GiB is refused; and each
      refusal appends exactly one notice naming the cap.
- [ ] Tests, the record's fields: `pageUrl` is the view's URL and **not** `item.getURL()` when the two
      differ — drive it with a `blob:` source and an `https:` page, which is the measured Thingiverse
      shape; `fileName` comes from `getFilename()` when `getContentDisposition()` is the empty string;
      `siteId` is the registry match for `pageUrl`.
- [ ] Tests, `blob:` end to end in `browse.spec.ts`: **all three idioms must produce a staged download**
      against a blob the test page builds itself, with the policy on — `<a download href="blob:…">` plus
      `.click()`, `location.href = blobUrl`, and `window.open(blobUrl)`. This is the assertion the
      `http(s)`-only policy would have failed, and the unit test on `browseNavigationPolicy('blob:…')`
      does **not** substitute for it, because the defect was in which hook sees what.

**Interface handed to task 4 (an asserted invariant, handed over verbatim — D's equivalent handover
drifted by four fields even though it was verbatim):** the `download.json` field list above; the
staging path `<userData>/model-downloads/<downloadId>/<fileName>`; `BrowseDownloadDto` including
`isVerifiable`; and the rule that `land` must refuse any record whose `isVerifiable` is false.

### Task 4 — Landing a download into a project

- [ ] Add the **third contract instalment**: `browse.land(downloadId: string, projectId: string, opts?:
{ name?: string }): Promise<FileDto>` on `ApiClient`, wired as a **`shellCall`** with a
      `z.tuple([idSchema, idSchema, z.object({ name: fileNameSchema.optional() }).optional()])` schema,
      added to `ShellApi`, implemented on `ShellHost`, and refused in `HttpApiClient`. **Ids and an
      optional name, never a path** (constraint 4): the staging directory is the main process's, the
      record is the main process's, and the only strings that cross are ids the main process minted
      itself and matches against records it enumerated itself.
- [ ] `land` **refuses a record the sweep marked unverifiable before it opens anything**, with an
      `AppError('Conflict', …)` naming which of the four cases it was. This is constraint 14 and it is
      the reason task 3 exists in the shape it does.
- [ ] **Local mode:** call core's `uploadFile(lib, ctx, projectId, name, { stream, sizeBytes })` with a
      `createReadStream` of the staged file wrapped through `Readable.toWeb`. Note the exact shape:
      `uploadFile`'s body parameter is `{ stream: ReadableStream<Uint8Array>; sizeBytes: number }`.
      `packages/core` is not edited (constraint 2).
- [ ] **Remote mode:** call `remoteUpload` in `packages/desktop/src/slicers/remote-files.ts`, imported
      where it is (spec 9.7). Its signature is
      `remoteUpload(remote, projectId, name, body: ReadableStream<Uint8Array>, sizeBytes: number,
contentType: string)` — **the caller builds the stream**, so the `createReadStream` and the
      `Readable.toWeb` are E's, the same way `SlicerSessions` does it. The function does not read a
      directory for you.
- [ ] `remoteUpload` already sets `UPLOAD_LENGTH_HEADER` (`x-spm-content-length`, from
      `packages/desktop/src/protocol.ts`), which `RemoteHost.#send` turns into a real `content-length`;
      the server answers **411** for a body with no length, before it writes a byte. Do not reimplement
      the upload and do not set a plain `content-length` — it is a forbidden header name on a `Request`
      and is dropped before the proxy sees it. **Pass a real `sizeBytes`**, from a `stat` of the staged
      file, not from the record's `totalBytes`.
- [ ] **The bytes never cross IPC.** They are already main-process side and the renderer names two ids.
      This is C's constraint 4 and the parent's "bulk bytes never cross a JSON boundary", satisfied by
      construction rather than by care.
- [ ] **A name clash is reported, not worked around.** `uploadFile` throws `Conflict` when the name
      exists in the project or on disk; surface it and let the user rename. **Do not auto-suffix**:
      `benchy-1.zip` beside `benchy.zip` hides the fact that the user already has this model, which is
      precisely the thing they were trying to find out. This is deliberately the opposite of D's
      returning-file rule, where the app derives a non-clashing name — there the file is one the app
      produced, here it is one the user chose.
- [ ] The staging directory is removed **once the upload has returned**. A failed upload leaves it, so
      the user can try again.
- [ ] Tests, the refusal: `land` on each of task 3's five unverifiable records throws before any read of
      the bytes — assert the upload call count is **zero**, not only that it threw. Break it by dropping
      the `isVerifiable` check and confirm a truncated archive uploads clean.
- [ ] Tests, local mode: a staged file lands as a new `FileDto`, the bytes in the project folder are
      byte-identical to the staged bytes, and the staging directory is gone afterwards; a `Conflict` from
      `uploadFile` leaves the staging directory in place and no file in the project.
- [ ] Tests, remote mode, through the injected `fetch`/proxy: the request goes to
      `/api/projects/<id>/files`, carries `x-spm-content-length` **equal to the staged file's real size
      on disk** and a percent-encoded `x-spm-file-name`; assert the header value, not that a header
      exists. Break it by passing the record's `totalBytes` for a record whose `totalBytes` is 0 and
      confirm red.
- [ ] Tests, the dispatch schema: `browse.land`'s entry rejects a path-shaped first argument with
      `Validation`, the way the slicer entries are asserted to; and the dispatch table's key set still
      **equals** `ApiClient`'s method set (the existing test).
- [ ] Tests, constraint 2: assert no file under `packages/core/src` was added or edited by E, that no
      route was added under `packages/server/src`, and that the server suite is unchanged.

**Interface handed to task 5 (an asserted invariant):** the twelve `browse` methods now on
`ApiClient` (`sites`, `attach`, `detach`, `hide`, `show`, `setBounds`, `navigate`, `back`, `forward`,
`reload`, `state`, `clearLastPage`) plus `downloads`, `discard`, `notices`, `dismissNotice` and
`land`; and `ModelSiteDto`, `BrowseBounds`, `BrowseStateDto`, `BrowseDownloadDto`, `BrowseNoticeDto`.

### Task 5 — `/browse`, the capability flip, and the archive obligation

The only Angular diff, and the only thing that lights the capability up.

- [ ] Flip `canBrowseModelSites` to `true` in **both** desktop shell columns —
      `LOCAL_SHELL_CAPABILITIES` **and** `REMOTE_SHELL_CAPABILITIES` in
      `packages/desktop/src/capabilities.ts`. Both, because browsing is a property of the **machine**
      and not of the library: the desktop app pointed at a remote server can still embed a browser, and
      the landing goes to that server. The browser column is untouched — and it is now false **on
      evidence**: the sites refuse framing, a `WebContentsView` is what loads them, and a browser build
      has no `WebContentsView`.
- [ ] Edit **both** docblocks in `capabilities.ts`, and they are **not** the same sentence.
      `LOCAL_SHELL_CAPABILITIES`' (around line 38) currently says "`canBrowseModelSites` stays false
      until E ships it, which is a deliberate departure from the spec table: a capability whose feature
      does not exist lights up UI that goes nowhere". `REMOTE_SHELL_CAPABILITIES`' (around line 76) says
      only "`canBrowseModelSites` is false until E, as above". Quoting the long one for both is the kind
      of small inaccuracy that sends an implementer looking for text that is not there.
- [ ] Update **four** assertions in `packages/desktop/test/capabilities.test.ts` — lines 49 and 61 (the
      two shell columns asserted whole, in one test), line 75 (the local-mode deep-equal) and line 93
      (the remote-mode union, which now carries the flag through from the shell column over a backend
      that reports it false). `SERVER_CAPABILITIES` at line 35 stays `false` and must not be touched:
      it is a copy of what the Deno server publishes.
- [ ] **Repair the test that loses its subject** — `capabilities.test.ts`'s "a backend cannot veto a
      capability the shell has" (the test beginning around line 128). D re-pointed it at
      `canBrowseModelSites` when the two slicer flags decayed its fixture into `true || false` is
      `true`; E flips the last shell-owned flag, so there is **no flag left in the real columns** to
      carry that property. Stop spreading `REMOTE_SHELL_CAPABILITIES` and build the fixture as a
      **literal** `Capabilities` with the shell rows true and a backend literal with them false. The
      test is about the operator, not about today's constants, and tying it to constants is what has
      now decayed it twice. Whoever lands E fixes it here rather than leaving a third subsystem to
      find it.
- [ ] Add `/browse` to `packages/web/src/app/routes.electron.ts`, under `./features/desktop/browse/`,
      with `authGuard`, matching the `settings/slicers` entry immediately above it. The file's docblock
      already reserves the name — update it to say E has taken it. In local mode `requiresAuth` is false
      and the guard passes on its first arm; in remote mode an unauthenticated window has no business
      anywhere but `/login`. Leave the `desktop`, `desktop/connect` and `**` entries exactly as they are.
      The exported class name is **`DesktopBrowsePage`**.
- [ ] The page injects **both** seams: `SHELL_CLIENT`
      (`features/desktop/shell-client.token.ts`) for the view, its bounds, its navigation and its
      downloads, because those are properties of this process on this machine and must work in both
      library modes; and `API_CLIENT` for `projects.list` and `projects.create`, because the library is
      whichever transport it is on. A page about a machine capability that lands its result in a library
      is correctly a page that injects both.
- [ ] The page renders an **empty placeholder element** and reports its bounding rectangle in CSS pixels
      through `browse.setBounds` on element resize, window resize and the page's own scroll. It calls
      `browse.attach` on init and **`browse.detach` on teardown**. The view is a native sibling, not a
      DOM element: Angular unmounting the component does nothing to it, and a view that survives a route
      change is a third-party page painted over the project list — which is not a cosmetic bug.
- [ ] **All the app's own chrome lives outside the view's rectangle**, because the view paints over the
      renderer unconditionally with no z-index relationship to negotiate. Any modal the page raises calls
      `browse.hide()` first and `browse.show()` after — **not** `detach`, which destroys the page the
      user was on.
- [ ] The address control shows the URL and the title **as text** (constraint 13), truncated, and the
      way to go somewhere is `browse.navigate`. Never a `[href]`, never a `[src]`, never a CSS `url()`,
      never `[innerHTML]`, never `bypassSecurityTrust*`, never `window.open`. Angular escapes
      interpolated text by default, which is why the default is safe and why the rule is written down
      rather than left to the author: the page will want to render a URL as a link and a favicon as an
      image, which are the two places the default does not save you.
- [ ] **Loading and the interstitial:** a normal loading state, driven by the view's own `did-navigate`
      and `did-finish-load` through polled `browse.state()`, and **no timeout at three seconds**. Two of
      the four sites answer 403 with Cloudflare's non-interactive managed challenge and clear themselves
      in about 5.6 s and 6.4 s; a spinner that gives up first converts a working page into an error
      message. If a page is still challenging after a generous window, say the site is verifying the
      connection and leave the view where it is, because the view is a browser and the user can look at
      it. **Never** spoof a user agent, retry in a loop, solve a challenge, or present a challenge page
      as an error. Consent overlays are the user's to dismiss; the app clicks nothing.
- [ ] **The landing UI's shape is "choose a project", with "create a new project" as a first-class
      option beside it** — not a fallback reached after a failure message. A first-time download matches
      nothing **by definition**: the project does not exist yet, which is why the user is on the site.
      Any design that treats "no match" as an error path has the common case backwards.
- [ ] The match, when there is one, is a **suggestion the user confirms**, preselected and never applied
      silently — `matchKey` is derived rather than measured, and a wrong silent match puts someone's file
      in someone else's project. Two or more projects sharing a key is possible, is not an error, and all
      of them are offered, ordered by name. A project created here gets its `website` set to the
      **canonical URL of the page the download came from** (`pageUrl`), which is what makes the second
      download from that model match.
- [ ] Matching runs in the renderer, over `API_CLIENT.projects.list({ includeArchived: true })` — a call
      the page is already making to populate its picker — using `matchKey` from `@spm/contract` and the
      site list from `browse.sites()`.
- [ ] **The archive obligation** (spec 5.5, 9.1). When the landed file is an archive **and the mode is
      remote**, the app says the archive cannot be expanded from here and names what that costs: the
      project folder is on the server, `canPickLocalFolder` is false in that column, a rescan rescans the
      server's disk, and the app has no reveal-in-folder affordance. In **local** mode it says the remedy:
      unzip into the project folder and rescan, which the parent's design supports as a first-class
      workflow. A user who knows is a user who can decide; a user who does not is a user with a broken
      library entry. **This bullet is not optional and it is not a nicety** — it is the whole reason the
      extraction deferral is honest.
- [ ] Render `browse.notices()` on the page with a dismiss control, and offer the "discard staged
      downloads to make room" control beside a refusal notice. An unverifiable staged download is shown as
      such, cannot be landed, and offers `discard`.
- [ ] Add the nav link in `packages/web/src/app/app.ts`, rendered only when
      `capabilities.capabilities().canBrowseModelSites` is true, read from `CapabilitiesStore` as every
      other affordance is, beside the existing `/projects`, `/import`, `/settings` and `/admin/users`
      entries. **The link is a `routerLink` string and nothing more:** `app.ts` is shared code and must
      not import anything from `features/desktop/`. The route does not exist in the web build at all and
      the capability that gates it is false there, so it is never rendered — the capability model doing
      its job in place of a build-time condition.
- [ ] Add the new strings to **both** `packages/web/src/app/core/i18n/locales/en.json` and `de.json`.
      `Translations = typeof en` in `translate.service.ts:5`, so a key missing from `de` is a **typecheck**
      failure rather than a runtime one.
- [ ] Add a CI bundle-grep pair in `.github/workflows/ci.yml` for **`DesktopBrowsePage`**, mirroring the
      `DesktopSlicersPage` pair: the web bundle at `packages/web/dist/web/browser` must **not** contain
      it, the electron bundle at `packages/web/dist/electron/browser` **must**. **Grep the exported class
      name, not the module path** — paths become hashed chunk names during bundling, so a path grep can
      never fail. This is the strongest case yet for that rule: the browse page's leak into the web build
      would be a security-shaped failure rather than a dead link, because it would ship a UI that expects
      a containment the browser cannot provide.
- [ ] Tests, capabilities: `capabilities.test.ts` asserts both shell columns **whole** after the flip, so
      a later subsystem cannot quietly move a seventh flag; the remote-mode union carries
      `canBrowseModelSites` through from the shell column over a backend that reports it false; and the
      repaired veto test passes with both operands built as literals — change `unionCapabilities` to `&&`
      for that row and confirm the veto test goes red.
- [ ] Tests, the page, with a fake `SHELL_CLIENT` and a fake `API_CLIENT`: init calls `attach` exactly
      once and teardown calls `detach` exactly once — assert the call counts, then remove the teardown
      hook and confirm red; a completed download whose `pageUrl` matches a project's `website`
      **preselects** that project and does not land anything; landing is only ever a `land` call after an
      explicit user action — assert the `land` call count is zero after a download reaches `completed`.
- [ ] Tests, the archive obligation: a landed `.zip` in **remote** mode renders the
      cannot-expand-from-here message and in **local** mode renders the unzip-and-rescan remedy — assert
      the rendered text in both, driven off the capability column, not off a boolean the test sets.
- [ ] Tests, untrusted strings: a `BrowseStateDto` whose `title` is
      `<img src=x onerror=alert(1)>` and whose `url` is `javascript:alert(1)` renders as **text** — assert
      the rendered `textContent` and assert no `<img>` was created and no anchor carries that `href`.
- [ ] Tests, the link: **absent** when `canBrowseModelSites` is false and present when it is true —
      assert the rendered anchor and its `href`, not a signal's value.

---

## Open questions

The spec's §9 has eighteen. These are the ones that reach a task. **One of them blocked a task and is
resolved here by decision 7; the rest qualify a task without blocking it, and each says what an
implementer should do on meeting it.** Do not silently resolve any of the others.

1. **What tells the user about a download that finished, or was refused, while they were elsewhere?**
   (spec 9.15.) **This one blocked a task** — spec 9.15 says a surface must exist and deliberately does
   not design one, while two task-3 bullets and one task-5 bullet need it. Resolved by decision 7:
   `browse.notices()` plus a native `Notification`, scoped to browsing. **On meeting it:** do not widen
   it into a general app notification system; the question of what the whole app's surface should be
   stays open, and E's answer is deliberately local.
2. **Should a downloaded archive be extracted into the project?** **Answered: not in E, and E is
   incomplete in remote mode because of it.** **On meeting it:** land the archive whole, classified as
   an ordinary file, and render task 5's message. Do not add an unzip path to `packages/core` as a
   passenger on E — it needs a use case, a quota check over the expanded size, per-entry clash handling
   and a zip-slip guard, and that is its own change.
3. **Do Printables and Cults3D downloads actually intercept?** **Unmeasured.** The mechanism is measured
   end to end on Thingiverse and it is a session-level hook, so nothing in the design depends on which
   button started the download — but "it works on three of the four sites" is an inference. **On meeting
   a site whose button produces nothing:** report it as a page that did nothing, not as an app error, and
   do not script a click on the site's own UI.
4. **Does MakerWorld's `Open in Bambu Studio` reach anything?** **Unmeasured**, and it is the only
   affordance that site offers a logged-out visitor. Task 1 blocks unknown custom schemes, which is the
   right answer under ignorance. **On meeting it:** block it and say so. Do **not** pass an arbitrary
   custom-scheme URL to `shell.openExternal` — `navigationPolicy`'s own docblock names that as a
   vulnerability — and do not add a per-scheme exception without a measurement.
5. **Do popup-based logins work under the window-open handler?** **Unmeasured** — no account was created
   anywhere, so the popup arm is designed from the measured `window.open` table plus knowledge of the
   idiom. **On meeting a sign-in that does not complete:** keep the `allow` arm and keep `noopener` off;
   the deny-all alternative kills the idiom outright and the plan would rather ship the arm that can work.
6. **`setPermissionCheckHandler`.** **Unmeasured** — only the request handler was probed. **On meeting
   it:** set it to the same refusal and mark it unmeasured in a comment. Do not widen either handler to
   grant a permission on the strength of a site asking for it.
7. **Do `WebContentsView` bounds, resize and focus behave acceptably in the real Angular shell?**
   **Unmeasured**, and named by the spike as the famously fiddly part. Task 2's inset-and-intersect is
   reasoning, and it is specifically **not established** that the inset achieves the property it is
   written for rather than merely being a better-shaped rule than the clamp. **On meeting it:** adjust
   `BROWSE_CHROME_INSET` and `BROWSE_MIN_AREA`, which are constants in one place, and do not replace the
   intersect with a clamp to the content bounds.
8. **Is `matchKey` right against a real library?** **Unmeasured.** The URL shapes were measured
   exhaustively; the key derived from them was never run against real `projects.website` values. **On
   meeting a wrong match:** it is a suggestion the user confirms, never applied silently — that is the
   design's answer and it does not change. Extend the fixture set rather than adding a site-specific
   special case.
9. **Should `attach` remember the last page?** **Unresolved, and it is a privacy question rather than a
   technical one.** E ships it because returning to a half-finished search is the common case, and
   records that the argument is not strong. **On meeting it:** keep `clearLastPage()` and keep the
   docblock honest about it being one entry of persisted third-party browsing history.
10. **Does Cloudflare escalate under sustained use?** **Unmeasured beyond ~40 minutes.** **On meeting an
    interactive challenge:** the user solves it in the view, because a human is driving. The app never
    attempts a bypass, never spoofs a UA and never solves a CAPTCHA.
11. **macOS and Linux.** **Unmeasured, entirely.** The partition storage path, the download path,
    `WebContentsView` layout and the challenge behaviour are all plausibly platform-sensitive. **On
    meeting it:** ship what was measured and say so. Do not design a non-Windows path from inference.
12. **Are the staging caps the right numbers?** **A judgement, labelled as one.** **On meeting a real
    library that pushes against them:** that is the measurement, and the constants move with it. They are
    in one place for exactly this.
13. **Where does the download record belong if a third staging area ever appears?** `download.json`
    beside the bytes is D's shape and the right one for E. **On meeting a third:** that is the moment to
    extract the sweep-and-verify logic, and not before.

---

## Definition of done

- `deno task verify` green, `deno task e2e` green, `deno task test:desktop` green, CI green on `main`,
  including the new `DesktopBrowsePage` grep pair.
- `typeof window.spm` read inside the embedded document at a third-party origin is `"undefined"`, and
  adding `webPreferences.preload` to the view turns that assertion red and nothing else.
- The browse view is on `persist:spm-browse`, `isProtocolHandled('spm')` is false there and true on
  `defaultSession`, and a top-level navigation to `spm://app/` from the view fails.
- All four navigation hooks are on the view's own `webContents`; a 302 into a custom scheme is refused at
  `will-redirect`; a `window.open` from the embedded page creates no new `BrowserWindow`; and a
  `geolocation` request is denied by the browse session's own handler.
- `packages/desktop/src` contains no `registerPreloadScript` and no `setPreloads`, asserted by a test that
  has been shown to fail.
- All three `blob:` download idioms stage a download with the policy on.
- A staged download with no record, an unparseable record, a non-terminal state, a size mismatch, or
  `totalBytes: 0` comes back unverifiable and `browse.land` refuses it — and a sweep at start deletes
  nothing.
- A landed download reaches the project through `files.upload` in local mode and `remoteUpload` with a
  real `x-spm-content-length` in remote mode, with the bytes never crossing IPC, and its staging
  directory is removed only after the upload returned.
- `matchKey` maps every URL variant the spike recorded — sub-paths, `?lang=`, `?from=recommend`,
  `#profileId-`, the no-slug 307 target and all eight Cults3D locales — onto the right key, and an
  unrecognised host falls back.
- `/browse` attaches on init, detaches on teardown, keeps the app's chrome outside the view's rectangle,
  waits out a Cloudflare interstitial without timing out, and offers "create a new project" beside
  "choose a project" rather than after a failure.
- A landed archive in remote mode tells the user it cannot be expanded from there and what that costs.
- `canBrowseModelSites` is true in both desktop shell columns and false in the browser column, the union
  carries it through a backend that reports it false, and the "a backend cannot veto" test is built from
  literals so it cannot decay a third time.
