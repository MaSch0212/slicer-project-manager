# Desktop chrome, settings and the model browser — design

**Date:** 2026-11-08
**Status:** design, not yet planned
**Supersedes, in part:** the shell chrome of
[subsystem G](2026-08-30-slicer-project-manager-subsystem-g-shell.md) and the browse page of
[subsystem E](2026-08-28-slicer-project-manager-subsystem-e-model-browser.md). Where this document
and those disagree, this one is current. The behaviour *below* the page — the navigation policy,
the staging directory and its caps, landing through the library API — is unchanged and those
documents remain the reference for it.

## 1. Why

Opening the desktop app looks like a web page in a window rather than like an application. The
first screen stacks three bars: the system title bar in the system's colours, the
Library / Edit / View / Window strip under it, and then the app's own sidebar header repeating the
application's name. Nothing below that first 90 pixels is wrong; the frame around it is.

Two screens behind that frame have the same flavour of problem. Settings is a tab control with two
tabs, one of which is a long page in its own right, so the thing that looks like a small
preferences pane is really two unrelated pages behind a switch. And Find models wraps a native
browser view in page furniture — a heading, a lead paragraph, a downloads list, a forget-this-page
control — that leaves the actual site a letterboxed rectangle in the middle of the window.

The reference for all of it is the user's other application, Questkeep: one app-coloured bar
carrying the logo and the window buttons, a settings page that is one long scroll with a section
menu beside it, and collapsible cards for per-item configuration.

### 1.1 Success

- The app opens into one bar in the app's own colours, and nothing on screen is drawn twice.
- Settings is one page you scroll, with a menu that says where you are in it.
- Find models is a browser: tabs, an address, and the site filling everything else.
- A download is decided once, when it starts, and files itself when it arrives.

### 1.2 Non-goals

- Changing anything about the library, projects, the viewer, the server, or the API. No DTO and no
  route changes except where the model browser's own commands demand them.
- A macOS or Linux window frame. The desktop app is Windows-only today and stays so.
- Making the browser build look like the desktop app. A page in a browser has no window frame to
  replace and must not grow a fake one.
- A general-purpose web browser. The navigation policy, the four-site registry and the download
  caps are unchanged; tabs multiply the view, not the permissions.

### 1.3 Anti-goals

Things that would make this a failure even if every box above is ticked:

- **Losing native window behaviour.** Drag-to-snap, Win+arrow, double-click-to-maximise, aero
  shake, the resize borders and the taskbar preview must all still work. An undecorated window
  that cannot be snapped is worse than the system title bar it replaced.
- **A visible flicker when the native view is swapped for its still picture.** If the user can see
  the swap, the dialog is worse than the sidebar-wide panel it replaced.
- **Settings sections that are secretly routes.** If the menu navigates instead of scrolling, this
  is the tab control again with a different shape.
- **A download that silently goes nowhere.** Every started download ends in a file in a project, a
  cancellation the user asked for, or a message saying why not.

## 2. What the user decided

Taken from the conversation, in their words where it matters:

1. **One bar across the whole top** (option A of the two shown), with the logo and the app name as
   text in it, and the sidebar starting below it.
2. The Library / Edit / View / Window menu is **dropped entirely** — "choose library is already in
   settings and all the other options in the menu bar are not really necessary".
3. Settings becomes **a long list with a section menu on the left**, and the slicers become
   **accordions**.
4. Find models supports **several sites open at once, each in its own tab**, with the tab strip
   inside the page and an address row under it (option A of three shown).
5. The downloads section below the view is **gone**. A download opens **a modal**, and because the
   native view cannot be drawn over, the view is **replaced by a still picture of itself** while
   the modal is up.
6. The modal opens **as soon as the download starts**, "so the user can decide then what should
   happen with the file(s). When download finishes they are automatically handled as the user
   selected."
7. Closing that modal without choosing **cancels the download**.
8. While a download runs, a **progress chip sits to the right of the address**; with several
   downloads it is **one chip with a count and a drop-down list** (option B of two shown).
9. The embedded view **uses the full available space**.
10. Tabs are remembered **while the app is open** — leaving Find models and coming back keeps
    them — and a restart **starts fresh**.
