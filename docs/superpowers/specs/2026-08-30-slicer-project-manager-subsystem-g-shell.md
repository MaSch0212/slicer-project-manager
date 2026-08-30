# Subsystem G — Shell, navigation and settings

Status: draft
Date: 2026-08-30
Amends: subsystem A (settings storage), subsystem D (application menu, `/settings/slicers`
route), subsystem C (import entry point).

## 0. Where this comes from

This subsystem is the first of four segments answering a single round of user feedback on the
running application. The feedback is behavioural, not architectural: the app does what it was
specified to do, and the specification was wrong about what a person wants to look at.

The four segments and the boundary between them:

| Segment          | Owns                                                                         |
| ---------------- | ---------------------------------------------------------------------------- |
| **G (this one)** | app shell, navigation, settings page, application menu, notification surface |
| H                | the projects list page and its filter bar                                    |
| I                | the model browser and its downloads                                          |
| J                | the project detail page, its file list and the slicer round trip             |

The boundary is drawn by **file ownership**, because the segments run sequentially through
subagent-driven development and two writers in one tree is the failure this project has already
paid for. No segment touches a file another segment owns, except `styles.css` and the two locale
files, which every segment appends to and none rewrites.

**One deliberate deferral.** The feedback says the grid/list view-mode control belongs on the
projects page rather than in settings. Removing it here and adding it there would leave the
application without the control between two commits. G therefore **leaves `viewMode` in settings
untouched**; H moves it in one commit. This is the only item of the feedback that G declines, and
it declines it for atomicity, not for scope.

## 1. Measured starting state

Every claim below was read from the tree at `7b2aa63`, not recalled.

1. **Navigation is a `jig-toolbar` of text buttons** in `packages/web/src/app/app.ts`, projected
   into the toolbar's `end` placement inside a single `@if` over the auth/capability gate. Seven
   entries: Projects, Import, Browse, Settings, Admin, Change-folder, Sign-out.
2. **`packages/web/src/styles.css` contains no `@media` rule at all** (grepped: zero matches).
   The application has no responsive layer. "On mobile use a hamburger menu" therefore introduces
   the first breakpoint in the codebase, and this spec defines it rather than leaving each
   segment to invent one.
3. **Nothing in the application reads or writes `localStorage`.** `cura-hazard.store.ts` records
   this as a deliberate property, not an oversight. All persisted UI state goes through
   `SettingsDto`, which is stored server-side per user.
4. **`user_settings` stores strings.** `packages/core/src/users/account.ts` holds
   `SETTING_KEYS = ['theme','language','viewMode','sort','dir']`, reads every row as
   `string | null`, and merges with a `Record<string, string>` cast. There is no mechanism for a
   boolean or a list. Three of the four segments need one.
5. **The application menu carries two things**: the `Library` / `Choose library…` item
   (`CHOOSE_LIBRARY_ITEM`, driven by id from `remote.spec.ts`) and, via `role: 'viewMenu'`, the
   devtools toggle that `dev:desktop` means by "with devtools available". Its docblock states
   both, and both survive this subsystem.
6. **`/settings/slicers` is a real route** in `routes.electron.ts`, guarded by `authGuard`, and is
   reached only from a `routerLink` on the settings page. The slicers page renders a full `<main>`
   with its own heading and no way back.
7. **`withToasts()` is already registered** in `app.config.ts`. `withSnackbars()` is not.
8. **The settings page and the import page both use `spm-main--narrow`.** The slicers page,
   reached from settings, does not.

## 2. Global constraints

These bind every task in this subsystem. A task that cannot meet one of them stops and says so
rather than meeting it approximately.

- **C1 — No `localStorage`, no `sessionStorage`, no cookies from renderer code.** Persisted UI
  state goes through `SettingsStore`. State that must not persist lives in a root-provided signal
  store, as `CuraHazardStore` does. This is fact 3 above, kept.
- **C2 — Shared code must not import from `features/desktop/`.** `app.ts`, `settings.page.ts` and
  anything under `core/` are shared. Desktop-only surfaces are reached by a capability flag plus a
  `routerLink` string, never by an import. CI greps enforce this.
- **C3 — No component asks which shell it is running in.** Capability flags decide, exactly as
  `canPickLocalFolder` and `canConfigureSlicers` already do.
- **C4 — Every user-visible string is translated.** New copy lands in both `en.json` and `de.json`
  in the same commit. A key present in one and absent from the other is a defect.
- **C5 — UI copy addresses a user of the application.** It does not describe the implementation,
  does not cite measurements, does not say "I", and does not name internal concepts (a launch
  directory, a staged download, a classifier). See §8, which is normative.
