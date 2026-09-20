# Subsystem H — The projects page

Status: draft
Date: 2026-08-31
Second of the four segments answering one round of user feedback. Segment G (shell, navigation,
settings) is complete at `b0eacd7`. Amends: subsystem A (project queries, settings storage),
subsystem G (the `viewMode` deferral it recorded).

## 0. Where this comes from

The user's feedback on the projects page, verbatim:

> - The setting which view to use (list or grid) should be on this page instead of in the settings
> - When showing archived projects, all are loaded at once, which can be quite a lot - add
>   infinite scroll to the list
> - The filter should be remembered
> - The sort select should have a minimum width, so the label is not cut off. Also the dropdown is
>   wrapping "Recently updated", make the popup wide enough so all entries fit horizontally.
> - I do not like the whole filter section right now. Please change it like the following:
>   - left a search box with max-width of 350px (without search label and instead a "search"
>     placeholder)
>   - right next to the search box: sort (use an icon inside the select and omit the label);
>     archived (use a button that toggles between two icons for whether archived projects are
>     shown or not); tags (multi-select dropdown button that shows how many tags are selected as
>     a badge)
>   - Instead of having the name and new project button under the filter, add just the "New
>     project" button next to the "Rescan library" button and then reveal a dropdown where users
>     can type in the name and then create it. Also the project should be navigated to after it
>     has been created.

**This segment owns** `features/projects/projects.page.ts`, `projects.store.ts`, the project query
path through the contract, core and both transports, and the projects section of both locale
files. It also removes `viewMode` from the settings General tab, which segment G deliberately left
in place so the control was never missing between two commits.

**It does not own** `project-detail.page.ts`, the viewer, or the model browser. Segment G's
handoff table listed `projects.handedTo` and `projects.curaHazard` as "H or J"; both are used only
in `project-detail.page.ts`, so **they are J's**. This segment leaves them alone.

## 1. Measured starting state

Read from the tree at `b0eacd7`, not recalled.

1. **`listProjects` has no `LIMIT` and no `OFFSET`.** `packages/core/src/projects/queries.ts:151`
   builds one `SELECT p.* … ORDER BY <column> <dir>` and returns every matching row, then runs
   three follow-up queries (tags, file counts, covers) over all of those ids. The user's "all are
   loaded at once" is literally true at the database.
2. **The `ORDER BY` has no tiebreaker.** `SORT_COLUMNS` maps to `p.name COLLATE NOCASE`,
   `p.created_at` and `p.updated_at`, and the query orders by that column alone. **None of the
   three is unique.** A rescan stamps many projects with the same `updated_at`, and two projects
   may share a name. This does not matter while every row is returned in one go. It matters the
   moment paging exists: SQLite may order tied rows differently between two queries, so a row can
   appear on both pages or on neither. **Paging without a deterministic order is a defect
   generator, and this spec treats adding the tiebreaker as part of paging, not as a cleanup.**
3. **There is no tags API.** `ProjectsStore.knownTags` derives the tag list from the projects
   currently loaded, folding in whatever is already selected so an active filter always has a
   button. That is correct today because "loaded" means "all of them". **Under paging it silently
   becomes "the tags on the first 48 projects"**, which is a wrong list presented as a complete
   one.
4. **`viewMode` lives in the settings General tab** (`features/settings/general.tab.ts`), read by
   `projects.page.ts` as `settings.settings().viewMode` to pick a CSS class. Its docblock records
   that G deferred the move.
5. **The filter state is not persisted.** `ProjectsStore` seeds `sort` and `dir` from settings and
   holds `search`, `tags` and `includeArchived` in a signal that resets on every visit.
6. **Settings storage takes typed keys.** Segment G replaced the string-keyed list with a codec
   table in `packages/core/src/users/account.ts`; `enumCodec`, `booleanCodec` and `jsonCodec` all
   exist, and **`jsonCodec` has no production caller yet** — it was written for this segment.
7. **The create form sits below the filter card**, as a `<form>` with a labelled name field and a
   submit button, and on success it clears the field and reloads the list **without navigating**.
8. **`deno task verify` is green** at contract 30, core 404, desktop unit 464, icons 11, web 439,
   server 92; `test:desktop` 76; `e2e` 17.
9. **The e2e suite spends eight of ten permitted logins per minute.** Four navigation specs share
   one captured `storageState` for this reason. Two more login-using specs break `viewer.spec.ts`.

## 2. Global constraints

- **C1 — No `localStorage`, `sessionStorage` or cookies.** Persisted UI state goes through
  `SettingsStore`.
- **C2 — Shared code must not import from `features/desktop/`.** CI greps enforce this.
- **C3 — No component asks which shell it is running in.** Capability flags decide.
- **C4 — Every user-visible string is translated**, in both `en.json` and `de.json`, same commit,
  identical key sets, real German in the formal register (_Sie_).
- **C5 — UI copy addresses a user.** Spec G §8's five rules apply unchanged and are normative
  here. **Docblocks and code comments are not swept.**