11. "Cancel" means **let the bytes land and then delete the file**, not stop the transfer. Tauri
    exposes no way to abort a download, and reaching past it into WebView2 to get one is not worth
    the fragility.
12. The Windows code §3.2 and §6.2 need lives in **a crate of its own**, so that
    `unsafe_code = "forbid"` stays untouched everywhere else.

## 3. The window chrome

### 3.1 What it looks like

One bar, full width, above everything including the sidebar, in `--color-surface` with the app's
bottom border. In it, left to right:

- the application mark (the same artwork as `assets/icons/favicon.svg`, which the sidebar brand
  draws today), 
- "Slicer Project Manager" as text,
- draggable empty space,
- minimise, maximise/restore and close, drawn by the app.

Below it, the sidebar and the page sit side by side as they do now, except that the sidebar's
brand row is gone: its first element is the Projects entry. The sidebar's footer (the theme menu
and the collapse toggle) stays where it is.

The maximise button shows a restore glyph while the window is maximised, and the close button is
the only one that takes a red hover.

### 3.2 What it must not break

The window keeps every native behaviour listed in §1.3. This is the hard part of the whole
document and the builder should treat it as the first thing to prove, before any pixels: an
undecorated Tauri window on Windows loses the resize border and the snap affordances unless the
non-client area is handled deliberately.

All of it lives in a new crate — `spm-win32` or similar — that does not inherit the workspace
lint and holds every `unsafe` call behind a small safe API, with `cfg(windows)` around it so the
Linux CI job still builds `spm-desktop`. `windows` and `webview2-com` become direct dependencies
of that crate; both are already in the lock file transitively, and `THIRD-PARTY-NOTICES.md` is
regenerated.

Two routes are known to work, and the builder picks one after trying it:

- **Extend the client area into the title bar** — keep the window decorated and handle
  `WM_NCCALCSIZE` so the client area covers the caption, which is what Chromium-based applications
  do. Snap, resize and shadow are the system's and keep working; the cost is a custom window
  procedure reached through `with_webview` / the raw `HWND`.
- **Undecorate and re-add** — `decorations(false)` plus a hit-test that reports the top strip as
  the caption and the window edges as resize borders.

Either way, the drag region must report the caption to Windows rather than calling
`start_dragging` on mouse-move, or double-click-to-maximise and drag-to-snap are lost. The window
also needs the maximised-state padding Windows requires, or the top row is clipped when maximised.

### 3.3 Where it exists

The bar is desktop-only, gated on `isDesktop()` from `core/desktop.ts` — the same test
`settings-general.tsx` already uses for "is there a shell around this page". **Not a new
capability flag:** `Capabilities` is a fixed six-key DTO that `parse_capabilities` requires whole,
so a seventh key would make every older server reject the new client, and §1.2 rules the DTO out
anyway. Whether a window frame exists is a property of the container, not a permission the server
grants, which is exactly what `isDesktop()` answers.

In a browser the application renders as it does today, minus the sidebar brand row, which moves
into a page-level header there.

### 3.4 What goes away

`build_menu` in `apps/desktop/src-tauri/src/window.rs` and everything it reaches: the
`CHOOSE_LIBRARY_ITEM`, `RELOAD_ITEM` and `DEVTOOLS_ITEM` handlers, and `menu_strings` in
`spm_shell::library` if nothing else uses it.

**Reload and the developer tools keep their chords.** `Ctrl+R` and `Ctrl+Shift+I` must still work
in the release build, since `devtools` is enabled there on purpose. Tauri has no accelerator table
detached from a menu, so the builder works down this list and stops at the first that holds:

1. Keep the `Menu` object built but hidden (`hide_menu`), and verify on Windows that its
   accelerators still fire. If they do, this is free.
2. Otherwise, a `keydown` handler in the main webview, plus the same handler pushed into each
   browse child webview through `initialization_script` — the mechanism the smoke run already uses
   to reach into those views. This is needed anyway for case 1 if hidden-menu accelerators turn out
   not to fire while focus is inside a child webview, which is most of the time on the one page
   where reload matters most.

**Not `tauri-plugin-global-shortcut`.** It would take `Ctrl+R` from every other application on the
machine.

### 3.5 The way back out of a server you cannot sign in to

