# Plan — Subsystem H: the projects page

Spec: `docs/superpowers/specs/2026-08-31-slicer-project-manager-subsystem-h-projects.md`

## Global Constraints

Copied from spec §2. These bind every task.

- **C1** — No `localStorage`, `sessionStorage` or cookies. Persisted UI state goes through
  `SettingsStore`.
- **C2** — Shared code must not import from `features/desktop/`. CI greps enforce this.
- **C3** — No component asks which shell it is running in. Capability flags decide.
- **C4** — Every user-visible string translated, both `en.json` and `de.json`, same commit,
  identical key sets, real German in the formal register (_Sie_).
- **C5** — UI copy addresses a user (spec G §8's five rules, normative here). **Docblocks and code
  comments are not swept.**
- **C6** — Accessibility: icon-only controls have accessible names that do not change with state;
  toggles carry `aria-pressed`; disclosures carry `aria-expanded`; **more rows must be reachable
  without a mouse**.
- **C7** — `deno task verify` exits 0; `fmt:check` clean on every touched file, Markdown included.
- **C8** — **Do not add an e2e spec that logs in.** Reuse the shared `storageState`; the suite
  spends eight of ten permitted logins per minute and is two from breaking `viewer.spec.ts`.

## Ordering rationale

Ordered so **no function is ever unreachable between two commits**, which is the rule segment G
was sequenced around and which bites harder here. In particular: task 4 introduces paging, and the
moment it lands the list stops showing everything. So **task 4 ships the "Load more" control with
it** — a control spec §7.5 requires permanently anyway for C6 — rather than leaving rows 49+
unreachable until task 6 adds the scroll trigger. Task 6 then layers automatic loading on top of a
mechanism that already works.

Task 5 moves `viewMode` out of settings and onto the page **in one commit**, for the same reason
segment G declined to do half of it.

## Task 1 — Paging in the query path

Spec §3.1, §3.2.

**Files:** `packages/contract/src/dtos.ts`, `packages/contract/src/schemas.ts`,
`packages/core/src/projects/queries.ts`, core tests.

1. `ProjectQuery` gains optional `limit` and `offset`. `projectQuerySchema` gains
   `limit: z.number().int().positive().max(200).optional()` and
   `offset: z.number().int().nonnegative().optional()`.
2. `listProjects` applies them. **`limit` omitted returns every row**, exactly as today — the
   change is additive and no existing caller changes.
3. **Append `p.id ASC` as a final tiebreaker to every sort.** Always `ASC`, never following `dir`.

**Tests that must exist and must be able to fail:**

- Two projects with an **identical** `updated_at`, fetched as two pages of one row each, yield the
  two distinct projects — not one twice, not one missing. **Write the fixture so the timestamps
  genuinely match**; a fixture whose rows differ by a millisecond tests nothing, and proving that
  is part of the task: mutate the fixture to differ and show the test still passes, then restore.
- `offset` beyond the end returns an empty array, not an error.
- No `limit` returns everything (the old behaviour, pinned so a later change cannot quietly break
  every existing caller).

## Task 2 — The tag list API

Spec §4.

**Files:** `packages/contract/src/api-client.ts`, `packages/core/src/projects/queries.ts`,
`packages/core/src/index.ts`, `packages/server/src/routes/projects.ts`,
`packages/desktop/src/dispatch.ts`, tests in core, server and desktop.

1. `ApiClient.projects.tags(): Promise<string[]>` — distinct tag names in the user's library,
   sorted case-insensitively.
2. Core `listTags(lib, ctx)`, scoped by `ctx.userId` exactly as `listProjects` is. There must be no
   unscoped variant to call by mistake.
3. `GET /api/projects/tags` on the server; a `projects.tags` entry in the desktop dispatch.
4. **Register the literal path before `GET /api/projects/:id`.** Otherwise the id route matches
   `tags` and answers `NotFound`.

**Tests that must exist and must be able to fail:**

- `GET /api/projects/tags` returns the tag list. **Mutation: register it after the `:id` route and
  confirm the test goes red** — that is the only thing proving the ordering is load-bearing.
- Another user's tags are not returned.
- Tags differing only in case are returned once, matching how `listProjects` already de-duplicates.

## Task 3 — Remembered filter settings

Spec §5.

**Files:** `packages/contract/src/dtos.ts`, `packages/contract/src/schemas.ts`,
`packages/core/src/users/account.ts`, core and contract tests.

1. `SettingsDto` gains `includeArchived: boolean` and `filterTags: string[]`; `DEFAULT_SETTINGS`
   gains `false` and `[]`; `settingsPatchSchema` gains both.
2. Codec table gains `includeArchived: booleanCodec` and
   `filterTags: jsonCodec(z.array(tagNameSchema).max(50))`. **This is `jsonCodec`'s first
   production use** — it was written in segment G for exactly this.

**Tests that must exist and must be able to fail:**

- `filterTags` round-trips a list.
- A stored `filterTags` that fails the schema (`'["a", 1]'`), and one that is not JSON at all,
  each yield `[]`.
- Extend segment G's literal `DEFAULT_SETTINGS` pin in `packages/contract/test/dtos.test.ts` to
  cover both new keys, and prove it by mutating each default. **That pin exists because a default
  once ended up pinned nowhere in the repo** — do not add keys without extending it.

**Ruling carried from segment G:** adding keys to `SettingsDto` breaks every full-object literal.
Spreads of `DEFAULT_SETTINGS` are safe; literals are not. Sweep the whole repo.

## Task 4 — Store paging, tags resource, remembered filter, and "Load more"

Spec §3.3, §4, §5, §7.5's keyboard requirement.

**Files:** `packages/web/src/app/features/projects/projects.store.ts`,
`projects.page.ts` (the list and its footer only — the filter bar is task 5), both locale files,
store and page specs.

1. The store accumulates pages of **48** instead of replacing. Any filter change resets to page
   zero and replaces; reaching the end appends.
2. **Appends de-duplicate by project id.** A short page means the end.
3. **Refuse overlapping loads.** A second request must not start while one is in flight.
4. `knownTags` is replaced by the `projects.tags()` resource. **Keep the existing rule** that
   selected tags are folded into the rendered list so an active filter always has a control to
   switch it off — its reason is unchanged and its docblock should survive.
5. `includeArchived` and `filterTags` seed from settings on construction and persist on change,
   optimistically. **A failed persist must not prevent the filter applying locally** — it shows an
   error snackbar via `NotifyService` and the list still does what the user asked.
6. Add the **"Load more"** button, shown whenever more rows exist. This is the keyboard-reachable
   path C6 requires, and until task 6 it is also the only path.

**Tests that must exist and must be able to fail:**

- A filter change replaces rather than appends. (Mutation: make it append; the test must go red.)
- A page whose rows overlap the previous one does not duplicate them in the list.
- A second load does not start while one is in flight.
- A rejected settings persist still applies the filter locally and notifies an error.

## Task 5 — The filter bar

Spec §6, §7.1–§7.4.

**Files:** `packages/web/src/app/features/projects/projects.page.ts`,
`packages/web/src/app/features/settings/general.tab.ts`, `packages/web/src/styles.css`,
both locale files, both page specs.

1. Search: one input, no visible label, placeholder, `max-width: 350px`, **`aria-label` so the
   accessible name survives**. Debounced.
2. Sort: `jig-select`, label omitted, icon inside, **minimum width so the value is not clipped**,
   **popup wide enough for "Recently updated" / "Zuletzt geändert" on one line**. Accessible name
   preserved. Verify icon placement against the installed `@awdlab/jig`; if adornments do not
   compose with `jig-select`, say so and use the nearest control that does rather than faking it.
3. Archived: **one** button, two icons, `aria-pressed`, **accessible name that does not change with
   state**, tooltip.
4. Tags: dropdown button with `aria-expanded` and a **count badge only when tags are selected**;
   `jig-list-box` with `selectable` + `multiple` inside. AND semantics unchanged — do not touch
   core's filtering.
5. **`viewMode` moves here in this same commit**: removed from `general.tab.ts`, added to the
   trailing group, still writing `settings.viewMode`. Move its translation keys with it.
6. **Delete the `general.tab.ts` docblock recording segment G's deferral** — it becomes false the
   moment you move the control. Then ask the second-sweep question across the repo: what else
   described `viewMode` as living in settings?

**Tests that must exist and must be able to fail:** each control's accessible name; the badge
absent at zero selected and present above; `aria-pressed` tracking the archived state; the sort
control keeping its accessible name without a visible label.

## Task 6 — Automatic loading on scroll

Spec §7.5.

**Files:** `projects.page.ts`, `styles.css`, page spec, one e2e assertion.

1. `jigScrollAmount` with `(endReached)` and a non-zero `jigScrollAmountEndThreshold`.
2. **Reuse task 4's guard** — do not write a second one. jig's own docs say edge-triggering removes
   repeated fires, not a request in flight while the user scrolls across the threshold.
3. A spinner in the list while a page loads.
4. **"Load more" stays.** It is not replaced by the scroll trigger; C6 requires it.
5. Confirm which element actually scrolls before wiring the directive; use
   `jigScrollAmountContainer` if it is not the host.

**Test:** an e2e assertion that scrolling loads more rows. **C8: reuse the shared `storageState`;
do not add a spec that logs in.** Prove it red by removing the `endReached` binding.

## Task 7 — New project from the page head

Spec §8.

**Files:** `projects.page.ts`, both locale files, page spec, e2e.

1. Remove the `<form>` below the filter card. Put a **New project** button beside **Rescan
   library**.
2. It opens a popover with the name field and a create button; `aria-expanded` on the button;
   focus into the field on open and back to the button on close.
3. Same `createProjectSchema` validation as today.
4. **Navigate to the created project on success.** Acceptance criterion 14.
5. On failure the typed name stays and an error shows.

**Tests that must exist and must be able to fail:** creating navigates to `/projects/:id` (mutate
the navigation away and confirm red); an invalid name does not call `create` (assert on the
transport double's **call count**, not on a rendered message).

## Task 8 — Copy sweep for the projects section

Spec §9, and spec G §8's five rules.

**Files:** both locale files, `projects.page.ts`, `projects.store.ts`, specs.

1. Apply the five rules to the projects section only.
2. Sweep `de.json` with `en.json`, string by string, not English-first.
3. **List, do not fix**, anything found in `project-detail.page.ts`, the viewer or the browser —
   those are segments I and J. Segment G's handoff table listed `projects.handedTo` and
   `projects.curaHazard` as "H or J"; both are used only in `project-detail.page.ts`, so **they are
   J's and this task leaves them alone.**
4. Before shipping any rewritten string, **ask what the code actually does and whether the new
   sentence is still true of it.** Segment G's sweep shortened two strings into falsehoods; that is
   the failure to avoid.

**Test:** the locale key-set parity test added in segment G still passes; extend it if this segment
adds a nesting shape it does not cover.

## Whole-branch review focus

- Does any commit leave rows beyond the first page unreachable?
- Is the tiebreaker actually load-bearing — does removing it break the tied-timestamp test?
- Does `GET /api/projects/tags` survive being registered after `:id`? (It must not.)
- Did `viewMode`'s move leave any text claiming it lives in settings?
- Does a rejected settings persist still apply the filter locally?
- Is there exactly one overlapping-load guard, or did task 6 add a second?
- Did the copy sweep shorten any string into something untrue?
