# Plan — Subsystem G: shell, navigation and settings

Spec: `docs/superpowers/specs/2026-08-30-slicer-project-manager-subsystem-g-shell.md`

## Global Constraints

Copied from spec §2. These bind every task.

- **C1** — No `localStorage`, `sessionStorage` or cookies from renderer code. Persisted UI state
  goes through `SettingsStore`; non-persisted state lives in a root-provided signal store.
- **C2** — Shared code (`app.ts`, `core/**`, `features/settings/**`, `features/import/**`,
  `routes.shared.ts`) must not import from `features/desktop/`. CI greps enforce this.
- **C3** — No component asks which shell it is running in. Capability flags decide.
- **C4** — Every user-visible string is translated, and lands in **both** `en.json` and `de.json`
  in the same commit. Identical key sets.
- **C5** — UI copy addresses a user. No implementation description, no measurements, no "I", no
  internal concepts. Spec §8 is normative. **Docblocks and code comments are not swept.**
- **C6** — `<nav>` for the sidebar; `aria-expanded` on the collapse and hamburger buttons; the
  mobile drawer is modal; every icon-only control has an accessible name; reduced motion honoured.
- **C7** — `deno task verify` exits 0 and `deno task fmt:check` passes on every touched file,
  Markdown included.

## Ordering rationale

The order is chosen so **no function is ever unreachable between two commits**. Task 6 gives the
library picker and the import surface a home in settings _before_ task 7 removes them from the
navigation. Reversing those two would leave a commit where changing the library folder is
reachable only from the application menu that task 3 has just hidden.

## Task 1 — Typed settings storage and `navCollapsed`

Spec §3.

**Files:** `packages/contract/src/dtos.ts`, `packages/contract/src/schemas.ts`,
`packages/core/src/users/account.ts`, plus core tests.

1. Introduce `SettingCodec<T>` with `encode(value: T): string` and
   `decode(raw: string): T | undefined`.
2. Implement `enumCodec(values)`, `booleanCodec` (`'1'`/`'0'`) and `jsonCodec(schema)`.
3. Replace `SETTING_KEYS` with a codec table keyed by every `SettingsDto` key. `getSettings` and
   `putSettings` iterate the table. `putSettings` still writes only the keys in the patch.
4. Add `navCollapsed: boolean` to `SettingsDto`, `false` to `DEFAULT_SETTINGS`,
   `z.boolean().optional()` to `settingsPatchSchema`, and `booleanCodec` to the table.

**Tests that must exist and must be able to fail:**

- A `user_settings` row of `theme = 'purple'` yields `DEFAULT_SETTINGS.theme`, **not** `'purple'`.
  Mutate the codec's guard to confirm the test goes red.
- `navCollapsed` round-trips `true` and `false` through `putSettings`/`getSettings`.
- A `navCollapsed` row holding garbage (`'yes'`) yields the default.
- `jsonCodec` decodes a valid payload and returns `undefined` for both malformed JSON and JSON
  that fails the schema. `jsonCodec` has no production caller in this subsystem; do not add one.

**Do not** add a migration. An absent row already falls back to the default.

## Task 2 — Notification service

Spec §7.

**Files:** `packages/web/src/app/app.config.ts`, new `packages/web/src/app/core/notify.service.ts`
and its spec.

1. Register `withSnackbars()` beside the existing `withToasts()`.
2. `NotifyService`, root-provided, wrapping `injectSnackbarCreator()`. Methods: `success(message)`,
   `error(message)`, `info(message)`. Each takes an already-translated string — the service does
   not reach into `TranslateService`, so call sites stay responsible for their own keys and the
   service stays testable without a translation fixture.
3. Errors are `closable` and announce assertively (jig derives this from `color: 'error'`; do not
   override `ariaLive`).

**Do not** change `app.ts` in this task. **Do not** convert any existing banner yet.

**Test:** each method calls the injected creator once with the expected `color`, using a fake
creator. Confirm the test fails when `error` is made to pass `color: 'success'`.

## Task 3 — Hide the Electron menu bar

Spec §5.

**Files:** `packages/desktop/src/app.ts` (window creation), plus a desktop test.

1. Set `autoHideMenuBar: true` on the main `BrowserWindow`.
2. **Keep `buildMenu` and `Menu.setApplicationMenu` exactly as they are.** The `Choose library…`
   item and the devtools toggle both survive.
3. Extend `buildMenu`'s docblock with the reason the bar is hidden and the menu retained.

**Test:** the created window's options carry `autoHideMenuBar: true`, and `CHOOSE_LIBRARY_ITEM` is
still resolvable from the application menu. The existing `remote.spec.ts` menu-driving test must
still pass unchanged — if it needs editing, stop: that means the item moved and the spec says it
must not.

## Task 4 — Settings page becomes tabs

Spec §6 and §6.3.

**Files:** `packages/web/src/app/features/settings/settings.page.ts`,
`packages/web/src/app/routes.shared.ts`, `packages/web/src/app/routes.electron.ts`,
`packages/web/src/app/features/desktop/slicers/slicers.page.ts`,
`packages/web/src/styles.css`, both locale files, and the two page specs.

1. `SettingsPage` renders `jig-tabs` in navigation mode: tab headers only, `<router-outlet />`
   below, `activeTab` derived from the URL and `(activeTabChange)` navigating.
2. General tab content moves into a new child component so the outlet has something to render.
   Language, theme and **viewMode stay exactly as they are** — spec §0 defers the viewMode move to
   segment H. Do not touch it.
