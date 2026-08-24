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

### Task 4 — Fix the zip reader: stop double-copying, and read zip64

- [ ] **First, the double copy.** `zip.ts:143` does `new Uint8Array(inflateRawSync(data))`,
      which holds two full-size copies of every inflated entry at once. Measured on the real
      library: RSS is already 1083 MB immediately after reading a 466 MB model part. A scratch
      patch passing `{ chunkSize: entry.uncompressedSize }` and dropping the re-copy took the
      worst file from 2162 MB to **934 MB** and a 466 MB part from 1551 MB to **664 MB** —
      roughly as much again as task 3 bought, from one line. Verify that measurement before
      trusting it, and check what `inflateRawSync` actually returns on both runtimes.
- [ ] Then zip64.
- [ ] `packages/core/src/files/zip.ts:55` throws `zip64 archives are not supported` when the
      central-directory offset is `0xffffffff`. 28 real files hit this. They fail
      _classification_, so they are not merely thumbnail-less — they are the wrong `kind`.
- [ ] Support the zip64 end-of-central-directory locator and record, and the zip64 extended
      information extra field for sizes and offsets that are `0xffffffff` in the base record.
- [ ] Keep the reader streaming: entries are still read by offset, never by inflating the
      archive.
- [ ] **A chunked reader, for task 5.** Add a way to read an entry as a stream of bounded
      chunks rather than one buffer — `DecompressionStream('deflate-raw')` is available on both
      runtimes and needs no dependency. Keep `readZipEntryBytes` for callers that genuinely
      want the whole thing; the point is that a 674 MB model part no longer has to be one
      allocation. Verify the chunked path produces byte-identical output to the buffered one
      across the real library.
- [ ] Tests: a hand-built zip64 fixture (extend `packages/core/test/fixtures/make-3mf.ts`'s
      `writeZip`), an archive with a zip64 EOCD but 32-bit-safe values, and a truncated
      locator. A non-zip64 archive must still parse byte-identically to today.

### Task 5 — Stream the reads, so nothing has to be skipped

The deployment target is a NAS with 2 GB of RAM and the queue must peak under 500 MB. Tasks 3
and 4 cut the peak roughly in half, but the model document is still held whole, so the biggest
files remain far over budget. This task removes the document from the peak entirely.

The alternative considered and rejected: cap the input size and skip anything larger. That was
the original plan and the user asked for it, but the measurement changed the answer — see the
note below on why decimation and capping both miss.

- [ ] **3MF: consume the chunked reader from task 4** instead of one inflated buffer. The
      parser already walks bytes with monotonic cursors, so it needs a sliding window over the
      chunk stream rather than random access — a tag never spans more than a few hundred bytes,
      so a window of a few tens of KB with carry-over is enough. Keep the two passes sharing
      one traversal; a second pass means a second stream, not a retained buffer.
- [ ] **STL and OBJ: read in chunks too.** `readFileSync` currently holds the whole file. A
      164 MB STL is the library's largest and costs a needless 164 MB on top of its positions.
      Binary STL is fixed-size records, so this is mechanical; ASCII STL and OBJ need
      line-boundary carry-over.
- [ ] **The expected outcome, to be confirmed by measurement, not assumed:** peak becomes the
      `positions` array plus the window, i.e. roughly `triangleCount * 36` bytes. For the
      library's worst cases that is about 110 MB (Köln Pokal, 2 899 850 triangles) and about
      120 MB (Baby Groot, 3 295 832). Both are comfortably inside the budget with concurrency 2.
- [ ] **Keep a cap, as a backstop rather than as the mechanism.** Something pathological — a
      zip bomb, a model with a billion degenerate triangles — must still be refused rather than
      allowed to allocate without limit. Derive it from the measured relationship between
      triangle count and peak, refuse before allocating, and carry a user-facing reason naming
      the actual and permitted sizes.
- [ ] **Make the cap and preview concurrency configurable**, tested resolvers in
      `packages/server/src/env.ts`, print-and-exit at the call site, documented in the README.
      Defaults target the 2 GB NAS.
- [ ] **Defaults for the NAS, one obvious edit to raise them.** The same server may run on a
      Mac mini with far more headroom. The README needs the two variables and what the measured
      table says raising them buys, so nobody has to read the source to work it out and nobody
      who changes nothing is unsafe.
- [ ] Tests: a fixture larger than any buffer the parser is allowed to hold still parses; peak
      allocation stays proportional to triangle count and not to file size (assert on
      allocation shape, not wall clock); the cap refuses before reading; the resolvers' accept
      and reject cases; the existing 3MF, STL and OBJ suites pass unchanged.
- [ ] Report the outcome across the real library: peak RSS for the worst file that runs, how
      many are refused by the backstop, and the wall-time delta from streaming.

## Not in this plan

- **Streaming rasterization.** Task 5 streams the _read_, so the document leaves the peak but
  the `positions` array stays. Going further — rasterizing straight from a triangle iterator
  in two passes and never materialising `positions` at all — would make memory independent of
  model size, but it turns `Mesh` into an iterator and rewrites the renderer's contract for a
  saving of about 110 MB on the worst file in the library. Not worth it while task 5's numbers
  hold.
- **Decimation before rendering.** Converting to a low-poly model first sounds like it should
  help and does not: decimation happens _after_ parsing, so the full document and the full
  `positions` array have both already been allocated by the time it could run. On the worst
  file it would shrink 104 MB out of a 2163 MB peak, at the cost of an extra pass over data
  that is rendered exactly once. Rendering is not the bottleneck — 3.3M triangles rasterize in
  about 700 ms while parsing takes seconds.
- **Decimation for the viewer, though, is a real feature** and belongs with B2. Shipping a
  164 MB STL to a browser is bad regardless of server memory, and a decimated mesh cached
  beside the thumbnail is the right fix — it also largely removes the need to ask the user
  whether to load a large model, since there would no longer be a large model to load.

## Definition of done

- `pnpm verify` green; `pnpm e2e` green; CI green on `main` after push.
- A survey of the reference library shows every `.3mf` classified as `slicer_project`, and
  every model file either `ready` or skipped for a stated, readable reason — none `unsupported`,
  none failing with a bare runtime error.
- **Peak RSS for the whole preview queue stays under 500 MB** while backfilling the real
  library, measured, not assumed — and reached by streaming the reads, so no model in the
  library is refused for being large. The cap exists, but nothing normal should meet it.
- No new dependency in any `package.json`.
