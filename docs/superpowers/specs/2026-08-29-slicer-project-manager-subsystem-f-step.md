# Slicer Project Manager — Subsystem F: STEP file support

- **Date:** 2026-08-29
- **Status:** Approved (design); implementation plan pending
- **Parent:** [`2026-08-22-slicer-project-manager-design.md`](2026-08-22-slicer-project-manager-design.md)
  — binding. Where this document and the parent disagree, the parent wins and this one is wrong —
  except at 1.3, where three parent statements are **corrected in place against measurements**. E set
  that precedent for one statement of fact; this document uses it three times, and each correction
  stands on its own measurement rather than on the precedent.
- **Measurements:** `.superpowers/spikes/2026-08-29-step-facts.md`, run 2026-08-29 10:44–11:15 on the
  developer's Windows 11 machine against the five installed slicers, the ten STEP files in the
  reference library and `occt-import-js@0.0.23`. Section references of the form "(§5.3)" are to that
  document. Prior art from `.superpowers/spikes/2026-08-28-slicer-launch-facts.md` is cited as
  "(D-spike §13)".
- **Facts read out of this repository** while writing this document are marked **(code)** and name
  the file. They are a different kind of evidence from the spike's runs and are not blended with
  them: a spike row was observed happening, a code row was read. Two of this document's decisions —
  3.4 and 5.5 — rest on code rows that contradict or extend what the spike assumed, and they are
  called out where they land.
- **Packages touched:** `packages/core` (classification, one parser, one handler arm, one migration,
  one `MeshLimits` field, four edits in `rescan`), `packages/desktop` (one registry field, one
  refusal, one widened spawn seam and the `cwd` it carries, the packaging list), `packages/server`
  (one environment variable), `packages/web` (one comment and one gate — see 7.2).
  Also the repository root: a `LICENSE` and a third-party notice (6).

---

## 1. Purpose and scope

The user asked for two things, in this order: that STEP files be **detected as 3D models so they can
be handed to a slicer**, and — "if possible with moderate effort" — that they get **thumbnails and a
preview**. The spike answers both, and the answers are not symmetrical. Handing a STEP file to a
slicer is close to free and already half-built. Thumbnails are moderate effort in code and immoderate
in memory, and the whole of section 5 is about that one number.

**Half of the second ask ships and half does not, and that belongs here rather than only in the
sections that argue it.** Thumbnails ship (5). **The interactive preview does not** (7): nobody has
measured what a STEP parse costs a Chromium tab, and the viewer's budget model cannot price a cost
that is 87 % intercept. So a STEP file gets a picture everywhere a picture appears, and clicking
through to the viewer gets an honest "this viewer opens STL, OBJ, 3MF" (7.2). 1.2 records the
deferral, 7 argues it and 10.4 says what would settle it — but the plain answer to what was asked for
is **detection yes, thumbnails yes, preview no**, and the "no" is not because it is hard. It is
because it is unmeasured.

### 1.1 What F adds

- **`.step` and `.stp` classify as `kind: 'model'`** (3). One line in `classifyFile`, plus the
  mechanism that makes it apply to files already in the index — which is not the mechanism the spike
  assumed (3.4).
- **A STEP arm on the rasterizer** (5), through `occt-import-js` and the repo's own unchanged
  `renderMesh`. Ten of ten library files render correctly through it (§5.4).
- **A refusal when the slicer is Cura**, which cannot read STEP and does not say so (4.2).
- **An explicit `cwd` on the slicer spawn** (4.5). This is a live defect in shipped subsystem-D code,
  found by accident, and it applies to `.stl` and `.obj` today.
- **A licence and a third-party notice** (6), which the repository currently lacks entirely.

### 1.2 Out of scope

- **The browser viewer.** Deferred with reasons in 7, which the spike also recommends (§8c). The
  interim behaviour is the one the code already has, and it is stated rather than assumed.
- **Any other STEP extension.** `.p21`, `.stpz`, `.stpnc` and the rest: no evidence was found for any
  of them and none is claimed (§2a). Nothing in the reference library uses one and no slicer probed
  mentioned one.
- **Matching a slicer's tessellation density.** Slicer defaults are 12.4–14.5x denser than
  `occt-import-js`'s (§2b). At 256 px that is invisible, measured — the thumbnails are correct — and
  a knob nobody can see the effect of is not worth having.
- **IGES and BREP.** The same library exposes `ReadIgesFile` and `ReadBrepFile` (§5.5). Neither
  format appears in the reference library, neither was measured, and adding an entry point nothing
  has tested is how an `unsupported` row gets written for a file that could have rendered.
- **Converting STEP to a stored mesh at import time.** The spike names it as the cheapest shape for
  the memory problem (§5.7) and it is not prototyped. 5.6 says why F does not take it and what would
  make it worth taking.
- **macOS and Linux.** Every measurement behind this document was taken on Windows 11 (§11.9).
  D and E shipped under the same limitation and said so; F does the same and does not pretend the
  slicer table, the packaging or the memory floor is platform-neutral.

### 1.3 What this document corrects in the parent

Three parent statements become false the moment F ships. All three are amended in place, and each
amendment carries its measurement, because the parent is binding and outlives this document.

**One — parent §3.4.** "`.stl` and `.obj` are always `kind='model'`; anything that is neither a model
nor a recognised slicer project is `kind='other'`." Amended to add `.step` and `.stp`. The evidence
is §4a: all ten `.step`/`.stp` files in the library begin `ISO-10303-21;` at offset 0, and no file in
the library with STEP content carries a different extension.

**Two — parent §7.1.** "the rasterizer … is only ever reached for `.stl`, `.obj`, and plain 3MF
meshes." Amended to add STEP. The sentence is a statement about which extensions reach `readMesh`,
and F adds two.

**Three — parent §7.2, and this is the one worth reading twice.** "Triangle soup, then an isometric
software rasterizer … **No GPU, no native dependency, identical output on both runtimes.**"

The rasterizer is untouched — measured, not argued: §5.4 pushed all ten files through the repo's
**actual** `renderMesh`, `encodePng`, `assertMeshFits` and `allocateMesh` and produced ten valid
256×256 PNGs with no change to any of them. What changes is upstream of it: the STEP **parser** is a
7.6 MB WebAssembly blob.

The amendment is therefore narrow and specific rather than a blanket retraction:

- "No GPU" — **unchanged.**
- "Identical output on both runtimes" — **unchanged, and re-measured for the new path.** Node 24.19.0
  and Deno 2.9.5 produced identical triangle counts on all ten files (§5.1).
- "No native dependency" — **amended.** There is now one portable compiled dependency, and the
  distinction that keeps the sentence's _intent_ is that WASM is not per-platform: one artifact, no
  node-gyp, no prebuilt matrix, no compiler on the user's machine, and the same bytes on the server
  and in the desktop app. It is still a compiled artifact this project did not build, it is 7.6 MB,
  and it carries a licence obligation (6). The parent should say "no per-platform native dependency;
  one portable WebAssembly parser for STEP, see subsystem F."

**And the subsystem table (parent §1.1) gains a row:** `**F** | STEP file support | B, D | Extension
points only — full detail in subsystem F`.

---

## 2. What was measured

Every row was run and observed in one session on one Windows 11 machine. Nothing here is from vendor
documentation. **A design decision that contradicts a row is wrong.** Rows marked **(code)** were
read out of this repository while writing this document rather than run.