- **C6 — Accessibility is not negotiable.** The sidebar is a `<nav>`; the collapse control is a
  `<button>` carrying `aria-expanded`; the mobile drawer is modal and traps focus; every icon-only
  control has an accessible name. Reduced motion is honoured.
- **C7 — `deno task verify` passes, and `deno task fmt:check` passes on every file the task
  touched, including Markdown.**

## 3. Settings storage: typed keys

The feedback needs a boolean setting now (sidebar collapsed) and segments H and I need list
settings (remembered tag filter, browser shortcuts). Fact 4 says the store handles neither.

### 3.1 What changes in `packages/core/src/users/account.ts`

`SETTING_KEYS` becomes a **codec table**: one entry per key, each naming how that key's value is
turned into a row value and back.

```ts
type SettingCodec<T> = {
  encode(value: T): string
  /** Returns `undefined` for a stored value this key cannot accept, so the default stands. */
  decode(raw: string): T | undefined
}
```

Three codecs are needed by this subsystem and the two after it:

- `enumCodec(values)` — identity encode; decode returns `undefined` unless the raw string is one
  of `values`. This is what all five existing keys use, and it is a **behaviour change**: today a
  `user_settings` row holding `"purple"` for `theme` is merged into the DTO verbatim and shipped
  to the renderer. Under this spec it is rejected and the default stands.
- `booleanCodec` — `'1'` / `'0'`; anything else decodes to `undefined`.
- `jsonCodec(schema)` — `JSON.stringify`; decode parses and validates against a Zod schema,
  returning `undefined` on either failure. **Unused by G**; specified here so H and I do not each
  invent one, and covered by a unit test of the codec itself and nothing more.

`getSettings` and `putSettings` iterate the table instead of a string array. `putSettings`
continues to write only the keys present in the patch.

### 3.2 Why the enum tightening is in scope

It is not gold-plating and it is not incidental. Without it, `navCollapsed` is the only key in the
table whose stored value is validated, and the next person to add a key copies whichever neighbour
they read first. The tightening is what makes the table a contract rather than a lookup. It is
also the smaller half of the change: the codec table has to exist either way.

**Test that proves it:** a `user_settings` row with `theme = 'purple'` yields
`DEFAULT_SETTINGS.theme` from `getSettings`, and does not yield `'purple'`.

### 3.3 The new key

```ts
/** Whether the navigation sidebar is collapsed to icons. Desktop layout only; see §4. */
navCollapsed: boolean
```

- `SettingsDto` gains `navCollapsed: boolean`.
- `DEFAULT_SETTINGS.navCollapsed = false` — the sidebar starts expanded.
- `settingsPatchSchema` gains `navCollapsed: z.boolean().optional()`.
- The codec table gains `navCollapsed: booleanCodec`.

No migration. A user with no row for the key gets the default, which is the mechanism already in
place for every key.

## 4. Navigation

### 4.1 The breakpoint

One breakpoint, defined once, in `styles.css`, and used by every segment after this one:

```css
/* The application's only breakpoint. Below it, the sidebar is a drawer. */
@media (max-width: 768px) { … }
```

768px, because it is the width at which a two-column shell stops having room for a 240px sidebar
beside a card grid, and because it is the conventional tablet-portrait line. It is not derived
from a measurement of this application and this spec does not pretend otherwise.

**The layout is driven by the viewport, not by a capability.** A narrow desktop window gets the
drawer, which is correct: the constraint is width, not device.

### 4.2 Desktop (above the breakpoint)

The shell becomes two columns: a persistent `<nav>` sidebar and the routed content.

- **Expanded** (default): 240px, each entry an icon plus its label.
- **Collapsed**: 64px, icons only. Every entry keeps its accessible name — the label is visually
  hidden, never removed from the accessibility tree — and gains a `jigTooltip` naming it, because
  an icon with no adjacent text is not self-describing.
- The collapse control is a single `<button>` at the sidebar's foot carrying
  `aria-expanded="true|false"` and an accessible name that does not change with state
  (`nav.toggle`). Its icon does change.
- The state is `settings.navCollapsed`, written through `SettingsStore.patch`. A failed write
  rolls back, as every other patch does, and reports through the snackbar (§7). A failed write
  must not leave the sidebar in a state that disagrees with the setting.
- The application brand and mark move into the sidebar head, where they replace the header. The
  header element is removed, not hidden.

### 4.3 Mobile (at or below the breakpoint)

- The sidebar is not rendered in the layout. A hamburger `<button>` appears in a slim top bar,
  with an accessible name (`nav.open`) and `aria-expanded`.