- **C6 — Accessibility.** Every icon-only control has an accessible name that does not change with
  state; a toggle carries `aria-pressed`; a disclosure carries `aria-expanded`; the tag
  multi-select is keyboard operable; **infinite scroll has a keyboard-reachable equivalent**
  (§7.5).
- **C7 — `deno task verify` exits 0; `fmt:check` clean on every touched file.**
- **C8 — Do not add an e2e spec that logs in.** Reuse the shared `storageState`. The suite is two
  logins from breaking (fact 9).

## 3. Paging

### 3.1 Contract

`ProjectQuery` gains two optional fields:

```ts
/** How many rows to return. Omitted means "all of them", which is what every caller did before. */
limit?: number
/** How many rows to skip. Only meaningful with `limit`. */
offset?: number
```

`projectQuerySchema` gains `limit: z.number().int().positive().max(200).optional()` and
`offset: z.number().int().nonnegative().optional()`.

**`limit` omitted keeps the old behaviour.** Every existing caller — the desktop dispatch, the
server route, every test — continues to work unchanged, and this is what keeps the change additive
rather than a migration.

### 3.2 The order must become deterministic

`listProjects` appends `p.id` as a final tiebreaker to every sort:

```sql
ORDER BY <column> <dir>, p.id ASC
```

`p.id` is the primary key, so the composite is total and the order is reproducible between two
queries with different offsets. The direction of the tiebreaker is always `ASC` and does not
follow `dir`: it is there to break ties, not to be meaningful.

**Test that proves it:** two projects with an identical `updated_at`, fetched as two pages of one
row each, yield the two distinct projects — not the same one twice, and not one of them missing.
Write the fixture so both rows genuinely share a timestamp; a fixture whose timestamps differ by a
millisecond tests nothing.

### 3.3 Client paging

`ProjectsStore` keeps a page size of **48** — divisible by 2, 3, 4 and 6, so the grid's last row
is full at every column count this layout produces.

The store holds an accumulated list rather than replacing it:

- Changing any filter (search, tags, archived, sort, dir) **resets** to page zero and replaces the
  list. A filter change that appended would show the previous filter's results.
- Reaching the end appends the next page.
- **Appends de-duplicate by project id.** With offset paging over a live table, a project created
  or renamed between two requests can shift rows across the boundary. The tiebreaker (§3.2) makes
  the order stable for a _static_ table; it cannot make it stable for one being written to. De-
  duplication is the honest mitigation, and this spec states plainly that a row inserted above the
  current offset between two pages can still be missed until the next filter change or reload.
  Cursor paging would fix that; it is not worth the complexity for a personal model library, and
  the alternative — pretending offset paging is exact — is worse than saying so.
- **Overlapping loads are refused.** `endReached` is edge-triggered but re-arms; a load already in
  flight must not start a second.
- The store knows whether more rows exist by asking for `limit` and receiving `limit` rows. A
  short page means the end. This costs one extra empty request when the total is an exact multiple
  of 48, which is the cheapest correct answer without a count query.

## 4. The tag list

A new API, because fact 3 says the current one becomes wrong under paging.

- `ApiClient.projects.tags(): Promise<string[]>` — the distinct tag names in the user's library,
  sorted case-insensitively.
- Core: `listTags(lib, ctx): string[]`, scoped by `ctx.userId` exactly as `listProjects` is.
- Server: `GET /api/projects/tags`. Desktop: a `projects.tags` dispatch entry.

**The route must not collide with `GET /api/projects/:id`.** Register the literal path before the
parameterised one, or the id route will match `tags` and answer `NotFound` for a valid request.
Add a test that `GET /api/projects/tags` returns the tag list and not a 404.

`ProjectsStore.knownTags` is replaced by this resource. The selected tags are still folded into the
rendered list so an active filter always has a control to switch it off — that rule survives the
change and its reason is unchanged.

## 5. Remembered filter

Two new persisted settings, using the codec table segment G built:

| Key               | Type       | Codec          | Default |
| ----------------- | ---------- | -------------- | ------- |
| `includeArchived` | `boolean`  | `booleanCodec` | `false` |
| `filterTags`      | `string[]` | `jsonCodec`    | `[]`    |

- `SettingsDto`, `DEFAULT_SETTINGS` and `settingsPatchSchema` gain both.
- `jsonCodec`'s schema for `filterTags` is `z.array(tagNameSchema).max(50)`. A stored value that
  fails it decodes to `undefined` and the default stands — which is the whole point of the codec
  table, and this is its first production use.
- **Search is deliberately not remembered.** A search box that refills itself on every visit hides
  the rest of the library from a user who has forgotten why they are seeing four projects. Sort and
  direction are already persisted and stay so.

Writes are optimistic through `SettingsStore.patch`, which rolls the key back and rethrows on
failure. A failed persist shows an error snackbar through `NotifyService` and **must not** prevent
the filter applying locally — the list is what the user asked for; only remembering it failed.

## 6. `viewMode` moves to the page

- The grid/list control is **removed from the settings General tab** and appears on the projects
  page, in the filter bar's trailing group.
