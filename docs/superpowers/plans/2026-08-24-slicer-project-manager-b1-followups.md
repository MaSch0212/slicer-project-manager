# Slicer Project Manager — B1 follow-ups: previews for the rest of the library

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to
> implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** B1 shipped a working rasterizer, but a survey of the real reference library shows
most models still will not get a thumbnail. Four defects stand between the pipeline and the
files it was built for. Three were found by running against `D:\SPM Library`, not by review.

**Prior plan:** [subsystem B1](2026-08-23-slicer-project-manager-subsystem-b1-rasterizer.md) —
parsers, rasterizer, PNG encoder, `MESH_HANDLER` and the queue wiring. All done; none of it is
rebuilt here.

## What the survey found

374 `.3mf` files under one user's library, plus 28 more that fail to classify:

| Group                                           | Count | Today                                          |
| ----------------------------------------------- | ----- | ---------------------------------------------- |
| `slicer_project` with an embedded thumbnail     | 48    | works                                          |
| `slicer_project` with **no** embedded thumbnail | 326   | **`unsupported`, terminal, no thumbnail ever** |
| unreadable as zip (zip64)                       | 28    | **classified `other`, invisible to previews**  |
| model XML over the V8 string cap                | 3     | **`failed`**                                   |

323 of the 354 thumbnail-less files parse cleanly with `parse3mfMesh` today. The geometry is
right there; nothing asks for it.

---

## Global constraints

These bind every task. A reviewer should treat a violation as a defect regardless of what the
task text says.

1. **`packages/core` must run unmodified on Deno and Node.** Web-standard globals and `node:*`
   builtins only. No `process`, `Deno`, `Buffer`, `require`, `__dirname` in
   `packages/core/src/**`. ESLint enforces this — do not weaken those rules.
2. **No new runtime dependencies.**
3. **Bounded memory, to a measured budget.** The deployment target is a NAS with **2 GB of
   RAM**, and the whole preview queue must peak **under 500 MB**. That is a hard number, not
   an aspiration: measured peak RSS today is 0.65-1.15 GB on large models and 1.55-1.69 GB on
   the three that hit the V8 string cap. The library's largest model is 3,295,832 triangles in
   a 164 MB STL. Nothing may hold a whole document as a string, and nothing may allocate per
   triangle. Where a model cannot be previewed inside the budget, it is skipped with a reason
   the user can read - never at the cost of the budget.
4. **Malformed input fails as `AppError('Validation', …)`** and never escapes as a bare
   `RangeError`/`TypeError`. A blank thumbnail reported as success is the worst outcome
   available and is never acceptable.
5. **Tests run under both runtimes** — `pnpm test:core:node` and `pnpm test:core:deno`.
6. **Every assertion must be able to fail.** Break the code it covers, confirm red, restore.
7. **`pnpm verify` green, and CI green after push.**

---

## Tasks

### Task 1 — Handler fallback chain, so an unsliced project still gets a picture

- [ ] `runPreviewQueue`'s dispatch (`packages/core/src/previews/queue.ts:134`) currently takes
      the **first** handler whose `kinds` match and treats its `null` as final. Make it try
      each matching handler in order and use the first non-`null` result; only if every
      matching handler declines is the job `unsupported`.
- [ ] `MESH_HANDLER.kinds` becomes `['model', 'slicer_project']`. Order in `main.ts` already
      puts `EMBEDDED_HANDLER` first, so an embedded thumbnail still wins — it is both cheaper
      and closer to what the slicer showed the user.
- [ ] A handler that **throws** still fails the job. Only `null` falls through. Losing that
      distinction would turn a corrupt file into a silent `unsupported`.
- [ ] Tests: a slicer-project 3MF with no embedded thumbnail ends `ready` with a rasterized
      PNG; one **with** a thumbnail still uses the embedded path (assert `source`, not just
      that a file exists); a handler throwing still ends `failed`; a kind no handler claims is
      still `unsupported`.

### Task 2 — Validate every environment variable at startup

- [ ] `SPM_PORT` currently accepts `abc` and hands `NaN` to `Deno.serve`. Reject at startup.
- [ ] Extract the environment reads from `packages/server/main.ts` into one tested module.
      There are four now — `SPM_LIBRARY_DIR`, `SPM_LOG_LEVEL`, `SPM_PORT`,
      `SPM_PREVIEW_INTERVAL_MS`, plus `SPM_DEV_UI_ORIGIN` which already has one.
- [ ] Keep the operator experience: a one-line message naming the variable and what it wanted,
      then a non-zero exit. Not a stack trace.
- [ ] Tests: each variable's accept and reject cases, including the forms `Number()` quietly
      allows — `''`, `' 1000 '`, `'1e3'`, `'1.5'`, `'-1'`, `'0'`.

### Task 3 — Stop decoding the 3MF model into a string