- Pressing it opens a `jig-drawer` with `modal="true"`, `position="start"`, carrying **the same
  navigation list component** as the desktop sidebar. One list, two hosts — the entries are not
  written twice. This is the cross-referenced-pair failure this project keeps finding, and the
  cheapest way not to have it is not to have a second copy.
- The drawer closes on navigation. A drawer left open over the page the user just navigated to is
  the defect this rule exists to prevent; a router event subscription closes it.
- `navCollapsed` has **no effect** on mobile. The drawer is always the full list.

### 4.4 The entries

In order, each gated exactly as it is today:

| Entry    | Gate                        | Route          |
| -------- | --------------------------- | -------------- |
| Projects | auth/capability gate        | `/projects`    |
| Browse   | `canBrowseModelSites`       | `/browse`      |
| Settings | auth/capability gate        | `/settings`    |
| Users    | `canManageUsers && isAdmin` | `/admin/users` |
| Sign out | `requiresAuth`              | action         |

**Import is gone from the navigation** (§6.2). **Change-folder is gone from the navigation**
(§6.1). Both move into settings. The gates on the surviving entries are copied, not re-derived —
a gate that changes here is a defect.

## 5. The application menu

The feedback asks for the Electron menu bar to be hidden.

**Decision: `autoHideMenuBar: true` on the `BrowserWindow`, and the menu itself is kept.**

Rejected: `Menu.setApplicationMenu(null)`. It would take the devtools toggle with it (fact 5),
which `dev:desktop` documents as available, and it would delete the item `remote.spec.ts` drives
by id — turning a passing test into a vacuous one rather than a failing one, which is precisely
the shape of dead test this project catalogues.

With `autoHideMenuBar`:

- The bar is not visible. `Alt` reveals it, which is the platform convention for a hidden menu and
  the escape hatch for devtools.
- macOS is unaffected: its menu lives in the system bar and cannot be hidden by an application. No
  branch is needed — Electron ignores the option there.
- `Library` / `Choose library…` still exists and still works, and is now the _second_ way to reach
  a function that also has a visible home in settings (§6.1). That is a deliberate redundancy: it
  is the recovery path when the renderer will not start.

**Unmeasured, and stated as such:** whether `autoHideMenuBar` behaves identically on the Linux
desktop environments this project has never run on. macOS and Linux remain unmeasured across
subsystems D, E, F and now G. This is recorded debt for the subsystems and a blocker for a
release, not for this segment.

## 6. The settings page

The page becomes a `jig-tabs` host in **navigation mode** — tabs with no `#content` template, a
`<router-outlet />` below them, and `activeTab` driven from the URL. This is the documented jig
pattern for router-backed tabs, and it is what keeps `/settings/slicers` a real, deep-linkable,
guarded route rather than a component-local flag.

- `/settings` renders the General tab.
- `/settings/slicers` renders the Slicers tab. **The route does not change**, so no bookmark, test
  or capability gate moves.
- The Slicers tab header is rendered only when `canConfigureSlicers` is true — the same flag that
  gates the link today. In the web build the route does not exist and the tab is absent.
- The "no way back" problem in the feedback dissolves: the tab strip is the way back, and it is
  visible from the slicers view because it is above the outlet.

Restructuring `/settings` into a parent route with children is a shared-routes change, and
`routes.shared.ts` is shared by both builds while `settings/slicers` exists only in the desktop
build. The parent/child arrangement must therefore keep the two files' shapes agreeing: the
shared file declares the parent and the General child; the electron file appends the Slicers
child. If that cannot be done without the two builds disagreeing about a route they both have,
the fallback is to keep both as sibling routes and drive `activeTab` from the URL — the tab strip
is a navigation control either way, and this spec does not require a particular route tree, only
that both URLs keep working and both tabs stay reachable.

### 6.1 Library location

A card in the **General** tab, rendered only when `canPickLocalFolder` is true, showing the
library the shell has open and offering two actions:

- **Choose folder** — `api.library.pick()`. Unchanged behaviour: `null` on cancel is not a
  failure, and the shell reloads the window itself on success.
- **Connect to a server** — reveals an input for the server URL and calls
  `api.library.connect(url)`. Also `null` on cancel, also a shell-driven reload on success.

Both already exist on `ApiClient` (`library.pick`, `library.connect`) and both are already refused
by `HttpApiClient`. **No new IPC, no new capability, no main-process change.** The feedback's
"should also give the user the option to connect to a server instead" is a UI that was never built
over a transport that was.

The URL is validated before the call with a schema that accepts `http:` and `https:` **and no
other scheme**. `z.url()` alone does not do this — it accepts `javascript:`, which is recorded
debt elsewhere in this project and must not be re-introduced here.

### 6.2 Import

The import surface moves into the **General** tab as a card, and its route is kept (`/import`
still resolves) so existing links keep working. The navigation entry is removed.