- It keeps writing `settings.viewMode` through `SettingsStore.patch`, so the choice still persists
  and nothing about the storage changes. This is a move of the control, not of the setting.
- `settings.viewMode*` translation keys move to the projects section; the settings section loses
  them. Both locale files, same commit.
- The settings General tab's docblock recording G's deferral is now false and must go with it.
  **This is the second-sweep question** — what was true before this edit and is not true after it.

## 7. The filter bar

One row, wrapping on narrow viewports. Leading group left, trailing group right.

### 7.1 Search

- A single input, **no visible label**, placeholder from the translations, `max-width: 350px`.
- It keeps an accessible name via `aria-label` — a placeholder is not a label, and losing the
  visible one must not lose the accessible one.
- Debounced. Every keystroke currently re-queries; with paging that also resets the list.

### 7.2 Sort

- `jig-select` with the label omitted and a sort icon rendered inside the control.
- **A minimum width so the selected option is not clipped**, and a popup wide enough that the
  longest option — "Recently updated" / "Zuletzt geändert" — sits on one line. Both are in the
  feedback and both are acceptance criteria (§10).
- The accessible name survives the visible label's removal (`aria-label` or `labelledBy`).
- Verify the icon placement against the installed `@awdlab/jig` rather than assuming
  `jig-input-field` adornments compose with `jig-select`; if they do not, say so and use the
  nearest control that does.

### 7.3 Archived

A single button toggling between two icons.

- `aria-pressed` reflects the state. The **accessible name does not change** with it — only the
  icon does — so a screen-reader user hears one control with a state, not two controls.
- A tooltip names it, because it is icon-only.

### 7.4 Tags

A dropdown button opening a multi-select.

- The button carries a **count badge** when at least one tag is selected, and no badge at zero.
- `jig-list-box` with `selectable` and `multiple` gives checkboxes and keyboard navigation;
  `jigBadge` gives the count. Confirm both against the installed package.
- The button carries `aria-expanded`.
- Filtering semantics are unchanged: a project must carry **every** selected tag (core already
  implements AND and de-duplicates case-insensitively). Do not change that.
- Selecting a tag resets paging (§3.3).

### 7.5 Infinite scroll

- `jigScrollAmount` with `(endReached)` and a non-zero `jigScrollAmountEndThreshold` so the next
  page starts before the user hits the floor.
- **Guarded against overlapping loads** — jig's own documentation says edge-triggering removes
  repeated fires, not a request in flight while the user scrolls back and forth.
- A spinner while a page is loading, in the list, where the rows will appear.
- **A keyboard-reachable "Load more" control is required when more rows exist**, not optional.
  Infinite scroll driven only by a scroll event is unreachable for a keyboard or screen-reader
  user, and this is C6. It is also the honest fallback when the scroll container is not what the
  directive thinks it is.

## 8. New project

- The `<form>` below the filter card is removed. A **New project** button sits beside **Rescan
  library** in the page head.
- It opens a popover containing the name field and a create button. The button carries
  `aria-expanded`; focus moves into the field on open and returns to the button on close.
- The same `createProjectSchema` validates as today.
- **On success the app navigates to the created project.** This is explicit feedback and is an
  acceptance criterion.
- On failure the typed name stays put and an error is shown, as today.

## 9. Copy

Spec G §8 applies. New and moved strings must satisfy it when written — a later sweep is a net,
not a licence to defer. The projects section is this segment's to sweep; anything it finds in
`project-detail.page.ts`, the viewer or the browser is **listed, not fixed**, and handed on.

## 10. Acceptance

1. `deno task verify` exits 0; `test:desktop` and `e2e` pass; `fmt:check` and lint clean.
2. A library with more than 48 projects renders 48, then more as the list is scrolled, with no
   duplicates and no gaps.
3. Two projects sharing an `updated_at` both appear exactly once across two single-row pages.
4. `GET /api/projects/tags` returns the library's tags and is not shadowed by the `:id` route.
5. The tag dropdown lists tags that are **not** on any loaded project.
6. Setting a tag filter and archived toggle, reloading, and finding both still applied.
7. A stored `filterTags` value that fails its schema yields `[]` rather than breaking the page.
8. The grid/list control is on the projects page and absent from settings; the choice persists.
9. The search box has no visible label, has an accessible name, and is capped at 350px.
10. The sort control is not clipped and its popup fits "Recently updated" on one line.
11. The archived control is one button with `aria-pressed` and a stable accessible name.
12. The tag button shows a count badge only when tags are selected.
13. More rows are reachable without a mouse.
14. Creating a project from the head popover navigates to it.
15. Both locale files have identical key sets.

## 11. Out of scope, recorded

- `project-detail.page.ts`, the viewer, the model browser (segments I and J).
- Cursor paging (§3.3 records why offset is accepted and what it costs).
- A total count. Nothing in the UI needs one, and it would cost a second query per page.
- macOS and Linux remain unmeasured across D–H.
- The e2e login budget still has a pin and no mechanism (spec G §10).