3. Slicers tab header renders only when `canConfigureSlicers`.
4. `/settings` and `/settings/slicers` both keep working, both stay `authGuard`ed, and
   `/settings/slicers` stays out of the web build. Prefer a parent route with children; if the
   shared/electron route files cannot both express that without disagreeing about a route they
   both have, keep them as siblings and drive `activeTab` from the URL. Either is acceptable —
   both URLs working is not.
5. `SlicersPage` drops its own `<main>` and its `<h1>`: it is now a panel inside the settings page,
   and a second `<main>` on the page is invalid. Its content is otherwise unchanged.
6. Drop `spm-main--narrow` from the settings page; give the settings surface a wide readable
   maximum. The narrow measure stays on the auth pages.

**Test:** navigating to `/settings/slicers` activates the Slicers tab; the General tab is present
and reachable; the Slicers tab header is absent when `canConfigureSlicers` is false.

## Task 5 — Library location and import cards

Spec §6.1 and §6.2.

**Files:** the settings General component from task 4,
`packages/web/src/app/features/import/import.page.ts` (extract its body),
`packages/contract/src/schemas.ts` (server URL schema), both locale files, specs.

1. Extract the import page's body into a component both the `/import` route and the settings card
   render. `/import` keeps resolving.
2. Library card, gated on `canPickLocalFolder`: a **Choose folder** action calling
   `api.library.pick()`, and a **Connect to a server** action revealing a URL input and calling
   `api.library.connect(url)`.
3. `null` from either is a cancel, not a failure. Success needs no local handling — the shell
   reloads the window. A rejection reports through `NotifyService.error`.
4. New schema `serverUrlSchema` accepting **only** `http:` and `https:`. `z.url()` on its own does
   not do this. Validate before calling the transport.

**Tests that must exist and must be able to fail:**

- `serverUrlSchema` rejects `javascript:alert(1)`, `data:text/html,x`, `file:///c:/`, and accepts
  `https://example.invalid:8443/`.
- Submitting `javascript:alert(1)` in the connect input does **not** call `api.library.connect`.
  Assert on the transport double's call count, not on a rendered message.
- A rejecting `library.pick()` notifies an error.

## Task 6 — Sidebar navigation

Spec §4. The largest task; expect it to need judgment.

**Files:** `packages/web/src/app/app.ts`, a new navigation-list component under
`packages/web/src/app/core/`, `packages/web/src/styles.css`, both locale files, `app.spec.ts`.

1. One `SpmNavList` component owning the entries and their gates. **Rendered by both the desktop
   sidebar and the mobile drawer.** Two copies of the entry list is the defect this task exists to
   avoid.
2. Shell becomes two columns above 768px: `<nav>` sidebar plus routed content. The `<header>` and
   its `jig-toolbar` are removed; the brand moves into the sidebar head.
3. Collapse control at the sidebar foot: `<button>`, stable accessible name, `aria-expanded`,
   changing icon. Collapsed is 64px, icons only, labels visually hidden but present in the
   accessibility tree, each entry tooltipped.
4. Collapse state reads and writes `settings.navCollapsed` via `SettingsStore.patch`; a rejection
   notifies through `NotifyService` and the sidebar follows the rolled-back setting rather than a
   local signal that has drifted from it.
5. At or below 768px: no sidebar, a slim bar with a hamburger `<button>` opening a
   `jig-drawer` (`modal`, `position="start"`). The drawer closes on router navigation.
   `navCollapsed` is ignored on mobile.
6. Entries and gates per spec §4.4. **Import and Change-folder are removed from the navigation**;
   task 5 has already given both a home. Every surviving gate is copied verbatim from today's
   `app.ts` — a changed gate is a defect.
7. `signOutFailed` and `changeFolderFailed` banners are replaced by `NotifyService.error`. The
   change-folder handler itself leaves `app.ts` with the button.
8. Add the single `@media (max-width: 768px)` breakpoint to `styles.css`, plus a
   `prefers-reduced-motion` guard on the sidebar and drawer transitions.

**Tests that must exist and must be able to fail:**

- The nav entry list renders once, not twice, when both hosts are in the DOM.
- Each gate: browse hidden without `canBrowseModelSites`; users hidden without
  `canManageUsers && isAdmin`; sign-out hidden without `requiresAuth`.
- Collapsing calls `patch({ navCollapsed: true })`; a rejecting patch notifies an error and leaves
  the rendered state matching the store.
- The drawer closes on a router navigation event.

## Task 7 — UI copy sweep

Spec §8.

**Files:** both locale files, and any of this subsystem's own templates holding a literal string.
**Owned surfaces only:** shell/navigation, settings, import, slicers. Do not touch the projects
page, the project detail page, the viewer or the browser — segments H, I and J sweep their own,
and editing them here creates the merge this segmentation exists to prevent.

1. Apply spec §8's five rules to every owned string.
2. Sweep `de.json` with `en.json`. A rewritten English value whose German still says the old thing
   is the specific half-swept failure this project has hit repeatedly.
3. Verify the two files have identical key sets — and add a test that asserts it, so the next
   segment cannot half-sweep silently.

**Do not** touch docblocks or code comments. C5 governs strings a user reads.

**Test:** `en.json` and `de.json` have identical key sets, recursively. Confirm it fails by
temporarily deleting a key from one.

## Whole-branch review focus

- Does any gate in the navigation differ from the gate that guarded the same entry at `7b2aa63`?
- Is the navigation entry list written exactly once?
- Does any commit in this branch leave the library picker or the import surface unreachable?
- Did the copy sweep reach `de.json` everywhere it reached `en.json`?
- Did any task edit a docblock under cover of C5?
- Does `getSettings` still return a usable DTO when a row holds a value no codec accepts?