Deleting the menu would otherwise remove the last escape from one real state: a desktop app
pointed at a reachable remote server whose password the user does not have. `/settings` is behind
the auth guard, `/desktop/connect` is behind `canPickLocalFolder`, which `REMOTE_SHELL_CAPABILITIES`
sets to `false`, and the start-up prompt only fires when the library fails to open — so the menu
was the only door left.

The login page therefore grows a "choose a different library" control, shown only when
`isDesktop()`, which runs the same `chooseLibrary` flow the settings card runs. This is scope the
menu deletion creates rather than scope the redesign wants, and it is small, but it is not
optional.

## 4. Settings

### 4.1 One page

`/settings` becomes a single scrolling page. Down its left, inside the page and under the page
title, a menu of its sections; to the right, every section one after another. Clicking a menu entry
scrolls to that section; scrolling moves the highlight to the section you are in. The menu does not
navigate, and the browser's back button is not involved.

Sections, in order:

| Section | What moves into it |
| --- | --- |
| Appearance | language, theme, default view mode, collapsed sidebar — today's `SettingsGeneral` appearance card |
| Library | `LibraryLocation` — where the folder is and how to change it |
| Account | `AccountSection` — password and the rest of the signed-in user's own settings |
| Slicers | today's whole `/settings/slicers` page: the default slicer, one accordion per product, and the unfinished-sessions card |
| Import | the CuraManager import panel |

A section whose capability is off is absent from both the page and the menu, exactly as the Slicers
tab is absent today: Library needs `canPickLocalFolder` or the desktop shell, Account needs
`requiresAuth` and a session, Slicers needs `canConfigureSlicers`. The menu is built from the
sections that rendered, so the two can never disagree.

### 4.2 Routes

`/settings/slicers` stops being a route. It redirects to `/settings`, and the capability guard that
protected it moves onto the section. Deep links to a section use a fragment (`/settings#slicers`),
which the page scrolls to on load; a fragment naming an absent section is ignored and the page
opens at the top.

This is the one place where the change loses something: a direct link to the slicers page. The
fragment replaces it, and nothing in the app links to `/settings/slicers` except the settings tab
strip that is being deleted.

### 4.3 The slicer accordions

One accordion per product, in the order `productRows` already produces. Collapsed, the header
carries the product's name and a summary line — the bound install's version and path, "not
installed", or "2 installs found" — plus a status pill where there is something to say (bound, must
choose, the bound install has gone missing). Expanded, the body is today's content for that
product: the install choice list, the add-manually button and the unbind button.

Which ones start open: a product that `mustChoose` opens, because it is a question. Everything else
starts closed. Several may be open at once.

### 4.4 Phone and narrow windows

Below the `md` breakpoint the section menu is not a column. It becomes a horizontal, scrollable row
of the same entries pinned under the page title, or it collapses into a select — the builder's
call, the requirement being that the sections stay reachable without scrolling past four screens of
settings to find out what exists.

## 5. Find models

### 5.1 The page

Two rows of chrome and then the view:

```
┌─ tab strip ───────────────────────────────────────────────┐
│ [●  Printables  ×] [●  Thingiverse  ×]  [+]               │
├─ address row ─────────────────────────────────────────────┤
│ [←] [→] [⟳]  [ printables.com/model/1183994…   ] [Site ▾] │  [⬇ chip]
├───────────────────────────────────────────────────────────┤
│                                                           │
│                        THE SITE                           │
│                                                           │
└───────────────────────────────────────────────────────────┘
```

Gone from the page: the `PageHeader` (title and lead), the downloads `<section>` and its
`DownloadRow`/`LandingPanelView`, the forget-last-page button and its hint, and the standalone
status line (loading, title, site badge, last error). The things that line said are shown in the
tab itself — a spinner in place of the favicon while loading, the page title as the tab label — and
page errors are shown in the view's own area rather than as a row above it.

### 5.2 Full bleed

The view fills everything below the address row, to the window edges: no page padding, no
`max-w-6xl` column, no card border or radius around it. This means the route escapes the shell's
centred `<main>` column. The shell grows a way for a route to say it wants the whole frame — a
layout flag on the route or a second slot in `AppShell` — rather than the browse page reaching out
of its container with negative margins.

