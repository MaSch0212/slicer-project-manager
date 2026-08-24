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
3. **Bounded memory.** The library's largest model is 3,295,832 triangles in a 164 MB STL, and
   at least three 3MFs exceed 512 MB of model XML. Nothing may hold a whole document as a
   string, and nothing may allocate per triangle.
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
      ~512 MB string cap and die with `Cannot create a string longer than 0x1fffffe8
    characters` — a `RangeError`, so they also violate constraint 4.
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

---

## Definition of done

- `pnpm verify` green; `pnpm e2e` green; CI green on `main` after push.
- A survey of the reference library shows every `.3mf` classified as `slicer_project`, and
  every model file either `ready` or `failed` for a stated reason — none `unsupported`.
- No new dependency in any `package.json`.
