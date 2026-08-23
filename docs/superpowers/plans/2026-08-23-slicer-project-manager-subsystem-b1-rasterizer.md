# Slicer Project Manager — Subsystem B1: mesh thumbnails

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every `kind='model'` file in a library gets a thumbnail. Today only slicer projects
do — the embedded-thumbnail path shipped with subsystem A — so a library of STLs renders as a
grid of "Preview pending". This plan adds the mesh parsers, the software rasterizer and the
PNG encoder that §7.1–7.3 describe, and wires them into the existing preview queue.

**Spec:** [`docs/superpowers/specs/2026-08-22-slicer-project-manager-design.md`](../specs/2026-08-22-slicer-project-manager-design.md) §7

**Prior plan:** [subsystem A](2026-08-22-slicer-project-manager-subsystem-a.md) — built the
`previews` table, the state machine, the bounded queue with claim/lease, and
`EMBEDDED_HANDLER`. All of that is done and must not be rebuilt.

---

## Scope

| In this plan                                         | Not in this plan                                         |
| ---------------------------------------------------- | -------------------------------------------------------- |
| PNG **encoder** (`node:zlib` deflate + chunk writer) | PNG **decoder** — see decision 2                         |
| Binary and ASCII STL parsing                         | Interactive three.js viewer (§7.4) — that is **B2**      |
| OBJ parsing                                          | Any change to the queue's claim/lease or retry semantics |
| Plain-3MF mesh parsing                               | Electron, slicers, model browser (specs C–E)             |
| Isometric z-buffer rasterizer → 256×256 PNG          | Re-rendering on demand, or a size/quality setting        |
| `MESH_HANDLER` registered beside `EMBEDDED_HANDLER`  |                                                          |

**§7.4's interactive viewer is deliberately excluded.** It shares no code with the
rasterizer, pulls in three.js (a heavy new dependency and a new lazy route), and is testable
only through the browser. It is its own segment.

---

## Global constraints

These bind every task. A reviewer should treat a violation as a defect regardless of what
the task text says.

1. **`packages/core` must run unmodified on Deno and Node.** Web-standard globals and
   `node:*` builtins only. No `process`, `Deno`, `Buffer`, `require`, `__dirname`. ESLint
   enforces this for `packages/core/src/**` — do not weaken those rules.
2. **No new runtime dependencies.** The rasterizer and PNG writer are hand-written against
   `node:zlib`. If a task feels like it needs a package, it does not.
3. **Deterministic output.** The same mesh must produce byte-identical PNGs **across runs
   within one runtime**, and identical _pixels_ on both runtimes. No `Date.now()`, no
   `Math.random()`, no iteration over unordered collections, no floating-point that depends
   on input order. This originally demanded byte-identical PNGs across runtimes as well; that
   is unachievable and was amended — see ruling B1-4 in the ledger. Node and Deno ship
   different zlib bindings and emit different deflate streams for identical input, so across
   runtimes only the decompressed scanlines, which are the actual image, can be compared.
4. **Bounded memory.** A 54 MB uncompressed 3MF is a real file in the reference library
   (§7.1). Parsers stream or index; none may build a DOM or an array of per-triangle
   objects. Triangle data lives in typed arrays.
5. **Malformed input fails, it never throws past the handler.** A corrupt mesh must end as
   `state='failed'` through the queue's existing path, so `MAX_PREVIEW_ATTEMPTS` bounds it.
   A parser signals "I cannot read this" by throwing `AppError('Validation', …)`; the
   handler lets it propagate to `runOne`, which already records the failure.
6. **Tests run under both runtimes.** Every core test goes in `packages/core/test/` and must
   pass under `pnpm test:core:node` _and_ `pnpm test:core:deno`.
7. **Every assertion must be able to fail.** Before claiming a test passes, break the code
   it covers and confirm it goes red. Golden-value tests state where the golden came from.
8. **`pnpm verify` green, and CI green after push.** Local green is not the bar; the
   pipeline is.

---

## Decisions taken up front

Recorded here because they deviate from, or resolve silence in, the spec.