`ViewportSlot`'s fixed `h-[60dvh] min-h-96` goes with it; the slot becomes a flex child that takes
the remaining height.

### 5.3 Tabs

Each tab is a child webview of its own, created the way the single one is created today. Only the
active tab's view is visible and positioned over the slot; the rest are hidden, alive, and keep
their page, scroll position and session.

- A new tab opens on the start-site picker, as a cold `/browse` does today.
- Closing a tab destroys its view. Closing the last one leaves one empty tab rather than an empty
  page with no way back.
- The tab label is the page title, falling back to the host; the favicon slot carries a spinner
  while the page loads and the site's badge colour otherwise.
- There is a cap on open tabs. Each tab is a live WebView2 instance with its own memory; the
  builder sets the number (8 is a reasonable starting point) and the `+` button is disabled with a
  tooltip at the cap.
- All tabs share the one `browse-profile` data directory, so a site signed into in one tab is
  signed into in the next.

Every tab is subject to the same navigation policy, the same new-window denial, the same permission
denial and the same download interception as the single view is today. **A tab is not a trust
boundary that needs rethinking; it is the same view, N times.** The capability ACL continues to
name no browse webview, so the label scheme must keep every tab's label outside the main
capability — `browse-1`, `browse-2`, … and a test that asserts none of them can reach a command,
extending the existing hidden smoke run rather than replacing it.

### 5.4 Lifetime

The set of tabs lives as long as the application process. Leaving `/browse` hides the views and
keeps them; returning shows them and re-reports the bounds. Quitting destroys them, and the next
start opens one fresh tab.

This deletes `crates/spm-shell/src/browse/last_page.rs` and `browse.json` with it, along with the
`forgetLastPage` command and its button. The module's own documentation says it was written so that
dropping it is a deletion rather than an untangling, and spec E 9.14 left the question open; this
answers it. On upgrade, an existing `browse.json` is deleted when the browse service starts, so a
remembered URL does not sit on disk forever after the feature that wrote it is gone.

The page's `onCleanup` must stop disposing the service. What disposes it is application shutdown.

**Off the route, every tab is suspended: a download request from any of them is refused.** Today
the view is destroyed when the route goes, and `host.rs` says why — "a hidden live third-party page
is a page still running script and still able to start a download nobody is watching". Keeping the
views alive removes that guarantee, so it is replaced rather than dropped: while `/browse` is not
the current route the views are hidden and `on_download_requested` answers `Decision::Refuse`,
recording a notice. This also settles the collision between §5.4's lifetime and §6's decide-at-the-
start rule — there is no case where a modal has to open over a page that is not the browser.

A download already decided and in flight is unaffected by leaving the page; it is the *start* of a
new one that is refused.

## 6. Downloads

### 6.1 The sequence

1. The site starts a download. The shell intercepts it as it does today, in `on_download`'s
   `Requested` arm, and stages it.
2. The app captures a still picture of the active view, draws it in the view's rectangle, hides the
   real view, and opens a modal.
3. The modal asks what the file is for: an existing project (with the page-derived suggestions the
   landing panel already computes), or a new project by name, plus the file name. It names the
   file and the site it came from.
4. **Confirm** records the choice against that download, closes the modal, restores the live view,
   and browsing continues.
5. **Close without choosing** — the close button, Escape, the backdrop — cancels the download.
6. When the download finishes, the file is landed into the chosen project without asking again.
   Success is reported where the user can see it (§6.4), and so is failure.

The user is never held in the dialog while bytes transfer. The decision is the only thing the
dialog is for.

**The decision belongs to the shell, not to the page.** This was not obvious when the sequence
above was written and it is the main thing the builder has to get right. The page stops polling
the moment you leave `/browse`, so a decision held in page state is a decision that evaporates
while the file is still coming down — and "it files itself when it arrives" then quietly fails
for exactly the case the up-front choice exists to serve. So:

- a command records the choice against the staged download (project id or a new project's name,
  and the file name), beside the download's own record;
- `on_download_finished` lands it, and because landing can be a remote upload it is handed to the
  runtime rather than run on the main thread in the hook;
- a landing that fails leaves the download staged with its reason, which the chip then reports.