The card contains the upload control and the result reporting the import page already has; the
behaviour is reused, not reimplemented. `ImportPage` renders its own `<main>` today, so extracting
the body into a component that both the card and the route render is the change.

### 6.3 Layout

`spm-main--narrow` is removed from the settings page. The settings surface takes the available
width up to a readable maximum, and the Slicers tab — a table of installs — takes the full width.
The narrow measure stays where it belongs, on the auth pages.

## 7. Notifications

`withSnackbars()` is registered in `app.config.ts` beside the already-present `withToasts()`.

**Snackbars are for the result of an action the user just took.** That is jig's own framing and it
is the right split for this application. A thin `NotifyService` in `core/` wraps
`injectSnackbarCreator()` so that call sites say `notify.error(...)` rather than assembling
options, and so a later change of surface touches one file.

Adopted in this subsystem, replacing an inline `jig-message` banner in each case:

| Where                  | Today                                      | Becomes          |
| ---------------------- | ------------------------------------------ | ---------------- |
| Sign-out failure       | `signOutFailed` banner under the header    | error snackbar   |
| Library change failure | `changeFolderFailed` banner                | error snackbar   |
| Settings save failure  | `saveFailed` banner at the top of the page | error snackbar   |
| Import failure         | inline `jig-message`                       | **stays inline** |
| Import success         | inline `jig-message`                       | **stays inline** |

The import result stays inline deliberately: it is a multi-line report with counts and a follow-up
link, it is the outcome of a long operation the user waited for, and a snackbar that auto-hides
after five seconds is the wrong container for something a person reads. **A banner is not a
defect; a banner used for a transient acknowledgement is.**

A `jig-message` that is a _persistent statement about the current state_ — a project is missing, a
slicer install has gone — is never converted to a snackbar, in this or any later segment.

## 8. UI copy

Constraint C5, made concrete. This subsystem sweeps the copy it owns: the shell, the settings
page, the import page, the slicers page, and the corresponding sections of both locale files.
Segments H, I and J sweep their own.

A string is rewritten when it does any of these:

1. **Describes the implementation.** "Handed _file_ to _slicer_" is honest and is exactly the kind
   of sentence that reads as an error message. The user needs to know the slicer was started, and
   needs to know the app cannot promise the file opened; that is one short sentence, not a
   description of a spawn.
2. **Cites a measurement or an investigation.** No UI string says what was measured, on which
   machine, or that anything was verified.
3. **Speaks in the first person, or about the application in the third.** No "I", no "the app
   refuses".
4. **Names an internal concept.** Launch directory, staged download, classifier, orphan,
   partition, session id. Where the concept must surface, it surfaces in the user's terms.
5. **Explains a rule the user did not ask about.** Warnings state the risk and the choice.

**What is not swept:** code comments and docblocks. This project's comments are long on purpose
and carry the measurements the code depends on. C5 is a rule about strings a user reads, and a
task that trims a docblock under cover of it has misread this section.

The German file is swept with the English one. A rewritten `en` key whose `de` value still says
the old thing is the half-swept pair this project has found repeatedly.

## 9. Acceptance

The subsystem is done when all of these hold.

1. `deno task verify` exits 0; `deno task test:desktop` passes; `fmt:check` and lint are clean.
2. The desktop shell shows a sidebar. Collapsing it, reloading the window, and finding it still
   collapsed works — and the value is in `user_settings`, not in the renderer.
3. At 700px viewport width there is no sidebar and a hamburger opens a modal drawer whose entries
   navigate and whose drawer then closes.
4. The Electron window opens with no visible menu bar, and `Alt` reveals one containing both
   `Choose library…` and the devtools toggle.
5. `/settings/slicers` typed into the address bar of the desktop build lands on the settings page
   with the Slicers tab active, and the General tab is one click away.
6. The settings General tab offers a folder picker and a server connect, and the connect input
   rejects `javascript:alert(1)` without calling the transport.
7. Import is reachable from settings and from `/import`, and is absent from the navigation.
8. A failed settings save shows a snackbar and the control returns to its previous value.
9. No string in the files this subsystem owns violates §8. The two locale files have identical key
   sets.
10. No file under `features/desktop/` is imported by shared code; the CI bundle greps still pass.

## 10. Out of scope, recorded

- The projects page, the browser, and the project detail page (segments H, I, J).
- `viewMode` moving out of settings (§0).
- macOS and Linux verification (§5).
- `createProjectSchema.website` accepting `data:` and `javascript:` — pre-existing debt in the
  contract, reachable from segment J's write paths, and not widened here. §6.1's connect input
  gets its own scheme check rather than waiting for that fix.