| #   | Question                                                      | Measured                                                                                                                                                                                                   | Where      |
| --- | ------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------- |
| 1   | Does PrusaSlicer open STEP?                                   | **Yes, decisively.** `prusa-slicer-console.exe <f> --export-3mf` on all ten files: exit 0, empty stderr, a real 3MF out, 316–1 593 ms.                                                                     | §1a        |
| 2   | Bambu Studio?                                                 | **Yes.** Draws "Step file import parameters" reporting **49 138** facets for `Ender_3_fan_redirect_v4.step` before asking anything.                                                                        | §1b        |
| 3   | OrcaSlicer?                                                   | **Yes.** The same dialog from the same lineage; 49 138 and 218 970 facets, agreeing exactly with Bambu and Anycubic.                                                                                       | §1b        |
| 4   | Anycubic Slicer Next?                                         | **Yes.** `--info` returns `manifold: yes`, correct bbox and volume, and `number_of_parts = 3` on the three-part file.                                                                                      | §1c        |
| 5   | Cura?                                                         | **No, and silently.** Title stays `Untitled`; one window, no dialog; log: `Unsupported Mime Type Database file extension`, 7 ms after read.                                                                | §1d        |
| 6   | Is that Cura result a real negative or a broken probe?        | **Real.** Same install, same session, `cone.stl` → title `cone - UltiMaker Cura 5.13.0`. The title _does_ pick up a loaded file.                                                                           | §1d        |
| 7   | Does Cura ship a STEP reader at all?                          | **No.** Eleven reader plugins listed by name in 5.12.0 and 5.13.0; none reads STEP, and Cura is the only install with no OCCT artifact.                                                                    | §1d, §1e   |
| 8   | Has the user already hit this?                                | **Yes.** Cura's log carries a real library file, `Nozzle Wiper Guard.STEP`, dropped nine minutes before the spike opened anything.                                                                         | §1d        |
| 9   | Is a `TK*.dll` probe a STEP-capability test?                  | **No.** PrusaSlicer ships **zero** `TK*.dll` and one `OCCTWrapper.dll`; Cura ships zero of both. The two nulls mean opposite things.                                                                       | §1e        |
| 10  | Does `.stp` work as well as `.step`?                          | **Yes, on all four that read STEP at all.** Six `.step` and four `.stp` files, every slicer.                                                                                                               | §2         |
| 11  | What is in the library?                                       | **Ten files** — 6 `.step`, 4 `.stp` — 53 643 to 1 388 035 bytes, all ASCII, all AP214, from three different CAD producers.                                                                                 | §0         |
| 12  | Does extension alone classify correctly?                      | **Yes. Zero mismatches in both directions over all 2 946 files.** All ten STEP-extension files begin `ISO-10303-21;` at offset 0.                                                                          | §4a        |
| 13  | What would a magic check cost?                                | **77.6 µs per file** against 0.136 µs for the extension test — 0.8 ms per rescan applied to the candidates, 0.23 s applied to everything.                                                                  | §4b        |
| 14  | Does any slicer propose to write over the `.step`?            | **None observed.** PrusaSlicer with no `--output` writes `<basename>.3mf` beside the input and leaves the source byte-identical.                                                                           | §3a        |
| 15  | What does Ctrl+S propose in each GUI?                         | **Unmeasured.** `GetForegroundWindow()` returned 0 all session; the pid guard aborted every keystroke. Blocks the whole of §3b.                                                                            | §3b, §11   |
| 16  | Does a slicer ever write outside the input's directory?       | **Yes — Anycubic wrote into the process's current working directory**, which was this repository. Removed; see §12.                                                                                        | §3a, §12   |
| 17  | Does `occt-import-js` run on Node **and** Deno?               | **Yes.** 10/10 `success: true` on both, identical triangle counts, instantiation 19–26 ms.                                                                                                                 | §5.1       |
| 18  | Can its output feed the repo's `renderMesh` unchanged?        | **Yes.** A ~24-line adapter, the repo's own unmodified rasterizer, **ten of ten valid 256×256 PNGs**, adapt cost 0.6–3.3 ms.                                                                               | §5.4       |
| 19  | Is the geometry plausible?                                    | **Yes, four ways.** Bboxes agree with Anycubic to ~0.03 mm, mesh count equals part count, ≤ 0.09 % degenerate triangles, images correct.                                                                   | §5.2       |
| 20  | What does a STEP parse cost in memory?                        | **207–278 MB peak RSS** across the whole sample, **including an 8 KB twelve-triangle cube at 207 MB.**                                                                                                     | §5.3       |
| 21  | Is that proportional to file size?                            | **No.** A ~**243 MB intercept** plus ~25 bytes per input byte. The intercept is **87 %** of the largest measured peak.                                                                                     | §5.3       |
| 22  | Is the cost per file or per process?                          | **Per process.** `maxRSS` flat at **243 990 528** across all ten files _and a second full pass_; no leak; warm parses ~30 % faster.                                                                        | §5.3       |
| 23  | What does the process cost before it parses anything?         | Bare Node **48 873 472**; module instantiated, nothing parsed, **72 421 376** (WASM heap 29 949 952). The floor arrives with the first parse.                                                              | §5.3       |
| 24  | Is the floor V8 garbage that a flag could tune away?          | **No.** A 128x range of `--max-old-space-size` (32 → 4096) moves the peak by **under 2 %**, and every run succeeded.                                                                                       | §5.3       |
| 25  | Is the measurement itself trustworthy?                        | **Yes.** Node `maxRSS` and Win32 `PeakWorkingSet64` agreed **to the byte** (274 968 576, delta 0).                                                                                                         | §5.3, §10  |
| 26  | Is the mechanism understood?                                  | **No.** ~100 MB of the peak is attributed to no counter the harness reads. Reproducible, cross-validated, unexplained.                                                                                     | §5.3       |
| 27  | Does `DEFAULT_MAX_MESH_BYTES` bound it?                       | **No.** The largest `positions` array in the whole sample is **796 932 bytes**. The mesh is not what costs anything here.                                                                                  | §5.3       |
| 28  | Can the parser stream?                                        | **No.** All four entry points are whole-buffer; the file is resident twice at the moment of the call. Confirmed by enumerating the exports.                                                                | §5.5       |
| 29  | What does a STEP file larger than 1.39 MB cost?               | **Unmeasured.** No such file exists in this library. Whether it degrades or takes the process down is unknown.                                                                                             | §5.3       |
| 30  | Is `unsupported` terminal?                                    | **Yes.** `claimPendingPreviews` selects `state = 'pending'` only; the sole thing that re-pends is a content-hash change.                                                                                   | §7         |
| 31  | Has this codebase shipped that defect before?                 | **Yes — 326 blank projects**, recorded in two docblocks.                                                                                                                                                   | §7         |
| 32  | What licence is the parser?                                   | **LGPL-2.1**, no npm dependencies, one 7 604 031-byte WASM blob, three licence texts shipped in the package.                                                                                               | §5.6       |
| 33  | What is `dist/license.occt.txt`?                              | **LGPL-2.1**, 26 936 B, covering the OpenCascade code compiled into the blob. Whether it carries a static-linking exception was **not asked**; see 6.1.                                                    | §5.6       |
| 34  | What would the viewer cost on the wire?                       | **2 324 594 bytes brotli**, 3 091 489 gzip, 7.7 MB decompressed in the tab. Lazy-loadable; a factory, fetched at call time.                                                                                | §6.1, §6.2 |
| 35  | Does STEP fit the viewer's budget model?                      | **No.** `peakCost` is a multiplier with no intercept; STEP's implied cost ranges **201 to 25 142** over the same sample.                                                                                   | §6.3       |
| 36  | Are those viewer numbers usable as they stand?                | **No.** They are Node/Deno RSS. The `FORMATS` docblock records three costs that were wrong for exactly that substitution.                                                                                  | §6.3       |
| 37  | Does `rescan` reclassify a file whose bytes have not changed? | **No.** A stat match short-circuits before `classifyFile` runs. **(code)** `packages/core/src/projects/rescan.ts`.                                                                                         | 3.4        |
| 38  | Does an `other`-kind file have a `previews` row?              | **Yes, `pending`, created on insert for every file of every kind** — never claimed, because the claim filters on `kind`. **(code)**                                                                        | 3.4        |
| 39  | Can a STEP file be handed to a slicer today?                  | **Yes.** `new-project` is offered for every file kind and copies any non-`.3mf`, non-mesh extension into a launch directory. **(code)**                                                                    | 4.1        |
| 40  | Does the spawn set a working directory?                       | **No.** `spawn(command, args, { detached: true, stdio: 'ignore' })`. **(code)** `packages/desktop/src/app.ts`.                                                                                             | 4.5        |
| 41  | Does the packaged app use an asar archive?                    | **No.** `package-app.ts` passes `asar: false`, with a docblock arguing for it. **(code)**                                                                                                                  | 6.3        |
| 42  | Does this repository have a licence?                          | **No.** `package-app.ts`: "There is no LICENSE file and no `author` field anywhere in this repo". **(code)**                                                                                               | 6.2        |
| 43  | Where does the desktop preview queue run?                     | **In the Electron main process**, on its thread, at concurrency 1. **(code)** `packages/desktop/src/previews.ts`.                                                                                          | 5.5        |
| 44  | What npm runtime dependencies does the workspace have?        | **One: `zod`.** `packages/core` has zero. **(code)** `deno.json`, `packages/core/package.json`.                                                                                                            | 6.4        |
| 45  | Does the `SpawnSlicer` seam take an options object?           | **No.** `(command, args) => SpawnedSlicer`, `launch.ts:198`; `app.ts:1174` is a matching two-argument closure. **(code)**                                                                                  | 4.5        |
| 46  | Is `sessionsDir` there when an in-place launch spawns?        | **Not necessarily.** "Created lazily, only by a launch that needs a directory" — `launch.ts:201-202`; an in-place launch needs none. **(code)**                                                            | 4.5        |
| 47  | Does anything sweep `userData` itself?                        | **No.** `sweepAtStart` walks `#sessionsDir`'s subdirectories only, `sessions.ts:403-416`. `userData` holds `state.json`, `slicers.json`, `browse.json`, `model-downloads/`, `slicer-sessions/`. **(code)** | 4.5        |
| 48  | What does a loose file in `sessionsDir` become?               | **An orphan session the user has to answer**, `sessions.ts:709-711`. And a _subdirectory_'s contents are invisible: `:717-718` filters `isFile()`. **(code)**                                              | 4.5, 4.4   |
| 49  | Does `MeshLimits` already reach every parser?                 | **Yes, whole.** `makePreviewHandlers` → `makeMeshHandler` → `readMesh`, from `server/main.ts:64` and `desktop/previews.ts:124`. **(code)**                                                                 | 5.6        |
| 50  | Does the packaging `REQUIRED` list name every migration?      | **No. `001_init.sql` alone** (`package-app.ts:241`); 002 has never been in it. **(code)**                                                                                                                  | 6.3        |
| 51  | How does CI install dependencies?                             | **`deno install --allow-scripts --frozen`, in eight jobs.** **(code)** `.github/workflows/ci.yml`.                                                                                                         | 10.16      |

### 2.1 What the spike could not settle

Named here because parts of this design lean on them.

- **Ctrl+S in each GUI for a STEP input** (§3b, §11.1). The probe that would have answered it could
  not deliver a keystroke: `GetForegroundWindow()` returned `0` for the entire session, the cause is
  undiagnosed, and the pid guard correctly aborted every attempt. This is the question 4.4 turns on —
  and with it 10.13, because the same dialog would have shown the _directory_ of the proposed path
  and not only its name. **No slicer was observed saving a project from a STEP input at all**, which
  is why 4.4's consequence is marked as an inference rather than stated.
- **Whether the model reaches the plate after the import dialog's OK** in PrusaSlicer, Bambu and Orca
  (§11.2). Same cause. The dialogs' own facet counts are strong indirect evidence the file was read.
- **Anything above 1.39 MB** (§11.5). The largest sample in a library of 2 946 files.
- **Chromium's cost for a STEP parse** (§11.4). The single biggest gap for the viewer, and the reason
  7 defers it.
- **macOS and Linux, entirely** (§11.9).
- **Whether Electron packaging leaves the `.wasm` replaceable** (§11.8) — answered in 6.3 by reading
  the packaging script rather than by a spike, and the answer is not the one the question expected.

---

## 3. Detection

### 3.1 Extension only, and the magic check that buys nothing

> **Decision F-1: `.step` and `.stp` classify as `{ kind: 'model', slicer: null }` on the extension
> alone. No content check.**

This adopts the spike's own recommendation (§4c), for its reasons and with its evidence.

**Measurement.** Zero mismatches in both directions over all 2 946 files in the reference library
(§4a): no file with STEP content carries a non-STEP extension, and all ten files with a STEP
extension begin `ISO-10303-21;` at offset 0. A check that cannot change any answer on the corpus it
was written for is speculation with a maintenance cost.

**And the cost is not the argument.** 77.6 µs per file against 0.136 µs (§4b) is 570x in relative
terms and 0.8 ms per full rescan in absolute ones, which nobody would notice. The argument against is
about the _contract_: `classifyFile` is pure and synchronous for `.stl` and `.obj` today, and a magic
check would put a filesystem read — and therefore `open` throwing on a locked, deleted or
permission-denied file — on the one path in the module that has no I/O error path at all. The `.3mf`
branch already does I/O (`classify3mf` calls `readZipEntries`), so this is not a new _class_ of cost;
it is a new failure mode on a branch that has none.

**What the failure it would prevent actually costs.** A `.stp` that is not a STEP file — the format's
one real collision, historically setup and trace files — would classify `model`, reach the mesh
handler, fail the guard in 3.2 and land `failed` **with a message**. One tile, one readable reason,
no data loss. That is a cheaper failure than the one the check would introduce.

The path is lowercased before matching **(code)** — `classifyFile` does `absPath.toLowerCase()` once
and `endsWith` against it — so the uppercase `.STEP` the user already has in their library (§1d,
§2a) is handled by the existing shape, and `extensionOf` in `mesh-handler.ts` folds case for the same
reason. Neither needs changing.

### 3.2 The guard belongs at the point of use, not the point of classification

> **Decision F-2: `parseStepFile` refuses input that does not begin `ISO-10303-21;` with
> `AppError('Validation', …)`, before it hands anything to the parser.**

The spike recommends this (§4c) and it is the half of the magic check that is worth having. The
parser has the bytes already, so it costs nothing; and the queue records a throw as `failed` **with
the message**, where `null` would record a message-less `unsupported` (`mesh-handler.ts`'s docblock
is explicit that this distinction is the point). A `.stp` that is not STEP therefore leaves a row
somebody can read, at the one place in the system that has already paid to look.

The comparison is on the first 13 bytes after leading whitespace is skipped. All ten library files
have the sequence at offset 0 with no BOM and no leading whitespace (§0), so the tolerance is
insurance rather than a measured need, and it is cheap.

### 3.3 What is deliberately not detected

`.p21`, `.stpz`, `.stpnc`: no evidence, none claimed (§2a). OrcaSlicer's MSIX manifest declares
exactly `.step` and `.stp` among its associations (D-spike §2c) — a vendor declaration, not a run,
and it agrees with the two this document ships.

### 3.4 The classification is stale, and `rescan` will never notice

**This section corrects the spike.** §7a states that if `classifyFile` starts returning `model` for
STEP, "`rescan` re-classifies the file, its `kind` changes, and it is pended". **That is true only
for a file the index has never seen.**

**(code)** `packages/core/src/projects/rescan.ts`, in the per-file loop:

```ts
if (Number(known.size_bytes) === file.size && Number(known.mtime_ms) === file.mtimeMs) continue
```

The cheap stat match short-circuits **before** `classifyFile` is called. A `.step` file that has been
indexed once and not touched since keeps `kind = 'other'` for as long as its size and mtime hold —
which, for a model file sitting in a project folder, is for ever.

Two consequences, in opposite directions, and both matter:

1. **The `unsupported` trap is milder than §7a says, for existing files.** Shipping detection without
   a handler would blank **newly discovered** STEP files, not the ten already indexed. The ten would
   simply stay `other` and stay invisible.
2. **The feature would silently not work.** Ship F exactly as the spike describes it and the ten STEP
   files the user actually has get no thumbnail, no viewer link and no `model` kind — because nothing
   re-runs the classifier over them. The user's request would be answered for files they add later
   and not for the ones that prompted it.

The second is the reason this section exists. It is also the same shape of defect as the 326 blank
projects: a terminal-ish state that only an event nobody will cause can leave.

Also **(code)**: a `previews` row is inserted for **every** file at every kind, in state `pending`,
and `claimPendingPreviews` filters `f.kind IN (…)`. So today's STEP files hold a `pending` preview
row that has never been claimed and has never been written. That is the harmless resting state the
spike describes (§7c) and it is why "detection second" would be safe if the release ever split. It
also means the fix below has to move `kind`, and the preview row follows.

### 3.5 The classifier version, and why not a one-shot migration