Cancelling needs the same place: `discard` refuses a running download today, by design, so
cancelling is a separate command that marks the record and deletes the file when it arrives
(§6.1a).

**As built**, two details are worth recording because they were decided while writing it:

- The *project* is created by the page, before it decides, and the decision names only an id.
  Creating one is the library API's job, and doing it up front means a project the user has just
  named appears at once rather than minutes later when the file lands. The cost: cancel the
  download afterwards and an empty project is left behind, which the user can see and delete.
- **Closing the dialog cancels only the download that opened it.** A dialog opened by hand from
  the tray — the way to file what a previous run left — must leave that file alone when the user
  backs out of it. Only the dialog that opened by itself, for a download still on its way, treats
  closing as "I don't want this".

### 6.1a What "cancel" actually does

**The transfer is not stopped; the file is deleted when it arrives.** `DownloadEvent` has two arms,
`Requested` and `Finished`, and neither carries a handle — `browse/downloads.rs` already records
this as measured ("A download cannot be cancelled once it has started… That is a Tauri
limitation"), and the only lever ever found was destroying the webview, which would cost the user
the page they are on.

So a cancelled download is marked cancelled in the staging record, the bytes keep arriving
unobserved, and `on_download_finished` deletes the staged file instead of landing it. The user sees
it vanish immediately. On a slow line this spends bandwidth on a file that was refused, which is
the accepted cost of not reaching past Tauri into WebView2's own download object.

`host.rs`'s park-on-detach machinery — which keeps a view alive while a download runs rather than
closing it — is rethought alongside this, since views now outlive the route for their own reasons
(§5.4).

### 6.2 The still picture

The active view is captured to an image and that image is drawn in the view's rectangle while the
view is hidden. The capture is `ICoreWebView2::CapturePreview` on the active child webview, reached
through Tauri's `with_webview`; `webview2-com` is already in the dependency graph on Windows.

Three things decide whether this feels right:

- **Order.** The image must be in the DOM and painted *before* the native view is hidden, or the
  user sees a flash of the empty slot. Hide-after-paint, not hide-then-paint.
- **Scale.** The capture is in physical pixels; the image is drawn at the slot's logical size. It
  must land pixel-exact at the current scale factor.
- **Failure.** A capture can fail or time out. When it does, the modal still opens and the slot
  shows the neutral surface it shows today. A failed screenshot must never block the dialog.

**Only the download dialog gets the still picture.** Every other overlay — the site picker's
dropdown, a menu, a drawer — keeps today's behaviour and simply hides the view.

That is a deliberate narrowing. Extending it to every overlay claim would mean `createOverlayClaim`
can no longer be synchronous: paint-before-hide requires awaiting the capture, so every
overlay-opening component in `src/ui/` would gain an awaited open and a dropdown would not appear
until a capture of the whole window had completed — plausibly 100–300 ms. The alternative, opening
at once and swapping the picture in when it lands, reintroduces exactly the blank §1.3 forbids. The
download dialog is a single, deliberate, infrequent flow where waiting for the capture costs
nothing noticeable, and it is the only place the user asked for this.

The capture has a timeout (250 ms is a reasonable starting point). Past it, the dialog opens
against the neutral slot.

### 6.3 The chip

To the right of the address. **It is present whenever the browser has something to say** — a
download in flight, or an unread notice — and absent otherwise. It is not purely a progress
indicator, because the two things that raise notices both happen when nothing is downloading: a
cap refusal happens *before* any download exists (which is why `browse/notices.rs` exists at all),
and the start-up sweep raises orphan notices before the user has done anything.

While downloads are running:

- One download: the file name, truncated, and an indeterminate progress bar.
- Several: the newest one plus a count badge; pressing the badge drops a list of them, each with
  its own name, bytes so far and a cancel.

**It cannot show a percentage.** WebView2 reports no content length and no progress events for a
download; the record carries the bytes on disk so far and the total only once it has finished. The
chip counts bytes up against an indeterminate bar, and the existing
`browse.downloadRunningUnknownSize` string is the one to use.

Cancelling from the chip does what §6.1a describes: the entry disappears and the file is deleted
when it lands.

**As built, the chip opens a tray in the page's flow rather than a floating list.** A popover is a
layer over the page, so it would be drawn under the native view like every other layer, and would
need the view hidden and replaced by a picture for the sake of a three-line list. The tray sits
under the address row and pushes the view down a few pixels, which the view reports like any
other change of its rectangle.

### 6.4 Telling the user what happened

A toast is not available on this page: toasts do not claim an overlay — deliberately, because a
toast would otherwise hide the view for its whole duration — so one would be painted *under* the
native view and never seen.

So everything reports through the chip of §6.3:

- A finished download leaves the list, and the page says where it went, using the project the
  user chose in the dialog (the shell knows only its id).
- A failure, a cap refusal, a sweep orphan, or a landing the library API rejects becomes an entry
  that stays until the user deals with it. Pressing it opens the dialog with the explanation and
  whatever choices are left — retry the landing, pick a different project, discard.
- With nothing running and no unread notice, the chip is not there at all.

Notice `detail` text stays English-only, as `notices.rs` already documents: it is a passed-through
technical reason, not a sentence the app composes. The chrome around it — the chip's own labels,
the dialog's buttons, the headline of each entry — is translated like everything else.

With the decision taken up front the orphan case should become rare, but the sweep that produces
it stays and its notices need this home.

## 7. What this removes

Listed so the plan can account for it:

- The application menu and its three command handlers.
- The sidebar brand row, in the desktop build.
- The settings tab strip, `SettingsLayout` as a tab frame, and the `/settings/slicers` route.
- The browse page's header, status row, downloads section, landing panel in the page, and
  forget-last-page control.
- `browse/last_page.rs`, `browse.json`, the `forgetLastPage` command, its strings and its tests.
- `ViewportSlot`'s fixed height.

## 8. Constraints

- **The design tokens are not negotiable.** Every colour, radius, border, shadow and font size
  comes from `src/styles.css`, and `src/ui/no-adhoc-styling.test.ts` enforces that feature code
  composes components instead of styling elements. The window bar, the section menu, the
  accordions, the tab strip and the chip are all new components in `src/ui/`, not Tailwind classes
  in pages.
- **Contrast.** New surfaces keep the measured AA relationships described at the top of
  `styles.css`; the accent is not used for text.
- **Both languages.** Every new string lands in `core/i18n/en.json` and `de.json`; there is a test
  that the two have the same keys.
- **Both themes.** Light and dark come from one token set; the window bar must be checked in both.
- **`unsafe_code = "forbid"` stays set workspace-wide**, and the new Windows crate of §3.2 is the
  only thing outside it. No existing crate's lints change.
- **Tests are the checkpoint, as before.** Rust unit tests for the shell's tab registry and for the
  refuse-while-off-route rule; Vitest for the settings scroll-spy, the accordions, the tab strip
  and the chip's states; Playwright for the settings page in the browser build; and the hidden
  smoke run extended to two tabs and to a download decided up front. The Playwright screenshot
  specs (`e2e/settings-screenshots.spec.ts`, `e2e/shell.spec.ts`) will break on sight and need
  refreshing.
- **`pnpm verify` is not the whole gate, whatever the README says.** It runs neither Playwright
  nor the Windows-only smoke run; CI runs those. Work that only `verify` covers is not verified.
- **No window may be shown and no focus stolen by a test.** The hidden smoke run's rules are
  unchanged and apply to everything added here.

## 9. Left to the builder

- Which of the two window-frame routes in §3.2, decided by trying them.
- Whether the still picture is an `<img>` with a data URL, a blob URL, or a canvas, and how it is
  transported from Rust to the page.
- The tab cap, and the tab strip's behaviour when the tabs no longer fit (scroll, shrink, or
  overflow menu).
- The narrow-window treatment of the settings section menu (§4.4).
- Whether scroll-spy is an `IntersectionObserver` or a scroll handler, and what counts as "the
  section you are in" when two are visible.
- Module and component boundaries throughout; which new components go in `src/ui/`.
- The per-tab DTO shape, and how much of today's single-view `BrowseState` becomes per-tab.
- `CHROME_INSET.top` (100 CSS px today) has to grow for the taller chrome; the builder measures it.
- Commit granularity and the order of the three parts. They are independent: the window bar, the
  settings page and the browser page touch almost disjoint files, and the browser page is by some
  distance the largest.