1. **Segment boundary.** B1 is the rasterizer pipeline; the three.js viewer (§7.4) is B2.
2. **Embedded thumbnails are not downscaled**, despite §7.1's "Extract, downscale". They
   are already small (3.6–18.8 KB; the largest is Cura's 300×300 at 18.8 KB), a 512×512
   Bambu thumbnail renders better than 256 on a HiDPI grid, and downscaling would require a
   full PNG _decoder_ plus a re-encode that can only lose quality. The 256 target in §7.2
   applies to what the **rasterizer** produces, which is the thing that had no size before.
   `previews.width`/`height` already record the true dimensions either way.
3. **3MF meshes are inflated whole, then scanned without building a tree.** §7.1 says the
   parse "must stream" because a 54 MB file makes "a DOM parse … not viable". The
   unaffordable part is the node tree, not the buffer: 54 MB of `Uint8Array` is fine, while
   a DOM over ~1M vertices is not. Existing `readZipEntryBytes` is reused rather than
   rewriting `zip.ts` around `DecompressionStream`. If a real file ever exceeds what this
   can hold, revisit — the parser interface below does not change.
4. **OBJ is implemented**, though §7.1 calls it low priority. `classifyFile` already returns
   `kind='model'` for `.obj`, so without a parser every OBJ burns its three attempts and
   lands on `failed` — a worse outcome than the ~40 lines a minimal parser costs.
5. **One handler, dispatching on extension.** `MESH_HANDLER` covers `kinds: ['model']` and
   picks a parser from the file's extension, because that is exactly what `classifyFile`
   keyed on to assign the kind.

---

## Tasks

### Task 1 — PNG encoder

- [ ] `packages/core/src/previews/png.ts` gains `encodePng(rgb: Uint8Array, width, height): Uint8Array`.
- [ ] IHDR (8-bit, colour type 2 / truecolour, no interlace), IDAT, IEND. Each scanline
      prefixed with filter byte 0. `deflateSync` from `node:zlib` for IDAT.
- [ ] CRC-32 over chunk type + data, per the PNG spec. Hand-written table, no dependency.
- [ ] Keep `readPngSize` exactly as it is; it is used by the embedded path.
- [ ] Tests: `encodePng` output is readable by the existing `readPngSize`; the signature and
      chunk layout are byte-exact for a 2×2 fixture whose expected bytes are derived in the
      test from the spec, not copied from a run; a wrong-length buffer is rejected.

### Task 2 — STL parsing

- [ ] `packages/core/src/previews/mesh/stl.ts` exporting `parseStl(bytes: Uint8Array): Mesh`.
- [ ] `Mesh` is `{ positions: Float32Array; triangleCount: number }` — triangle soup, three
      vertices per triangle, no index buffer. Define it in
      `packages/core/src/previews/mesh/mesh.ts`; every parser returns this shape.
- [ ] Binary detection: an 84-byte header then `50 * triangleCount` bytes. Prefer this
      check over sniffing for the ASCII `solid` prefix — binary STLs frequently start with
      the word `solid` in their header, which is the classic way to misdetect them.
- [ ] ASCII fallback: scan `vertex x y z` triples; tolerate CRLF and arbitrary whitespace.
- [ ] Reject: truncated binary, a triangle count that disagrees with the byte length, and a
      file with zero triangles.
- [ ] Tests for both encodings, the `solid`-prefixed binary trap, truncation, and equality
      of the parsed positions between an ASCII and a binary encoding of the same cube.

### Task 3 — OBJ parsing

- [ ] `packages/core/src/previews/mesh/obj.ts` exporting `parseObj(bytes: Uint8Array): Mesh`.
- [ ] `v` lines and `f` lines. Faces may be triangles or larger polygons — fan-triangulate.
      Indices are 1-based and may be negative (relative to the end). `f a/b/c` forms carry
      texture/normal indices to ignore.
- [ ] Ignore everything else (`vn`, `vt`, `g`, `usemtl`, comments) rather than failing.
- [ ] Reject a file with no faces.
- [ ] Tests: a triangle, a quad that fans into two triangles, negative indices,
      `v/vt/vn` index forms, and a file of only comments.

### Task 4 — 3MF mesh parsing

- [ ] `packages/core/src/previews/mesh/threemf.ts` exporting `parse3mfMesh(absPath: string): Mesh`.
- [ ] Read `3D/3dmodel.model` with the existing `readZipEntryBytes`. Scan the bytes for
      `<vertex ` and `<triangle ` occurrences and pull their attributes; do not build a tree
      and do not use a regex over the whole document (it will backtrack on 54 MB).
- [ ] Vertices are `x`/`y`/`z` attributes; triangles are `v1`/`v2`/`v3` indices into them.
- [ ] Multiple `<object>`s: concatenate every mesh found. Ignore `<build>`/`<item>`
      transforms — the thumbnail only needs the shape, and the rasterizer fits the bounding
      box anyway. Say so in a comment.
- [ ] Reject a 3MF with no `3D/3dmodel.model`, and one with vertices but no triangles.
- [ ] Tests: a hand-built 3MF fixture (reuse `packages/core/test/fixtures/make-3mf.ts`'s
      `writeZip`), a two-object file, an out-of-range triangle index, and a file large
      enough to prove the scanner does not go quadratic — assert a time bound generously,
      or assert on allocation shape rather than wall clock if that proves flaky.

### Task 5 — Isometric rasterizer

- [ ] `packages/core/src/previews/raster.ts` exporting
      `renderMesh(mesh: Mesh, opts?: { size?: number }): { rgb: Uint8Array; width: number; height: number }`.
- [ ] Default size 256 (§7.2).
- [ ] Fit: compute the bounding box, centre it, and scale so the projected extent fills the
      frame with a small margin. A mesh of any absolute scale must render identically.
- [ ] Camera: fixed isometric direction. Project, keep a `Float32Array` z-buffer, fill
      triangles with a scanline or barycentric loop.
- [ ] Shading: flat, one directional light, plus a small ambient term so faces pointing away
      are not pure black. Background is a single flat colour.
- [ ] Back-face culling is fine; do not depend on winding order for correctness, since STLs
      in the wild have inconsistent winding — shade on `abs(dot(normal, light))`.
- [ ] No allocation inside the per-triangle loop.
- [ ] Tests: a cube renders a non-empty image whose pixel histogram has at least two
      distinct face shades; the same cube at 1× and 1000× scale renders **byte-identical**
      output; a degenerate (zero-area) triangle does not crash or write NaN; output is
      byte-identical across two runs in the same process.

### Task 6 — Handler, wiring, and the end-to-end path

- [ ] `packages/core/src/previews/mesh-handler.ts` exporting `MESH_HANDLER: PreviewHandler`
      with `kinds: ['model']`.
- [ ] Dispatch on extension: `.stl` → `parseStl`, `.obj` → `parseObj`, `.3mf` →
      `parse3mfMesh`. Anything else returns `null` (→ `unsupported`), which is the correct
      answer for a `model` kind we cannot read rather than a failure.
- [ ] Render, encode, return `{ bytes, width, height, source: 'rasterized' }` — the
      `PreviewOutput` shape the queue already writes, including `source_hash`.
- [ ] Export from `packages/core/src/index.ts`.
- [ ] Register in `packages/server/main.ts`: `runPreviewQueue(lib, { limit: 20, handlers: [EMBEDDED_HANDLER, MESH_HANDLER] })`.
      Check the current call — it relies on the default `[EMBEDDED_HANDLER]`, so the default
      must either change or the call must pass both. Prefer changing the call, so the core
      default stays "only what needs no rendering".
- [ ] Tests: a library containing an STL, run through the real `runPreviewQueue`, ends with
      `state='ready'`, a PNG on disk under `.spm/previews/<file-id>.png`, and recorded
      width/height of 256. A malformed STL ends `failed` and stops after
      `MAX_PREVIEW_ATTEMPTS`. A `.step` file classified as `other` is never claimed.
- [ ] Server test: the existing preview-serving route returns the rendered PNG.

---

## Definition of done

- `pnpm verify` green; `pnpm e2e` green; CI green on `main` after push.
- A library of STLs shows thumbnails in the projects grid rather than "Preview pending".
- `packages/core` still passes its dual-runtime suite with identical results.
- No new dependency in any `package.json`.