> **Decision F-3: `files` gains a `classified_by` integer column and `classify.ts` gains a
> `CLASSIFIER_VERSION` constant, starting at 1. Migration 003 is
> `ALTER TABLE files ADD COLUMN classified_by INTEGER NOT NULL DEFAULT 0` — every existing row is
> backfilled with the sentinel 0, which is strictly below every value the constant will ever take.
> `rescan`'s stat-match short-circuit becomes conditional on the row's version matching; a stale row
> is reclassified, its `classified_by` is written, and its preview row is re-pended if and only if
> the kind actually changed. Every write in `rescan` that sets `kind` also writes
> `CLASSIFIER_VERSION` — all three of them.**

The spike considered two shapes for the sibling problem in §7b and preferred the general one. This
applies the general one at the layer where the staleness actually is.

**The migration's default is the whole mechanism, and the wrong one is a silent no-op.** If 003
backfilled the shipping `CLASSIFIER_VERSION` instead of a sentinel below it, no row would be stale,
nothing would reclassify, and the user's ten STEP files would stay `kind: 'other'` — the exact
outcome 3.4 exists to prevent, reintroduced by the fix for it, and with no symptom to notice: the
migration succeeds, the rescan succeeds, and the feature is simply absent. So the pair is stated
here and not left to the plan: **`DEFAULT 0` in the migration, `CLASSIFIER_VERSION = 1` in
`classify.ts`.** 0 is a value the constant can never take, which makes "this row predates the
mechanism" expressible rather than inferred. `NOT NULL DEFAULT 0` is also what makes the column
readable without a null branch, and SQLite's `ADD COLUMN` accepts it precisely because the default is
a constant — the same shape as 002's `ALTER TABLE previews ADD COLUMN claimed_at INTEGER` **(code)**,
which is the only precedent this repository has.

**Three writes set `kind` today, and all three have to set the version.** Leave any of them alone and
its rows are permanently stale — reclassified on every rescan for ever, which turns the 402 zip reads
below from a cost per version bump into a cost per **tick**. **(code)**
`packages/core/src/projects/rescan.ts`:

| Site                                                                                        | Today                                                           | What F-3 requires                                               |
| ------------------------------------------------------------------------------------------- | --------------------------------------------------------------- | --------------------------------------------------------------- |
| `insertFile`'s `INSERT` (`:113-116`), run at `:175-185` for a file the index has never seen | eight columns, no `classified_by`                               | a ninth column and a ninth `?`, bound to `CLASSIFIER_VERSION`   |
| the stat-mismatch `UPDATE` (`:198-201`), run at `:196-202`                                  | sets `kind`, `slicer`, `size_bytes`, `mtime_ms`, `content_hash` | also sets `classified_by = ?`                                   |
| the new version-mismatch branch                                                             | does not exist                                                  | reclassifies and writes `classified_by`, per the decision above |

And a fourth line that is not a write but without which the branch cannot be written at all: the
`existing` map is built from `SELECT id, rel_path, size_bytes, mtime_ms FROM files` (`:164-165`), so
**the SELECT gains `classified_by`** — there is nothing to compare against otherwise.

**The new branch needs `insertPreview` beside `resetPreview`, for the same reason the existing one
does.** `resetPreview` (`:120-125`) is the only re-pend statement in the file, and the stat-mismatch
path guards it: `if (preview) resetPreview.run(now, known.id) else insertPreview.run(known.id, now)`
(`:211-215`). A bare `UPDATE previews … WHERE file_id = ?` against a row that is not there updates
nothing and reports nothing, so a file whose preview row is missing — a database restored without it,
a row deleted by hand, any future path that inserts a file without one — would reclassify to `model`
and then never render. The version-mismatch branch takes the same two-armed form, and increments
`result.previewsQueued` where it re-pends, as that path does. **`RescanResultDto` gains no field in
F:** a `reclassified` count would be a contract change in three packages for a number nothing
displays, and the re-pends are already counted where the existing re-pend counts them.

**Against the alternative, which is a one-shot migration.** A migration that sets
`kind = 'model', state = 'pending'` for rows whose `rel_path` ends `.step` or `.stp` is four lines of
SQL and it would work. Three reasons it is not what ships:

- **It has to be written again for the next format**, and the next one may not be expressible in SQL
  at all. Classification is not purely extension-driven — `classify3mf` reads zip entries — so an
  SQL rule can only ever cover the subset that happens to be a suffix test today.
- **It states the classification rule a second time**, in a language that cannot import it. The rule
  is in `classify.ts`; a migration that re-implements one branch of it is exactly the kind of second
  spelling this repo's docblocks keep refusing (`SLICER_IDS`, `makePreviewHandlers`,
  `DEFAULT_CONCURRENCY` read rather than copied).
- **It must ship in the same release as the handler or it does nothing** — a constraint the general
  fix does not have, because bumping `CLASSIFIER_VERSION` is what triggers it and the bump lands with
  whatever change made it necessary.

**Cost, and the honest version of it.** A numbered migration file (003 — there are two today and
`runMigrations` reads a frozen list **(code)**, so 003 is an entry in `MIGRATIONS` as well as a
file), a column, a constant, and the four edits in `rescan` tabulated above. The
reclassification pass is **not** free: it re-runs `classifyFile` over every indexed file once per
version bump, and for the reference library's **402 `.3mf` files** that is 402 zip reads. It does
**not** re-hash — the content hash is untouched, because nothing about the bytes changed — so it is a
one-time cost on the order of a normal rescan's classification work and not of a full backfill. The
alternative's cost is that the feature does not work.

**What re-pends.** Only a kind that actually changed. A file that reclassifies to the same kind gets
its `classified_by` written and its preview row left exactly as it was, so a version bump for a
`.step` change does not re-render 1 311 STLs.

**Open, and named rather than hidden:** re-pending on a kind change is right for `other → model`. The
reverse — `model → other`, which no change in F causes but a future one could — leaves a `ready` row
with a PNG for a file the viewer no longer offers. Harmless today, and it is the kind of thing that
should be decided when something actually causes it rather than guessed at now.

---

## 4. Handing a STEP file to a slicer

### 4.1 Most of this already works, and the spec should say so rather than design it again

**(code)** `packages/web/.../project-detail.page.ts` offers **"start a new slicer project"** for every
file, gated only on `canLaunch()` — the kind gate is on the _viewer_ link and on "open as it is",
not on this button. And **(code)** `launch.ts`'s `#prepare`, on the `new-project` path, sends any
extension that is not `.stl`, `.obj` or `.3mf` down the `copyFileSync`-into-a-launch-directory branch.

So a `.step` file in the library **can be handed to a slicer today**, through a launch directory,
with no code change at all. What F changes about launching is two things and no more: the Cura
refusal (4.2) and the `cwd` (4.5). The launch path itself is already the one 4.4 concludes is
correct, which makes the conservative decision there also the free one.

`as-is` needs no consideration: it refuses anything that is not `kind: 'slicer_project'` **(code)**,
and STEP is `model`.

### 4.2 Cura cannot open STEP, and what the app does about it

**Measurement (§1d), three ways plus a control.** Cura 5.13.0 handed a `.step` or a `.stp` on argv
reaches one window, title `Untitled - UltiMaker Cura 5.13.0`, no dialog and nothing to dismiss; the
same install in the same session handed `cone.stl` shows `cone - UltiMaker Cura 5.13.0`, so the
absence is measured rather than a broken probe; its own log says `Unsupported Mime Type Database file
extension` seven milliseconds after `Attempting to read file`; and its plugin directory contains
eleven plugins listed by name, none of which reads STEP, in both 5.12.0 and 5.13.0.

And the user has already been in this state: Cura's log carries `Nozzle Wiper Guard.STEP` from the
real library, nine minutes before the spike started, silently dropped by somebody who was not the
spike (§1d).

> **Decision F-4: launching a STEP file into Cura is refused before the spawn, with
> `AppError('Validation', …)` carrying `{ slicerId, extension }`.**

The refusal is an error and not a silent no-op for the reason `host.ts` already gives for its own
refusals **(code)**: an `AppError` keeps its identity across the IPC boundary and the UI can switch
on it. The message names the product, says it cannot read STEP files, and says which other slicer to
choose — because the alternative the user is left with otherwise is the measured one: a healthy
process, an empty plate, and a warning in a log file they will never open.

**What it is not.** It is not a `notices()` sentence. `notices()` says what _will_ happen during a
launch that is going ahead (`launch.ts`, "What the app may honestly say"); this launch does not go
ahead. Warning and launching anyway would be the silent-discard case with extra words, and D already
settled the analogous question for Anycubic's strip refusal: "the tempting fallback — launch the
original instead — _is_ the silent-discard case."

**Which slicer gets chosen** is `chooseSlicer` **(code)**: an explicit `opts.slicerId`, or the
configured default, because the current UI has no per-launch picker. So the common shape of this
refusal is "your default slicer is Cura and this file is a STEP", and the message has to be readable
as that. If a picker is ever added, the capability flag below is what greys the entry out, and the
refusal stays as the thing that catches a stale UI.

### 4.3 The registry grows one field, and the "no `strip` field" docblock does not forbid it

`registry.ts`'s module docblock **(code)** says two things that a proposal to add a field has to be
read against:

- **"Code, not configuration. Every field is a measured property of the product."**
- **"There is deliberately no `strip` field (D decision 1). The strip sets are indexed by the flavour
  of the _file_, not by the slicer being launched … and a `SlicerId`-keyed table cannot express the
  parent spec §3.4 rule-4 case, which is a classification with no `SlicerId` at all."**

> **Decision F-5: `SlicerDef.behaviour` gains `opensStep: boolean` — `false` for `cura`, `true` for
> the other four.**

Both tests pass, and the second one passes for a reason worth spelling out rather than asserting.

- **It is a measured property of the product**, from §1 — the same table that produced
  `savesInPlace`, `discardsForeignProjects`, `alwaysPromptsOn3mf` and `promptsWithoutOwnConfig`. A
  wrong value here is the app refusing a launch that would have worked, or spawning the silent
  discard; a user has no business editing it, which is the docblock's own test.
- **The `strip` argument runs the other way here.** Strip sets are indexed by the flavour of the
  _file_ and so cannot live on a `SlicerId` key. STEP capability is indexed by the _product_ and
  cannot live anywhere else: it is a fact about Cura, measured on Cura, and the file has nothing to
  do with it. The two cases are opposites, and the docblock's reasoning is what makes them so.
- **`notices()` is the precedent for how it gets consumed** **(code)**: three of its four
  slicer-specific rows are driven by `behaviour` flags rather than by an id comparison, "so the
  sentences follow the product's measured property". The refusal in 4.2 keys on `opensStep` for the
  same reason — the one place a fifth slicer's capability has to be stated is the row that states
  everything else about it.

**What it is not, and this bounds it:** `opensStep` is not a general capability matrix. It is one
boolean because exactly one measurement distinguishes exactly one product. A `formats: Set<string>`
per slicer would be four rows of speculation and one row of evidence, and the four would be
unfalsifiable until somebody added a format nobody had measured.

**And the `behaviour` docblock itself changes, which is the part a field addition is most likely to
skip.** `registry.ts:63-66` **(code)** says these flags are "Read by the launch paths to decide what
the app may honestly claim" — true of all four flags today, because all four feed `notices()`.
`opensStep` is read to _refuse_ a launch, and a refusal is not a claim about a launch that is going
ahead; 4.2 makes exactly that distinction against `notices()` and it applies to this sentence too. It
is in 5.7's table with the rest.

**Not on the DTO in F.** `SlicerInstallDto` does not grow a capability field, because nothing in the
UI would read it: there is no per-launch slicer picker. When there is one, that is the change that
adds it, and it should add it then rather than F shipping a field with no consumer.

### 4.4 In place, or a launch directory

> **Decision F-6: STEP goes through a launch directory, like everything that is not `.stl` or
> `.obj`. This adopts the spike's recommendation (§8a), and it is also what the code already does
> (4.1) — so it ships by changing nothing.**

**What is measured in favour of the other answer**, stated first because it is genuinely good:

- **No slicer was observed proposing to write over a `.step`.** PrusaSlicer with no `--output` writes
  `<basename>.3mf` in the input's own directory and leaves the source byte-identical — 53 643 bytes,
  mtime unmoved (§3a). That is byte-for-byte the same rule it applies to a `.stl`, whose GUI Save
  dialog was separately measured proposing the same thing (D-spike §13).
- **The data-loss mechanism cannot arise.** What made a `model`-kind `.3mf` a Critical finding in D
  is that `<basename>.3mf` **is the source file's own name**. A `.step` or `.stp` input cannot
  collide that way; the extensions differ.

**What is missing**, and why it decides this:

**The measurement §3 actually asked for — what Ctrl+S proposes in each GUI for a STEP input — does
not exist**, for any of the four STEP-capable slicers (§3b, §11.1). What stands in its place is one
console export path plus an inference from the `.stl` rule. The `.stl` in-place branch rests on a GUI
Save dialog somebody drove; STEP's would rest on an argument.

**And the last time that substitution was made, it produced a Critical data-loss defect** — D's
config-less `.3mf`, reasoned about rather than measured, caught in review and now pinned by a test
that "asserts the exact path that was spawned rather than trusting this paragraph" **(code)**.

The trade is one-sided. A launch directory costs a copy of at most 1.4 MB and one directory, and it
is trivially reversible. Being wrong in the other direction costs a file the user cannot get back.

**What flips this, precisely.** A run that focuses each of PrusaSlicer, Bambu, Orca and Anycubic with
a `.step` loaded, presses Ctrl+S, and reads the proposed path out of the Save dialog. If all four
propose something whose name is not the source's, STEP joins the no-copy branch and this becomes a
one-line change in `#prepare`. The probe is the same one D-spike §13 ran for `.stl`; it failed today
for a machine reason (`GetForegroundWindow()` returning 0, undiagnosed) and not a design one.

**One consequence to expect rather than discover — and it is an inference, not a statement about the
code.** Through a launch directory, a new project the slicer saves _beside the copy_ comes back
through D's session and reconcile machinery rather than through a rescan of the project folder. That
is a different user flow from `.stl` — one extra answer — and it is the price of the caution above.
It is also the flow every remote-mode launch already takes **(code)**, so nothing new is built for it.

**What is measured and what is not, because an earlier draft asserted this flatly.** The machinery is
real and was read: `#scan` reports a file in a launch directory that is neither `launch.json` nor the
launched file as a session of its own **(code)** `sessions.ts:697-702`, `:720-731`. But it reads **one
level and files only** — `readdirSync(...).filter(child => child.isFile())` (`:717-718`) — and **no
slicer was observed saving a project from a STEP input at all.** The Ctrl+S probe is precisely what
failed (§3b, §11.1), which is the same missing measurement that decides 4.4 itself. So the honest
form is: _if_ a slicer saves a file into the launch directory, the machinery sees it; whether any of
the four does, and whether it puts the file where the machinery looks, is **unmeasured**. That second
half is not idle — the one cwd-relative write anyone has measured in this project is Anycubic's
`stl/obj_1_….stl`, into a **subdirectory**, which `:717-718` cannot see. It is 10.13.

### 4.5 The explicit `cwd` — a live defect in shipped code

**Measurement (§3a, §12), found by accident.** `AnycubicSlicerNext.exe --export-stl <file>` exited 0,
left the source byte-identical, wrote nothing into the input's directory, and created
`stl/obj_1_Ender_3_fan_redirect_v4.step.stl` — 2 456 984 bytes — in a directory **relative to the
calling process's working directory**. The probe shell's cwd was the repository root, so it landed in
this repository. It was found by the post-probe `git status --porcelain` snapshot and removed.

**(code)** `packages/desktop/src/app.ts`:

```ts
const child = spawn(command, [...args], { detached: true, stdio: 'ignore' })
```

No `cwd`. An Electron main process inherits its working directory from whatever launched it — the
directory a shortcut points at, the directory a terminal was in, or on some launch paths the
application directory itself.

> **Decision F-7: the spawn sets an explicit `cwd` — the launch directory when there is one, and a
> dedicated scratch directory `<userData>/slicer-cwd/`, created before every spawn that has no
> launch directory, when there is not. The `SpawnSlicer` seam type widens to carry it. Scoped as a
> subsystem-D fix that F carries rather than as a STEP feature.**

**Scope.** This is **not** about STEP. The measured behaviour is Anycubic resolving an export path
against its process cwd, and Anycubic is spawned for `.stl` and `.obj` and `.3mf` today. The defect
is shipped, it is in D's code, and F fixes it because F is the document that found it.

**The seam changes, and the spec has to say so or this is not implementable.** **(code)**
`launch.ts:198`: `export type SpawnSlicer = (command: string, args: readonly string[]) =>
SpawnedSlicer` — **there is no options parameter**, and `app.ts:1174` supplies a matching
two-argument closure. So three things move together, and none of them is optional:

- **`SpawnSlicer` gains a third parameter**, `options: { cwd: string }` — a required object with one
  required field, not an optional bag, because a `cwd` that can be omitted is a `cwd` that will be.
  Narrow on purpose: `detached` and `stdio` are the real spawn's business and no test asserts them
  through this seam.
- **`app.ts:1174`'s closure takes it** and spreads it:
  `spawn(command, [...args], { cwd, detached: true, stdio: 'ignore' })`.
- **`#spawnOrClean` threads it** (`launch.ts:711-713`). It already receives the whole `LaunchPlan`,
  which already carries `directory: string | null` (`:401-408`), so the call becomes
  `this.#spawn(executable, SLICERS[slicerId].argv(plan.path), { cwd: plan.directory ?? scratchDir })`
  and no signature above it changes. `SlicerLauncherOptions` gains the scratch directory beside
  `sessionsDir`, resolved by `app.ts` from `userData` the way `sessionsDir` is (`app.ts:1156`).

**Which directory, and why not either of the two obvious answers.** An earlier draft of this section
said "the app's own `userData`" and claimed both candidates are "directories this app already owns
and already sweeps". **Both halves of that were wrong, and the second was wrong in a way that would
have broken every in-place launch.**

- **Not `userData` itself.** It holds `state.json`, `slicers.json` and `browse.json` — all three
  written through `json-store.ts` — plus `model-downloads/` and `slicer-sessions/` **(code)**
  (`app.ts:982`, `:986`, `:1084`, `:1135`, `:1156`). The library database is _not_ there: it is
  `<libraryDir>/.spm/app.db` **(code)** (`db/open.ts:17`, `:47`), which is worth stating because the
  opposite is an easy thing to assume and it would change what is at risk. What is at risk is enough:
  pointing a slicer's cwd at the directory holding the app's own configuration is a smaller version
  of the defect being fixed.
- **Not `sessionsDir`, and this is the load-bearing correction.** `launch.ts` does not hold
  `userData` at all — it holds `sessionsDir` (`:201-202`), documented as "**Created lazily**, only by
  a launch that needs a directory". An in-place launch is by definition one that does not need a
  directory, so on a fresh profile the path does not exist, `spawn` throws `ENOENT`, and
  `#spawnOrClean` converts it into `AppError('Internal', 'could not start <slicer>')` — **every
  in-place launch fails, for every slicer, until some other launch happens to create the
  directory.** And it is not swept: `sweepAtStart` walks `#sessionsDir`'s _subdirectories_ only
  (`sessions.ts:403-416`). Worse, a cwd-relative export landing loose in `sessionsDir` is surfaced to
  the user as an **orphan session** (`sessions.ts:709-711` treats any loose file there as one),
  which is a launch they never made appearing in a list they have to answer.
- **`<userData>/slicer-cwd/`, created with `mkdirSync(dir, { recursive: true })` immediately before
  every spawn that needs it** — not once at construction, so a profile where the user deleted it
  between launches still works, and not lazily-on-first-use, because "created lazily" is exactly the
  property that makes `sessionsDir` unusable here. It is empty by construction: nothing this app
  writes goes there, so anything in it arrived from a slicer. The name is a constant beside
  `SLICER_SESSIONS_DIR` (`launch.ts:90`) and `app.ts` joins it to `userData` at `:1156` alongside the
  sessions directory, so there is one spelling of it and `app.ts` remains the only file that knows
  where `userData` is.

**What this fixes, what it does not, and the asymmetry between the two cwds.** It bounds one measured
mechanism — cwd-relative resolution — and says nothing about a slicer resolving against an absolute
configured path. Anycubic's `--export-stl` with `--outputdir` set is **unmeasured** (§11.10), and the
app passes neither flag; it passes `[file]` for all five products **(code)**. Beyond that:

- **A launch-directory cwd makes a loose stray visible.** `#scan` reports a file inside a launch
  directory that is neither `launch.json` nor the launched file as a session of its own, with a
  `console.warn` (`sessions.ts:697-702`, `:720-731`) — the docblock names "a Cura Save-As aimed at
  the launch directory" as the case it is for, and a cwd-relative export is the same shape.
- **A stray in a _subdirectory_ stays invisible in both cwds.** `#scan` filters `child.isFile()`
  (`sessions.ts:717-718`), so a subdirectory's contents are not seen at all — and the one measured
  cwd-relative write in this whole document is `stl/obj_1_….stl`, **a subdirectory**. So for the
  Anycubic shape specifically, the `cwd` moves the file from an inherited unknown to a directory the
  app owns and does not move it into anything that surfaces it. That is an improvement and not a
  solution, and it is 10.13.
- **Nothing sweeps `slicer-cwd`, and F does not claim otherwise.** It is not under `sessionsDir` so
  `sweepAtStart` never sees it, and F deliberately does not add a sweeper: deleting a file a slicer
  wrote is D's constraint 10 territory, and the directory grows only by the strays it is there to
  catch — which, on the evidence, is one product on one flag. What it must never become is a
  directory this document _says_ is swept when it is not.

**How it is pinned.** `test/slicers-launch.test.ts` already asserts the exact path spawned. The
recorder's signature widens with the seam, so it captures the options object, and the assertion gains
the `cwd` for **both** paths — the launch-directory case and the in-place case, where the expected
value is the scratch directory. The in-place assertion is the one that matters: it is the case an
implementer is most likely to leave defaulting to `undefined`, and `spawn` with no `cwd` is silently
the shipped defect again. No slicer required.

---

## 5. Thumbnails

This is the part the user asked about with "if it is possible with moderate effort". The code is
moderate — a ~24-line adapter and a ~35–45 line handler arm, measured (§5.4). The memory is not, and
5.3 onwards is about nothing else.

### 5.1 The adapter, and where it lives

> **Decision F-8: `packages/core/src/previews/mesh/step.ts`, beside `stl.ts`, `obj.ts` and
> `threemf.ts`, exporting `parseStepFile(absPath, limits): Promise<Mesh>`.**

**Measured (§5.4), not designed.** A scratchpad script imported the repo's _actual_ `renderMesh`,
`encodePng`, `assertMeshFits` and `allocateMesh` by absolute `file:///` path and pushed all ten files
through them. Ten of ten produced a valid 256×256 PNG. The adapter costs 0.6–3.3 ms — under 0.3 % of
the parse — and the rasterizer needs no change whatever.

Two shape mismatches, both measured, both handled by the same loop:

- `renderMesh` wants **one** `Mesh`, a `Float32Array` triangle soup of `triangleCount * 9` floats.
  `occt-import-js` returns an **array** of **indexed** meshes.
- `positionsIsTypedArray: false` and `indexIsTypedArray: false` on **all ten files** — it returns
  plain JavaScript number arrays, so the de-index loop does the float conversion for free.

It calls `assertMeshFits` and `allocateMesh` from `limits.ts` unchanged, and therefore inherits the
existing ceiling and the existing `AppError('Validation', …)` failure contract. **But see 5.7 for
what that inheritance does and does not mean** — `assertMeshFits` runs after OCCT has already
allocated everything, which is not the order its own docblock is written for.

### 5.2 The handler arm

`readMesh` in `mesh-handler.ts` gains two cases on one arm:

```ts
case '.step':
case '.stp':
  return parseStepFile(absPath, limits)
```

Nothing else in the preview chain changes, and one thing that looks like it should does not:
`EMBEDDED_HANDLER_WITH_MODELS` is first in `PREVIEW_HANDLERS` and claims `model`, so it sees every
STEP job first — and **(code)** `extractEmbeddedThumbnail` returns `null` for anything that is not a
readable zip, which is the "not my job, ask the next one" answer. STEP falls through to the
rasterizer exactly as `.stl` does. `handlers.ts` needs no edit.