- [ ] `packages/core/src/previews/mesh/threemf.ts:164` does
      `new TextDecoder().decode(readZipEntryBytes(...))`. Three real files exceed V8's
      ~512 MB string cap and die with a `RangeError` about the maximum string length, so they
      also violate constraint 4.
- [ ] Scan the `Uint8Array` directly. The existing cursor walk already only needs to find
      `<vertex`, `<triangle` and comment markers and read a handful of attributes; decode
      only the bounded tag slices, never the document.
- [ ] This also halves peak memory: the UTF-16 string is two bytes per character on top of
      the bytes it was decoded from.
- [ ] Tests: the existing 3MF suite must pass unchanged; a fixture large enough to prove the
      string is gone (assert on memory or on parsing a document beyond the cap, whichever is
      not flaky); the scaling test must still catch a quadratic scan.

### Task 4 — Read zip64 archives

- [ ] `packages/core/src/files/zip.ts:55` throws `zip64 archives are not supported` when the
      central-directory offset is `0xffffffff`. 28 real files hit this. They fail
      _classification_, so they are not merely thumbnail-less — they are the wrong `kind`.
- [ ] Support the zip64 end-of-central-directory locator and record, and the zip64 extended
      information extra field for sizes and offsets that are `0xffffffff` in the base record.
- [ ] Keep the reader streaming: entries are still read by offset, never by inflating the
      archive.
- [ ] Tests: a hand-built zip64 fixture (extend `packages/core/test/fixtures/make-3mf.ts`'s
      `writeZip`), an archive with a zip64 EOCD but 32-bit-safe values, and a truncated
      locator. A non-zip64 archive must still parse byte-identically to today.

### Task 5 — Keep the whole queue under 500 MB, and skip what will not fit

The deployment target is a 2 GB NAS. Tasks 3 and 4 reduce memory; this one bounds it.

- [ ] **Measure first, then choose the limit.** For each format, chart peak RSS against input
      size using real files from `D:\SPM Library\marc` (which spans 636 triangles to
      3,295,832). Derive the cap from the measurement and record the table in the report - do
      not guess a round number and hope.
- [ ] **Refuse oversized models before reading them.** Check the file size, and for 3MF the
      entry's uncompressed size, _before_ allocating anything. A model that cannot be rendered
      inside the budget must cost nothing to reject.
- [ ] The refusal must carry a **user-facing reason** naming the actual and permitted sizes -
      "model is too large to preview (210 MB; the limit is 64 MB)". A silent skip is the one
      outcome this project has consistently refused.
- [ ] **Make the limit configurable**, so a machine with room can raise it. Same treatment as
      the other environment variables: a tested pure resolver in `packages/server/src/env.ts`,
      print-and-exit at the call site, documented in the README.
- [ ] **Make preview concurrency configurable too**, defaulting so that the _product_ of
      concurrency and the per-render ceiling stays inside the budget. `DEFAULT_CONCURRENCY` is
      2 today; if the measurement says two large renders cannot coexist under 500 MB, the
      default changes and the comment says why.
- [ ] Tests: a file over the limit is refused without being read (assert the reason, and that
      no large allocation happens); a file just under it still renders; the resolver's accept
      and reject cases; and a memory assertion over the largest fixture that would catch a
      regression reintroducing a whole-file read.
- [ ] Report the projected outcome across the real library: how many models render, how many
      are skipped as too large, and the peak RSS observed for the worst case that still runs.
- [ ] **Defaults target the 2 GB NAS; raising them must be one obvious edit.** The same server
      may be deployed to a Mac mini with far more headroom, so the README needs a worked
      example — the two variables to set for a larger machine, and what the measured table says
      that buys in models covered. Someone with room should not have to read the source to
      work out which knob to turn, and someone without room should be safe having turned
      nothing.

---

## Not in this plan

- **Streaming rasterization.** Parsing triangles in chunks and rasterizing in two passes
  straight from disk would make memory independent of model size and remove the cap entirely,
  but it redesigns the parser-to-renderer interface (`Mesh` becomes an iterator) and needs
  `zip.ts` rebuilt around `DecompressionStream` for 3MF. Worth doing if the cap turns out to
  exclude models people care about; not worth blocking a deployment on.
- **The viewer's own size prompt.** Subsystem B2 opens models in three.js in the browser,
  where the same "this one is enormous" question arises and the honest answer is to ask the
  user before loading. Same judgement, different layer; it belongs with B2.

---

## Definition of done

- `pnpm verify` green; `pnpm e2e` green; CI green on `main` after push.
- A survey of the reference library shows every `.3mf` classified as `slicer_project`, and
  every model file either `ready` or skipped for a stated, readable reason — none `unsupported`,
  none failing with a bare runtime error.
- **Peak RSS for the whole preview queue stays under 500 MB** while backfilling the real
  library, measured, not assumed.
- No new dependency in any `package.json`.