### 5.3 The 243 MB floor

**Measurement, and it is the headline risk (§5.3, §8d).** Peak RSS for one STEP parse, one Node
process per file:

| Input                                    | Bytes     | Triangles | Peak RSS        |
| ---------------------------------------- | --------- | --------- | --------------- |
| `cube.stp` (the package's own test file) | 8 247     | 12        | **207 347 712** |
| `Ender_3_fan_redirect_v4.step`           | 53 643    | 3 380     | 244 998 144     |
| `oralB_head_cover.stp`                   | 636 991   | 17 710    | 266 899 456     |
| `Printable_Wrench.A.15.stp`              | 1 388 035 | 20 530    | **278 364 160** |

**An 8 KB file with twelve triangles costs 207 MB.** Fitting a line through the real sample's extremes
gives a slope of ~25 bytes of peak per input byte and an **intercept of ~243 MB, which is 87 % of the
largest measured peak.** This is not a multiplier with a rounding term; the intercept is the cost.

Four things are established about it, and one is not:

- **It is not the mesh.** The largest `positions` array in the whole sample is 796 932 bytes. So
  `DEFAULT_MAX_MESH_BYTES` and `assertMeshFits` do not bound it, and no count-before-allocate check
  can, because the triangle count is unknown until OCCT has already tessellated.
- **It is not V8 garbage.** A 128x range of `--max-old-space-size` moves the peak by under 2 %.
- **It is not the WASM linear heap**, which is 30–62 MB throughout.
- **The measurement is sound.** Node `maxRSS` and Win32 `PeakWorkingSet64` agreed to the byte.
- **The mechanism is unexplained.** ~100 MB of the peak is attributed to no counter the harness reads
  (§5.3). Reproducible, cross-validated, and unaccounted for.

**The one good property, which is what makes any of this tractable: it is paid per process, not per
file.** `maxRSS` stayed flat at **243 990 528** across all ten files _and a second full pass over the
same ten_, with no leak and warm parses ~30 % faster.

**A precision the spike's own summary overstates slightly, and it matters for the arithmetic.** §8d
says "a STEP-capable worker starts at ~245 MB before it reads anything". Its own numbers say
something narrower: bare Node is 48 873 472; the module **instantiated with nothing parsed** is
72 421 376; the floor arrives with the **first parse** and then holds. Between parses the _resident_
set falls back to 161–180 MB. So the honest three numbers are:

- **+24 MB** to instantiate the module,
- **~244 MB peak** during any parse, from the first one onward,
- **~112–131 MB retained** above a bare process between parses, permanently.

A process that never parses a STEP file pays nothing, because instantiation happens on first use (the
glue is a factory and the `.wasm` is fetched at call time, §6.2).

### 5.4 What the floor does to `DEFAULT_CONCURRENCY`, and what it does not

`queue.ts`'s `DEFAULT_CONCURRENCY = 1` rests on "a worker is worth about 290 MB at the worst" against
"a 2 GB NAS with a 500 MB budget", with whole-library backfills measured at 400–410 MB at one worker
and 620–621 MB at two **(code)**.

> **Decision F-9: `DEFAULT_CONCURRENCY` stays 1, and its docblock is amended rather than its value.**

**The floor does not multiply with concurrency, and that is a property of the code rather than a
hope.** **(code)** `runPreviewQueue`'s "workers" are plain async functions racing over one job array
in **one process on one thread**. There is one module instance and one WASM heap however many workers
there are. The mesh cost _does_ multiply — each job holds its own `positions` — which is what the
existing 400 → 620 MB measurement shows. The STEP floor is a per-process constant sitting underneath
that, not a per-worker term.

So the arithmetic changes shape rather than magnitude — **but only at concurrency 1, and the
qualification has to travel with the formula.** `SPM_PREVIEW_CONCURRENCY` is an operator's setting
(`queue.ts:61` **(code)**), so "concurrency 1" is a default and not a property of the system:

- **Before:** `concurrency × (mesh + ~80 MB) + ~120 MB`.
- **After, at concurrency 1**, for a process that has parsed at least one STEP file:
  `mesh + ~80 MB + ~120 MB`, **or** ~244 MB during a STEP parse — whichever is larger, **not** the
  sum. At one worker the two jobs cannot be in flight together, so only one of the two terms is ever
  the peak.
- **After, at concurrency ≥ 2: they add.** The STEP parse is synchronous, so no other worker executes
  JavaScript while it runs — but a worker can be _holding_ an allocated `positions` array across an
  `await` when it starts, and the reference library's worst is 208.8 MB of it. The worst case is
  therefore `(concurrency − 1) × (mesh + ~80 MB) + ~120 MB + ~244 MB`, and the "whichever is larger"
  reading is wrong there by up to a whole mesh.

**That second line is arithmetic on two separately measured processes, not a measurement**, which is
the same substitution 10.3 exists to close — it is stated as the shape an operator raising the
concurrency should expect, and the number is not claimed. **This qualification goes into the
`DEFAULT_CONCURRENCY` docblock with the formula** (5.7): the docblock outlives this paragraph, and a
formula that is only true at the default is worse there than no formula, because the docblock is what
an operator reads _before_ raising the default.

**And the honest gap: nobody measured a process that does both.** The 400–410 MB backfill figure is
the mesh path alone; the 244 MB figure is the STEP path alone in a process that does nothing else.
What a process that has parsed a STEP file (retaining 112–131 MB) then costs while allocating the
library's 208.8 MB mesh is **unmeasured**. The direction is up, the two are not additive, and this
document does not put a number on it. It is 10.2.

**Should the STEP arm be operator-optional, like the rasterizer itself is?** **No — and the reason is
a hard constraint, not a preference.** A handler has exactly two outcomes **(code)**: `null` →
`unsupported`, and a throw → `failed`. **Both are terminal, and neither is re-claimed.** There is no
"leave this pending" outcome. So a switched-off STEP arm would blank every STEP file permanently, and
an operator who switched it on later would find nothing had come back. An opt-out is only expressible
at _classification_ — a `.step` that stays `kind: 'other'` is invisible to the queue and leaves no
terminal row (3.4) — and turning it off there would also take STEP out of the viewer link and out of
the model kind generally. So: **anyone who has opted into the rasterizer gets STEP.** That follows
from the queue's contract and is not a judgement.

### 5.5 A synchronous parse on the shell's main thread

Two facts that have not been put together anywhere yet.

**(code)** `packages/desktop/src/previews.ts`: in local-folder desktop mode there is no server, so the
Electron **main process** ticks the preview queue itself, every 5 s, at concurrency 1 — on the same
thread as the IPC dispatch table and the `spm://` handler that serves the thumbnails it produces. Its
own docblock says exactly that.

**Spike (§5.1, §5.4, §5.5):** `occt.ReadStepFile(bytes, params)` is called synchronously and returns
its result directly; all four entry points are whole-buffer and there is no streaming form. The
measured parse times are **217–1 307 ms** cold, ~30 % less warm.

Together: **a STEP thumbnail blocks the Electron main process for up to about 1.3 s.** Every other
parser in `packages/core` streams and yields; this one cannot. `mesh-handler.ts`'s docblock says the
asynchrony exists only because `DecompressionStream` forced it, and that the peak "is not a function
of the file at all" — both sentences stop being true for this arm (5.7).

**Whether that is perceptible to a user is unmeasured.** It is one stall per STEP file, once, and the
library has ten. On the Deno server it is a stall in a request-serving process that is doing nothing
else at the time.

**Two sharper questions hide behind "perceptible", and neither is asked by that word.** What a
`spm://` thumbnail request does when it arrives on the thread OCCT is holding is **unmeasured**
(10.15) — the likely answer is that it waits, and "likely" is not a measurement. And what happens
when the user quits mid-parse is **unmeasured** (10.14): `will-quit` cannot even be dispatched until
the parse returns, so the window stays up for the remainder of the block. Both are named here rather
than folded into "perceptible", because a stall a user waits through and a window that will not close
are different reports.

> **Decision F-10: F ships the synchronous parse on the queue's own thread, and does not build a
> worker.**

Moving it to a `worker_thread` would keep the UI responsive and would **not** reduce the memory, since
a worker thread shares the process's address space — the floor is an RSS property of the process. It
would add a worker lifecycle, a transfer protocol for the mesh, and a second failure mode, to
`packages/core`, which has none of that today. A _child process_ would isolate the floor but pay it
**per file**, which is precisely what §8d's per-process finding argues against. Neither is worth it
for ten files and a measured 1.3 s. Both become worth reconsidering if 10.2 comes back badly, and
that is recorded in 10.6 rather than pre-decided here.

### 5.6 The size ceiling: what it is, and what it is not

> **Decision F-11: `parseStepFile` refuses a file larger than `DEFAULT_MAX_STEP_BYTES = 10_000_000`
> with `AppError('Validation', …)` naming both sizes, before it reads the file. It reads the ceiling
> from `MeshLimits`, which gains a second optional field `maxStepBytes`. The server exposes it as
> `SPM_MAX_STEP_MB`, default 10.**

**The threading is decided here rather than left to the plan, because the shape of that omission is
what made subsystem E's plan §6.4 unimplementable.** **(code)** today:
`MeshLimits = { maxMeshBytes?: number }` (`limits.ts:34-38`), docblocked "**Options every mesh parser
takes**, so the ceiling is the caller's to raise"; `makeMeshHandler(limits?: MeshLimits)`
(`mesh-handler.ts:91`) hands it to `readMesh`; `makePreviewHandlers(limits?: MeshLimits)`
(`handlers.ts:54-55`) forwards it; `server/main.ts:64` calls
`makePreviewHandlers({ maxMeshBytes })` and `desktop/previews.ts:124` calls
`makePreviewHandlers({ maxMeshBytes: opts.maxMeshBytes ?? PREVIEW_MAX_MESH_BYTES })`.

**So the field rides the parameter that already exists, and no signature changes at all.** That is
the argument for putting it on `MeshLimits` rather than beside it: `parseStepFile(absPath, limits)`
is a mesh parser by F-8 and takes the type its three siblings take, and a second options object
threaded in parallel would be a second spelling of one seam through four call sites. Precisely:

| Where **(code)**                                         | Change                                                                                                                                                                                                                                                                                                                              |
| -------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `previews/mesh/limits.ts:34-38`                          | `MeshLimits` gains `maxStepBytes?: number`, defaulting to `DEFAULT_MAX_STEP_BYTES`; the new constant lands beside `DEFAULT_MAX_MESH_BYTES`                                                                                                                                                                                          |
| `previews/mesh/step.ts`                                  | `parseStepFile` reads `limits?.maxStepBytes ?? DEFAULT_MAX_STEP_BYTES` and refuses on the `statSync` size, before the read                                                                                                                                                                                                          |
| `previews/mesh-handler.ts:91`, `previews/handlers.ts:54` | **nothing** — both already take and forward `MeshLimits` whole                                                                                                                                                                                                                                                                      |
| `server/src/env.ts`                                      | `MAX_STEP_MB`, `DEFAULT_MAX_STEP_MB`, and `resolveMaxStepBytes(raw)` in `resolveMaxMeshBytes`'s exact shape (`:183-192`): megabytes of 1 000 000, `requireWholeNumber`, a ceiling. `ServerEnv` gains `maxStepBytes` (`:207-217`) and `readServerEnv` gains `maxStepBytes: resolveMaxStepBytes(get('SPM_MAX_STEP_MB'))` (`:226-233`) |
| `server/main.ts:64`                                      | `makePreviewHandlers({ maxMeshBytes, maxStepBytes })`                                                                                                                                                                                                                                                                               |
| `desktop/src/previews.ts`                                | `PREVIEW_MAX_STEP_BYTES = DEFAULT_MAX_STEP_BYTES` beside `PREVIEW_MAX_MESH_BYTES`; `PreviewTickerOptions` gains `maxStepBytes?: number` (`:101-113`); `:124` passes it the same way it passes the mesh ceiling                                                                                                                      |

**Two things about it that are not tidy, said rather than smoothed over:**

- **`maxStepBytes` bounds a _file_; every other member of `MeshLimits` bounds a _mesh_.** The type's
  name becomes slightly wrong. It is not renamed: a rename touches every parser signature in the
  package for a naming improvement, and F is already amending four docblocks in that module (5.7).
  The docblock is what carries the distinction instead — and it has to, because
  `DEFAULT_MAX_MESH_BYTES`'s own docblock currently says "Every read in this package is streamed, so
  the document is no longer part of the peak", which is the sentence 5.7 already requires be excepted.
- **`assertMeshFits` does not read it.** It takes `MeshLimits` and uses `maxMeshBytes` alone
  (`limits.ts:52-57`); `maxStepBytes` has exactly one reader, `parseStepFile`. A ceiling with one
  reader in a shared options type is worth naming so nobody adds a second reader by analogy.

**`MAX_STEP_MB` is 2 048, matching `MAX_MESH_MB`, and for a weaker reason than that one has.**
`MAX_MESH_MB`'s 2 048 is structural — `positions` is one `Float32Array` and 2 GB is 512 million
elements, inside V8's element limit **(code)**. Nothing equivalent constrains a STEP input; 2 048 here
is a typo guard, matched to the neighbouring constant so an operator reading `env.ts` does not have to
learn two ceilings. It is **not** a promise that a 2 GB STEP file parses — 10.2 says nothing above
1.39 MB has been measured at all, and an operator who sets it anywhere near the ceiling is past the
edge of every measurement in this document.

**Where 10 MB comes from, and it is arithmetic on an admittedly weak slope.** The fitted model is
~243 MB of intercept plus ~25 bytes of peak per input byte (§5.3). At a 10 MB input that predicts
243 + 250 ≈ **493 MB — the entire 500 MB NAS budget, on one file.** So 10 MB is the point at which
even the optimistic reading of the measurement exhausts the deployment target's whole budget. It is
also **7.2x the largest STEP file in the reference library** (1 388 035 bytes), so nothing the user
has comes near it.

**What this ceiling is not, said plainly because a ceiling that oversells itself is worse than none:**

- **It is not a memory model.** The spike is explicit that the intercept so dominates the observed
  range that the slope is "barely constrained" and "could be off by an order of magnitude in either
  direction and this data would not notice" (§5.3). Two points, 33 MB of spread against 233 MB of
  intercept.
- **It cannot be accurate, because cost tracks surface complexity rather than size.** 386 KB yielded
  22 137 triangles; 497 KB yielded 2 698 — an 8x spread from similar inputs (§5.3). A 9 MB extruded
  prism will be admitted and cost little; a 2 MB dense freeform surface may cost more than its size
  implies. **A size-keyed guard mis-prices both, and there is no other signal available before the
  parse** — the triangle count does not exist until OCCT has tessellated.
- **It is a guard against the unmeasured**, and that is its whole claim: it stops the app walking into
  the region §11.5 says nobody has been to, where "whether a large STEP fails gracefully or takes the
  process down is unmeasured". On the desktop, "takes the process down" means the user's window.

**Two properties it inherits from the existing shape, one good and one not:**

- The refusal is `AppError('Validation', …)` naming the file's size and the permitted one, exactly as
  `assertMeshFits` does, so the row is `failed` **with a readable message** rather than a blank
  `unsupported`.
- `failed` is terminal, so **raising `SPM_MAX_STEP_MB` does not bring the refused file back** until
  its bytes change. That is already true of `SPM_MAX_MESH_MB` today; F does not fix it and does not
  make it worse, and it is named here so nobody discovers it in the field. The general remedy is 3.5's
  version mechanism applied to the preview layer, which the spike also names (§7b) and which F does
  not build.

**The two halves above have to be joined, because a wrong ceiling is not self-correcting.** 10 MB is
a judgement on a barely-constrained slope, and `failed` is terminal. Put together: **the rows the
guess condemns stay condemned after 10.2 lands and the constant moves.** An operator who raises
`SPM_MAX_STEP_MB` from 10 to 40 because the measurement said 10 was too low gets the new ceiling for
files the queue has not yet seen, and nothing at all for the ones already refused — the same shape as
the 326 blank projects, arriving through a configuration change rather than a release.

**What the operator actually does about it, stated so it is not discovered:** touch the file's bytes.
A rescan that sees the content hash change resets the preview row to `pending` and zeroes `attempts`
**(code)** — a rewrite in place, or a copy-and-replace, is enough, and it is the only mechanism the
shipped code offers. The alternative is to wait for 3.5's version mechanism to be applied at the
preview layer, which would re-pend on a _limits_ change the way F re-pends on a _classifier_ change,
and which **F does not build**: the classifier version is one integer keyed to one pure function,
where a preview version would have to be keyed to a chain of handlers and to two operator-settable
ceilings, and F has no measurement that says which of those a row should be re-pended for. So the
honest statement is that a raised ceiling is forward-only in F, that the remedy is manual and
one-file-at-a-time, and that this is a reason to prefer erring high on the constant rather than a
reason to trust the constant.

The desktop has no environment-variable surface for preview limits **(code)** — `PREVIEW_MAX_MESH_BYTES`
is a constant — so the desktop gets the default and F does not invent a configuration file for it.

### 5.7 Sentences that become false, and where they are

This project's signature defect is a sentence asserting a mechanism the code does not have. Adding a
non-streaming, WASM-backed parser to a package whose docblocks say — accurately, today — that nothing
streams anything else falsifies six of them at once, and F's two non-STEP changes falsify a seventh.
**Each is part of the change, not a follow-up.**

| File **(code)**                                           | The sentence, and what it becomes                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| --------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `previews/mesh-handler.ts`, `readMesh`                    | "none of them ever holds the file … the peak of a preview job is therefore its `positions` array plus a fixed window, **and not a function of the file at all**". True of three arms, false of the fourth. Must name the exception and say the STEP arm holds the whole file twice (§5.5) and costs ~244 MB regardless.                                                                                                                                                       |
| `previews/mesh/limits.ts`, `assertMeshFits`               | "The counts come from a counting pass that allocates nothing … **which is the only order in which a limit is worth having.**" For STEP the counts arrive _after_ OCCT has tessellated, so this call bounds only the adapter's own `positions` allocation. The sentence must say which arms it describes.                                                                                                                                                                      |
| `previews/mesh/limits.ts`, `DEFAULT_MAX_MESH_BYTES`       | "**Every read in this package is streamed**, so the document is no longer part of the peak". Must except STEP, and must say that this constant does **not** bound STEP's cost — which is the single most misleading available inference.                                                                                                                                                                                                                                      |
| `previews/queue.ts`, `DEFAULT_CONCURRENCY`                | "a worker is worth about 290 MB at the worst". Still true for meshes; needs the per-process STEP floor beside it, with 5.4's arithmetic — **including the concurrency ≥ 2 line**, because this docblock is what an operator reads before raising `SPM_PREVIEW_CONCURRENCY` and a formula that holds only at the default is worse here than none.                                                                                                                              |
| `desktop/src/slicers/registry.ts`, `behaviour` (`:63-66`) | "Read by the launch paths to decide **what the app may honestly claim**; never a strip set". `opensStep` is read to _refuse a launch_ (4.2), which is not a claim about a launch that is going ahead — the sentence describes four flags accurately and stops being the whole truth at the fifth. Must say the flags drive two things: what `notices()` says, and whether a launch happens at all. The "never a strip set" half is untouched and 4.3 is the argument for why. |
| `desktop/src/previews.ts`, `PREVIEW_CONCURRENCY`          | "each worker may hold one mesh, so the two numbers are one budget". Needs the floor, and needs 5.5's blocking note, because this is the docblock for the queue that runs **in the main process**.                                                                                                                                                                                                                                                                             |
| `desktop/package-app.ts`                                  | "**There is no LICENSE file and no `author` field anywhere in this repo**", which is the stated reason `appCopyright` is omitted. False the moment 6.2 lands.                                                                                                                                                                                                                                                                                                                 |

Two more outside `core`, in 7.2.

---

## 6. Licence and packaging

**These are facts about artifacts and licence texts, and the obligations the user has already
decided to meet. No legal advice is offered and none is implied.**

### 6.1 The facts, as measured (§5.6)

- `occt-import-js@0.0.23` declares `"license": "LGPL-2.1"` and has **no npm dependencies**.
- It ships the full LGPL-2.1 text as `LICENSE.md`, and two more inside `dist/`:
  `license.occt-import-js.txt` (27 030 B) and `license.occt.txt` (26 936 B).
- `dist/license.occt.txt` is **LGPL-2.1**, 26 936 B, covering the OpenCascade code compiled into the
  blob. **Whether it carries a static-linking exception is unmeasured, and this document withdraws
  the claim that it does not.** An earlier draft of row 33 said so and attributed it to §5.6; the
  word "exception" appears nowhere in the 1 163-line spike, which asked what the licence _is_ and
  never what it _excepts_. The second half of that claim — that upstream OpenCascade publishes such
  an exception — was recalled world knowledge in a table whose preamble says nothing in it is, and it
  is withdrawn too. It could not be re-measured while writing this fix: `occt-import-js` is not
  installed in this tree yet, so there is no `dist/license.occt.txt` to read. _To settle:_ read the
  file after `deno install`, and record what §6 of the shipped text says.

  **F-12's obligations do not move either way, and that is the point of stating this rather than
  guessing.** An exception can only _loosen_ the relink condition, and 6.2's three artifacts already
  meet the stricter reading — the notice, the licence texts, and a replaceable `.wasm`. So the
  design stands on the measured licence and not on the unmeasured absence of an exception, which is
  the only arrangement in which being wrong about the exception costs nothing.

- The compiled artifact is one file: `dist/occt-import-js.wasm`, 7 604 031 bytes.
- The wrapper's C++ sources are in the package; OpenCascade's are not (a `.gitmodules` reference).

### 6.2 MIT, and the three obligations that survive

The user's decision, recorded here as settled: **the repository carries an MIT licence**, and MIT is
compatible with the LGPL-2.1 dependency because LGPL's obligations attach to the library rather than
to the code that uses it. What survives is build-time, and F is where it becomes a build requirement.

> **Decision F-12: three artifacts, all checked by the packaging script rather than trusted.**

1. **A `LICENSE` file at the repository root**, MIT. There is none today **(code)** — which is a fact
   with a consequence beyond this subsystem: `package-app.ts` omits `appCopyright` _because_ of its
   absence, so `LegalCopyright` in the shipped executable currently says Electron's. Once a LICENSE
   and a copyright holder exist, that reasoning has to be re-read and the docblock rewritten (5.7).
2. **A third-party notice**, `THIRD-PARTY-NOTICES.md` at the root and staged into the packaged app,
   naming `occt-import-js@0.0.23`, its LGPL-2.1 licence, OpenCascade underneath it, and pointing at
   the three licence texts. The texts themselves ship beside it — they are 54 KB total and copying
   them is cheaper than referencing files inside a `node_modules` that the packaged app does not have.
3. **The `.wasm` ships as a replaceable file**, so §6's relink condition is met the easy way. See 6.3,
   because the mechanism is not the one the question assumed.

### 6.3 asar is already off — the mechanism, corrected

The obligation was framed as "`asarUnpack` in the Electron packaging step, verified by unpacking the
built app". **Measured against the repository: there is nothing to unpack.**

**(code)** `packages/desktop/package-app.ts` passes **`asar: false`**, with a docblock that argues for
it deliberately — the packaged app is meant to carry readable source and sourcemaps so a person can
run it and report what happened. So `resources/app` is a plain directory tree, and any `.wasm` staged
into it is already an ordinary file a user can replace. **The property the obligation wants holds
today, by a decision made for an unrelated reason.**

That is a weaker guarantee than it sounds, and the correction is to say so rather than to bank it:

> **Decision F-13: the `.wasm`'s replaceability is asserted by the packaging script's `REQUIRED`
> list, not inferred from `asar: false`. If asar is ever turned on, the `.wasm` and the licence texts
> go in `asarUnpack`, and the same assertion keeps passing.**

The same docblock says an installer "would want both of those inverted" and calls turning asar on
"two lines in this file" — so the assumption that it stays off is exactly the kind that expires
quietly. `REQUIRED` already checks ten files exist and are non-empty **(code)**, precisely because
"a packaging script that exits 0 having written half a directory is worse than one that fails". Three
entries are added to it: the `.wasm`, the notice, and the LGPL text. The check is on the built output,
which is the verification the obligation asked for.

**And two more, which is a consistency fix F carries rather than a defect it found.** `REQUIRED`
names `dist/migrations/001_init.sql` alone **(code)** (`package-app.ts:241`); `002_preview_claim.sql`
has never been in it, and 3.5 adds a third. **Decision: 002 and 003 are both added.** The list's own
docblock says the failure it exists to prevent is "one that opens and cannot open a library", and a
missing migration file is exactly that: `runMigrations` reads a frozen list and `readFileSync` throws
on the first file that is not there **(code)**, so a staging that dropped 002 produces an app that
starts and fails the moment a folder is picked. `001` alone is a spot-check that `copyMigrations` ran
at all, not that it finished — and the fact that 002 slipped through for a whole subsystem is the
evidence that a hand-maintained list drifts.

The cost of that decision, named because it is the reason someone might not take it: **the list now
has to be edited with every migration for ever**, and the next one to be forgotten will be forgotten
the same way 002 was. The durable fix is to derive the check from core's `MIGRATIONS` rather than
respell the filenames — the same "read rather than copied" rule 3.5 applies to the classification
rule — but that changes `REQUIRED` from a list of paths into something that imports from `core`, and
F is not the change that should do it. It is recorded as what to do if a fourth is ever missed.

### 6.4 Getting the parser into three build targets

**(code)** the workspace has exactly **one** npm runtime dependency, `zod`; `packages/core` has none.
`occt-import-js` is the second, and the first with a non-JavaScript artifact. `deno.json` also sets
`minimumDependencyAge: P1D`, and whether `occt-import-js@0.0.23` satisfies it on the day of the
change is **unmeasured** — it gates on publication age, and `deno install` is what reports it. That
is the developer's machine; **the pipeline is a separate question and is 10.16**, because CI runs
`deno install --allow-scripts --frozen` in eight jobs **(code)** and whether `--frozen` consults the
age gate at all has not been established.

| Target                          | How it loads                                                       | Status                                                                             |
| ------------------------------- | ------------------------------------------------------------------ | ---------------------------------------------------------------------------------- |
| **Deno server**                 | `npm:occt-import-js@0.0.23` in the import map, from `node_modules` | **Measured working** (§5.1), 10/10, `--allow-read --allow-env --allow-ffi`, no net |
| **Node (tests, `node --test`)** | `require('occt-import-js')`                                        | **Measured working** (§5.1), 10/10                                                 |
| **Electron desktop**            | esbuild-bundled into `dist/main.js`; `.wasm` staged as an asset    | **Unmeasured — the one real implementation risk**                                  |

**The desktop risk, named rather than assumed.** **(code)** `build.ts` bundles everything except
`electron` into one ESM file, and the packaged app has no `node_modules` at all. The emscripten glue
is 96 KB of emscripten glue that resolves its `.wasm` through a `locateFile` hook and touches `fs`/`path`.
Whether esbuild bundles it cleanly is **unmeasured**. The fallback, if it does not, is the ordinary
one and should be planned for rather than discovered: mark the package `external`, stage
`dist/occt-import-js.js` and `dist/occt-import-js.wasm` beside the bundle the way `copyMigrations` and
`copyIcons` already stage assets, load the glue with `createRequire`, and pass an explicit
`locateFile`. Either way the `.wasm` ends up a separate file next to the bundle, which is what 6.3
requires anyway — so the licence obligation and the likely implementation point the same direction.

No runtime flag is needed anywhere: the library is instantiated on first use, so a build that never
parses a STEP file never touches it.

### 6.5 Unmodified from npm

> **Decision F-14: the library is used exactly as published. No patch, no fork, no vendored rebuild.**

The user's reasoning, recorded: patching an LGPL library makes the patches LGPL. It is also the only
form the measurements describe — §5.1's 10/10 and §5.4's ten PNGs are results for `0.0.23` as
published — so a patched build would be an unmeasured artifact wearing a measured one's numbers. If a
change to the library is ever needed, that is a decision with its own licence consequences and it does
not get made inside an implementation task.

---

## 7. The viewer

> **Decision F-15: the interactive viewer does not open STEP in F. This adopts the spike's
> recommendation (§8c), and the interim behaviour is what the code already does.**

### 7.1 Why, in three measurements

- **The budget model cannot express STEP.** `viewer.page.ts` prices each format as `peakCost`, a
  multiplier with **no intercept**, against `PEAK_BUDGET_BYTES = 256_000_000` **(code)**. STEP's cost
  is ~87 % intercept. Both defensible readings give wrong answers in opposite directions (§6.3): take
  **201** (the worst multiplier from a file near its own line) and `limitOf` is 1.27 MB — which
  prompts on the four largest library files _and_ is still wrong, because that file's real peak of
  278 MB already exceeds the whole budget; take **25 142** — the other end of the same range, from
  the 8 KB twelve-triangle cube — and `limitOf` is **10.2 KB**, which prompts on every STEP file in
  the library including ones that parse in 217 ms, and sets a threshold below the smallest STEP file
  anyone has measured.
- **The numbers that would go in the table are the wrong engine's.** Everything in §5.3 is Node/Deno
  peak RSS. The `FORMATS` docblock is emphatic that this exact substitution produced **three wrong
  costs** — "Arithmetic misses what the loaders actually allocate" — and that `.3mf` could not be
  priced in Node at all. **Chromium's peak for a STEP parse is unmeasured** and the harness that
  produced the shipped costs (`WorkingSet64` summed across Chromium's processes) was not run.
- **The payload is not the blocker, which is worth saying so nobody re-litigates it.** 2 324 594
  bytes brotli, lazy-loadable — the glue is a factory, `FORMATS.parse` is a function property, and the
  package ships a Web Worker wrapper (§6.1, §6.2). A user who never opens a STEP file would pay
  nothing. The blocker is that nobody can currently say what one costs a tab.

### 7.2 What the user sees instead, and the two sentences that must change

**(code)** the viewer's `load` looks the extension up in `FORMATS`, and a miss sets
`status: 'unsupported'` with a message naming `SUPPORTED_FORMATS` — which is derived from `FORMATS`'
own keys, so it cannot drift. A STEP file therefore gets: **the server-rendered thumbnail everywhere
a thumbnail appears, and an honest "this viewer opens STL, OBJ, 3MF" if the user opens it.** That is
the spike's recommended interim behaviour and it needs no code.

It does need two corrections, both in `packages/web`, both of the "sentence asserting a mechanism the
code does not have" class:

- **`project-detail.page.ts`** gates the viewer link on `file.kind === 'model'` with the comment
  "Offered for model files alone, **which is exactly the set the viewer's three loaders cover**". F
  makes that false. **Decision F-16: the comment is corrected and the gate is left as it is.** Making
  the gate narrower — hiding the link for STEP — would hide the honest message the viewer already
  renders and would put the viewer's format list in a second place, which is the thing
  `SUPPORTED_FORMATS` exists to prevent. A link that leads to "this viewer opens STL, OBJ, 3MF" is a
  better answer than a control that silently is not there.
- **The thumbnail hit-target** in the same file is gated identically and follows the same decision.

### 7.3 What would reopen it

The Chromium harness, re-run for STEP, plus a decision about the budget model itself — because even
with real Chromium numbers, a multiplier with no intercept cannot price a cost that is 87 % intercept.
That is a change to `ModelFormat`, not a new row in the table. Both are 10.4.

---

## 8. Ordering

> **Decision F-17: detection and thumbnails ship in one release. If the work must be split, the
> handler lands first and the classifier bump second — never the other way round.**

This is the spike's strongest recommendation (§7c, §8b) and it is adopted unchanged. The evidence:
`unsupported` is terminal, `claimPendingPreviews` selects `pending` only, and the sole thing that
re-pends a row is a content-hash change **(code)**. The codebase has shipped this exact defect once
and documented it in two docblocks — 326 blank projects, "every one of them blank, because
`unsupported` was the only outcome available to them and nothing re-queues a row whose bytes have not
changed".

**3.4 sharpens the rule rather than softening it.** Because `rescan` short-circuits on a stat match,
the thing that would blank the existing ten files is not `classifyFile` changing — it is
`CLASSIFIER_VERSION` being bumped. So the ordering constraint is precisely:

**The commit that bumps `CLASSIFIER_VERSION` must not land before the commit that adds the `readMesh`
arm.** A `.step` file left at `kind: 'other'` is invisible to the queue and leaves no terminal row; a
`.step` file promoted to `model` with no handler behind it is blanked for ever, and with no second
handler in the chain to fall through to.

Within that constraint the natural order is:

1. `parseStepFile` + `mesh-handler.ts` arm + the docblock corrections in 5.7 + tests. Inert: nothing
   classifies as a model yet, so nothing reaches it.
2. `MeshLimits.maxStepBytes`, `DEFAULT_MAX_STEP_BYTES`, `SPM_MAX_STEP_MB` and the desktop constant
   (5.6).
3. `classifyFile` + `CLASSIFIER_VERSION = 1` + migration 003 (`DEFAULT 0`) + **all four** `rescan`
   edits (3.5). This is the commit that makes the feature visible, and after it the existing ten
   files reclassify and render. **It is one commit and not four:** the migration without the write
   sites leaves every row permanently stale, and the write sites without the migration have no column
   to write into.
4. The registry field and its docblock, the Cura refusal, and the widened spawn seam with its `cwd`
   (4.5 is independent of all of the above and could equally go first — it is a fix, not a feature).
5. LICENSE, the notice, and the `REQUIRED` entries — the three new ones and the two missing
   migrations (6.3).
6. The `packages/web` comment corrections (7.2).

---

## 9. Testing

What the seams already buy, and the assertions that would have caught the defects this document
found.

- **The parser and the adapter, under `node --test` against real files.** The spike's harness is the
  shape: ten files in, triangle counts and bounding boxes out. At least one file should be pinned by
  its triangle count, because that is the number that changes if the library is ever swapped or
  patched — which 6.5 forbids and this would detect.
- **The magic-byte guard** (3.2): a file named `.stp` whose first bytes are not `ISO-10303-21;`
  produces `AppError('Validation', …)` and therefore a `failed` row with a message — asserted as
  `failed`, not merely as "throws", because the whole point is which row it leaves.
- **The size ceiling** (5.6): asserted at the boundary, and asserted to refuse **before** reading the
  file. A test that only checks the error would pass an implementation that reads 40 MB into memory
  and then complains.
- **The `unsupported` trap, directly.** A `.step` file through the real `PREVIEW_HANDLERS` chain ends
  `ready`, not `unsupported`. This is the assertion whose absence cost 326 projects.
- **Reclassification** (3.4): a file inserted at `kind: 'other'` with an old `classified_by`,
  rescanned **with its size and mtime untouched**, comes back `model` with a re-pended preview row.
  The "untouched" is the whole test — a fixture that rewrites the file passes against the broken
  behaviour.
- **The version mechanism itself** (3.5), which C1 and C2 say is where this feature is silently
  defeated. Five assertions, and each of them fails against a specific plausible implementation:
  - **The migration's default.** A database opened at `user_version = 2` with `files` rows in it,
    migrated, has `classified_by = 0` on every row, and `0 < CLASSIFIER_VERSION`. **The second half
    is the assertion**, not the first: a migration that backfilled the shipping constant would leave
    the first half true, nothing stale, and the feature absent with no other symptom.
  - **All three write sites** (the table in 3.5). After a first-sight insert, after a stat-mismatch
    update, and after a version-mismatch reclassify, the row's `classified_by` equals
    `CLASSIFIER_VERSION`. Three assertions rather than one, because leaving any single site alone is
    invisible until the next rescan.
  - **Idempotence, which is what makes the missed site visible.** Rescan twice with nothing touched
    on disk; the second pass reclassifies nothing and queues no previews. This is the assertion that
    would catch a row permanently stale — reclassified every tick for ever, 402 zip reads a tick
    rather than a version bump — and it is the one a "does it reclassify?" test suite would omit.
  - **Same kind, no re-pend.** A file whose reclassification returns the kind it already had gets its
    `classified_by` written and its `ready` preview row left untouched, PNG and all.
  - **The `insertPreview` fallback.** A version-stale file whose preview row has been deleted,
    reclassified to a new kind, ends with a `pending` preview row — not with nothing, which is what a
    bare `resetPreview` produces.
- **A forgotten `CLASSIFIER_VERSION` bump after a `classify.ts` edit**, which is the maintenance
  failure the whole mechanism depends on nobody committing. A frozen snapshot test in the classifier's
  own suite: one table pairing `CLASSIFIER_VERSION` with `classifyFile`'s answer for every extension
  the module branches on, asserted whole. Changing what any extension classifies as breaks it, and
  the only edit that repairs it is one that touches the constant in the same commit. **What it cannot
  catch, said so nobody trusts it further than it goes:** a change inside `classify3mf` that produces
  the same answers on the fixture set — the snapshot pins the function's answers, not its reasoning,
  and F has no measurement that says which internal changes warrant a bump.
- **The Cura refusal** (4.2): `AppError('Validation')` with `slicerId: 'cura'`, no spawn recorded.
  The existing spawn recorder makes this a no-slicer test.
- **The `cwd`** (4.5): the recorder's signature widens with `SpawnSlicer` itself, so it captures the
  options object, and the assertion names the expected directory for **both** paths — the launch
  directory, and the scratch directory for the two in-place paths. The in-place assertion is the one
  that matters: a `cwd` left `undefined` there is the shipped defect with a type annotation over it,
  and it is also the case that would have shipped had the fallback stayed `sessionsDir`, where the
  directory does not exist on a fresh profile. A test that asserts the scratch directory **exists at
  spawn time** is the half that catches that.
- **The launch path for a `.step`** (4.4): the exact path spawned is inside the launch directory —
  asserted the way D's `.3mf` case is, "rather than trusting this paragraph", because it is the
  assertion that would notice somebody moving STEP onto the in-place branch without the measurement
  in 10.1.
- **Packaging** (6.3): the `REQUIRED` list is the test, and it runs on the built output.

**What cannot be tested here.** The memory floor. There is no assertion a test suite can make about
peak RSS that is not flaky across machines, and a test that measured it would be re-measuring the
spike rather than pinning a behaviour. The floor is governed by the ceiling in 5.6 and by the
docblocks in 5.7, and it is watched by 10.2 rather than by CI.

---

## 10. Open questions

Answered where the evidence allows; marked unmeasured with the cost of settling it where it does not.

1. **What does Ctrl+S propose in each slicer's GUI for a STEP input?** **Unmeasured, and it is the
   question that decides 4.4** (§3b, §11.1). The probe could not deliver a keystroke — the whole
   session's `GetForegroundWindow()` returned `0`, the screensaver workaround that cleared the same
   wall on 2026-08-28 was applied and did not help, and the cause remains undiagnosed. F ships the
   conservative branch, which is also the status quo. _To settle:_ the D-spike §13 probe, re-run with
   a `.step` loaded in each of PrusaSlicer, Bambu, Orca and Anycubic, reading the proposed path out
   of the Save dialog. If all four propose a name that is not the source's, STEP joins the no-copy
   branch and it is a one-line change.
2. **What does a STEP file much larger than 1.39 MB cost, and does it fail gracefully?**
   **Unmeasured** (§5.3, §11.5), and it is the single biggest gap in the memory story. The intercept
   dominates the measured range so completely that the slope "could be off by an order of magnitude
   in either direction and this data would not notice". 5.6's 10 MB ceiling is a guard against this
   ignorance and is not a substitute for closing it. _To settle:_ obtain or generate STEP files at
   5, 20 and 50 MB, run §5.3's harness, and record whether the process degrades or dies. This also
   settles whether 10 MB is the right number, and it is the measurement F would most like to have.
3. **What does a process that does both a large mesh and a STEP parse peak at?** **Unmeasured**
   (5.4). The 400–410 MB backfill figure and the 244 MB STEP figure come from processes that each did
   one thing. They are not additive and they are not independent. _To settle:_ run the existing
   backfill harness over a library that contains STEP files and read the peak. Cheap, and it is the
   number that would tell an operator whether the 500 MB NAS budget still holds.
4. **What does a STEP parse cost a Chromium tab?** **Unmeasured** (§6.3, §11.4), and it is the
   prerequisite for 7. The `FORMATS` docblock records three costs that were wrong for exactly the
   substitution that would be made without it. Beyond the number there is a modelling question the
   harness cannot answer: `peakCost` has no intercept and STEP is almost all intercept, so `ModelFormat`
   itself would have to change. _To settle:_ the `WorkingSet64`-summed-across-Chromium harness that
   produced the shipped costs, run for STEP; then a decision about the model.
5. **macOS and Linux.** **Unmeasured, entirely** (§11.9), as they were for D and E. Everything
   platform-shaped in this document is Windows: which slicers exist and where, the `cwd` incident,
   the packaging layout, and the memory figures (`maxRSS` maps to `PeakWorkingSetSize` on Windows and
   to a different quantity elsewhere). _To settle:_ a machine of each and a spike of this shape.
6. **Should the STEP parse move off the queue's thread?** **Designed against, not settled** (5.5). A
   worker thread would keep the Electron main process responsive during a measured 217–1 307 ms
   synchronous parse and would not reduce the memory; a child process would isolate the floor and pay
   it per file, which §8d argues against. F ships neither. _To settle:_ whether it matters is a
   question about perceived jank that only the built app can answer — and if 10.2 comes back badly,
   the child-process option changes from "wasteful" to "the only way to contain a blast radius", so
   these two questions move together.
7. **Should conversion happen once at import time rather than per preview?** **Not prototyped**
   (§5.7). The floor is paid per process and amortises across files, so a batch converter is far
   cheaper than per-file work, and it would move the whole-file read out of the hot path. What it
   costs is a second artifact per STEP file to store, invalidate and collect — and the queue already
   has a content-hash invalidation mechanism it would reuse. F does not take it because ten files do
   not justify a storage design. _To settle:_ it becomes worth designing if 10.2 shows large files are
   affordable and slow, or if a user's library turns out to be mostly STEP.
8. **Is `occt-import-js` the right library, and is there a non-OCCT option?** **Searched, not found,
   and the search was not exhaustive** (§5.7). The difficulty is structural: reading STEP means
   parsing the EXPRESS entity graph _and_ implementing NURBS trimming and tessellation, which is a CAD
   kernel. Every JS/WASM STEP reader the ecosystem uses is an OpenCascade build, so the LGPL question
   is not avoided by switching packages within the family. Whether a pure-JS kernel exists at all is
   **unmeasured**.
9. **Should the desktop shell shell out to an installed slicer instead?** **Answered: no, and the
   reason is the server** (§5.7). `prusa-slicer-console.exe --export-3mf` converted all ten files,
   exit 0, 316–1 593 ms, no window, no new dependency and no licence question — measured, and the
   cheapest thing in the spike. It is a strong fit for the desktop and a poor one for the server on a
   NAS with no slicer installed, and this project ships both. Two thumbnail pipelines producing
   different pictures on different deployments is a worse property than 243 MB. Recorded because it is
   the obvious question and the answer is not obvious.
10. **Does esbuild bundle the emscripten glue for the Electron main process?** **Unmeasured** (6.4),
    and the one implementation risk that could turn a small task into a large one. The fallback is
    known and is 6.3's requirement anyway. _To settle:_ run `deno task build:desktop` with the import
    in place, which is the first thing the implementation will do.
11. **Does `LegalCopyright` change once a LICENSE exists?** **A decision, not a measurement** (6.2).
    `package-app.ts` omits `appCopyright` today _because_ there is no LICENSE and no author, and it
    argues that leaving Electron's notice is a true statement about the compiled code. With MIT and a
    named holder, that argument no longer applies unchanged, and the docblock must be rewritten either
    way — either to state a copyright line or to state a better reason for not having one.
12. **Is 10 MB the right ceiling?** **A judgement standing on a barely-constrained slope** (5.6),
    labelled as one. It is 7.2x the largest file in the reference library and the point at which the
    fitted model exhausts the server's whole budget. Real CAD exports reach tens of megabytes, so the
    first user with a 30 MB assembly is the measurement. _To settle:_ folded into 10.2; the constant
    is in one place and moves with the evidence. Note that raising it is **forward-only** (5.6): the
    rows the current number condemns are `failed` and terminal, and only a change to a file's bytes
    brings one back.
13. **Does a slicer saving from a STEP input write into a subdirectory?** **Unmeasured, and it
    decides whether 4.4's launch-directory flow actually closes** (4.4, 4.5). `#scan` reads one level
    and files only **(code)** (`sessions.ts:717-718`), so a project saved into `<launch dir>/foo/` is
    invisible to the session list — the user is never asked about it and reconcile never sees it. The
    one data point in this project is Anycubic's measured `stl/obj_1_….stl`, which is exactly that
    shape, and it was produced by an export flag rather than by a save. _To settle:_ the same probe as
    10.1 — a `.step` loaded in each of the four STEP-capable slicers, Ctrl+S, and the _directory_ of
    the proposed path read as well as its name. The two questions are one probe and should be run
    together. If any slicer nests, the fix is a decision about `#scan`'s depth and belongs to D, not
    to a `.step` special case.
14. **What happens if the user quits while the main process is mid-STEP-parse?** **Unmeasured**
    (5.5). The parse is synchronous on the Electron main thread, so `will-quit` cannot be dispatched
    while it runs: the window stays up for the remainder of a measured 217–1 307 ms, and whether
    Windows paints "not responding" in that window is exactly what nobody has watched. What happens
    _after_ it returns is read rather than guessed **(code)**: `will-quit` calls
    `shellHost.shutdown()`, which does `void current.ticker.stop()` — **not awaited** — and closes the
    library immediately (`library.ts:690-698`), and the docblock above it already measures the
    consequence for a kill mid-render: the row stays `pending` with a live lease, one attempt charged,
    invisible for `PREVIEW_LEASE_MS`, and three of those retire it until the file's bytes change. So
    the failure mode is understood and shared with every other handler; what is new is only that STEP
    holds the thread through it. _To settle:_ quit the built app during a STEP parse and watch the
    window. It is the same "only the built app can answer this" shape as 10.6 and moves with it.
15. **What does a `spm://` thumbnail request do during the 1.3 s block?** **Unmeasured** (5.5). 5.5
    names the block and asks only whether it is _perceptible_; the sharper question is what the
    protocol handler does when it is asked for a PNG on the thread OCCT is holding. The handler runs
    in the same process on the same thread as the queue **(code)** — `previews.ts`'s own
    `PREVIEW_CONCURRENCY` docblock says so, in the sentence about "Electron's browser process, the IPC
    dispatch table and the `spm://` handler that serves the very thumbnails this produces, all on the
    same thread". The likely answer is that the request simply waits, since it is a queued task and
    not a timed one, and **likely is not measured**: whether Chromium's own request path has a timeout
    shorter than a worst-case parse, and therefore whether a grid of tiles goes blank rather than
    slow, is unknown. It is also the shape most affected by 10.6 — a worker thread fixes this one
    outright. _To settle:_ scroll a grid of thumbnails in the built app while a STEP file is parsing,
    and read the console for failed `spm://` responses.
16. **Does `minimumDependencyAge` interact with CI as well as with the developer's machine?**
    **Unmeasured** (6.4). 6.4 flags the `P1D` window for the install that adds the dependency; the
    unasked half is the pipeline. **(code)** `.github/workflows/ci.yml` runs
    `deno install --allow-scripts --frozen` in **eight** jobs, and `--frozen` is the interesting word:
    whether Deno evaluates the age gate at all when the lockfile is authoritative, or whether a
    dependency added on its publication day fails every job simultaneously, is not something this
    repository has been in a position to find out. `occt-import-js@0.0.23` is long-published, so the
    likely answer is that nothing happens — which is why this is a question and not a risk. What makes
    it worth recording is that the failure, if it exists, is eight red jobs with one cause and no
    obvious relation to the change. _To settle:_ observe the first CI run after the dependency lands.
    Free, and it happens anyway. The `exclude` list in `deno.json` takes package names and not
    versions **(code)**, so the remedy if it does bite is known and is a one-line entry.
