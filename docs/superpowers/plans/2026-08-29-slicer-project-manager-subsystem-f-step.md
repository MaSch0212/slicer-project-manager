# Slicer Project Manager — Subsystem F: STEP file support

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to
> implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** make `.step` and `.stp` first-class model files — classified as `kind: 'model'` so a slicer
can be handed one, and given rasterized thumbnails through `occt-import-js` — and do it without
blanking the ten STEP files the user already has, which is the failure mode this subsystem is mostly
about.

**Architecture:** one new parser in `packages/core` (`previews/mesh/step.ts`), one arm on
`readMesh`, one file ceiling threaded through the `MeshLimits` object that already reaches every
parser, one column and one constant that make `rescan` reclassify a file whose bytes have not
changed, and one migration. In `packages/desktop`: one measured registry field, one refusal before
the spawn, a `SpawnSlicer` seam widened to carry an explicit `cwd`, the scratch directory that `cwd`
points at, and the packaging list. In `packages/server`: one environment variable. In
`packages/web`: **one comment and no behaviour.** At the repository root: a `LICENSE` and a
third-party notice, which this repository has never had.

**Spec:**
[`2026-08-29-slicer-project-manager-subsystem-f-step.md`](../specs/2026-08-29-slicer-project-manager-subsystem-f-step.md)
— references of the form "spec 3.4" and "F-3" are to it, and it is binding. **Where this plan and
the spec disagree, the spec wins and this plan is wrong.** Six places where this plan extends,
places differently, or reads against the spec are called out as such, and nowhere else:

| Deviation                                                                  | Where       | Kind                                                                      |
| -------------------------------------------------------------------------- | ----------- | ------------------------------------------------------------------------- |
| The `rescan` SELECT gains `kind` as well as `classified_by`                | decision 2  | Extends. The branch cannot be written as specified without it             |
| `parseStepFile` returns `Promise<Mesh>`, so every decline is a throw       | decision 3  | Extends. The spec fixes the signature and leaves two declines unstated    |
| `assertStepFileFits` lives in `limits.ts`, not in `step.ts`                | decision 6  | Placement. Identical behaviour                                            |
| `classify.ts` gains an exported `MODEL_EXTENSIONS` the snapshot enumerates | decision 15 | Extends. Spec §9 asks for "every extension the module branches on"        |
| The `packages/web` comment correction lands in task 4, not as a sixth step | task 4      | Placement. Spec §8's step 6; constraint 14 requires the falsifying commit |
| **One** comment in `packages/web` is corrected, not two                    | task 4      | Reads against the spec's count, with the code quoted. See task 4          |

Its parent,
[`2026-08-22-slicer-project-manager-design.md`](../specs/2026-08-22-slicer-project-manager-design.md),
is binding above both — except at spec 1.3, where three parent statements are corrected in place
against measurements.

**Measurements:** `.superpowers/spikes/2026-08-29-step-facts.md`, run 2026-08-29 10:44–11:15 on one
Windows 11 machine against the five installed slicers, the ten STEP files in the reference library
and `occt-import-js@0.0.23`. References of the form "(§5.3)" are to that document. Prior art from
`.superpowers/spikes/2026-08-28-slicer-launch-facts.md` is cited as "(D-spike §13)".

**Prior plans:** [A](2026-08-22-slicer-project-manager-subsystem-a.md),
[B1](2026-08-23-slicer-project-manager-subsystem-b1-rasterizer.md),
[B1 follow-ups](2026-08-24-slicer-project-manager-b1-followups.md),
[B2](2026-08-25-slicer-project-manager-subsystem-b2-viewer.md),
[C](2026-08-26-slicer-project-manager-subsystem-c-electron.md),
[D](2026-08-28-slicer-project-manager-subsystem-d-slicers.md),
[E](2026-08-28-slicer-project-manager-subsystem-e-model-browser.md).

---

## What was measured before this plan was written

Every row was run and observed on one machine in one session, or — where marked **(code)** — read out
of this repository. **A task that contradicts one of these is wrong.** The spec's §2 has 51 rows;
these are the ones a task can actually contradict.

| Question                                                      | Measured                                                                                                                         |
| ------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| Does extension alone classify a STEP file correctly?          | **Yes. Zero mismatches in both directions over all 2 946 files.** All ten STEP-extension files begin `ISO-10303-21;` at offset 0 |
| Does PrusaSlicer / Bambu / Orca / Anycubic open STEP?         | **Yes, all four.** Exit 0 and a real 3MF out of PrusaSlicer; import dialogs reporting 49 138 facets in Bambu and Orca            |
| Does Cura?                                                    | **No, and silently.** Title stays `Untitled`, no dialog, log says `Unsupported Mime Type Database file extension` 7 ms later     |
| Is that a real negative?                                      | **Yes.** Same install, same session, `cone.stl` → title `cone - UltiMaker Cura 5.13.0`                                           |
| Has the user already hit it?                                  | **Yes.** Cura's log carries `Nozzle Wiper Guard.STEP`, dropped nine minutes before the spike started                             |
| Does `.stp` work as well as `.step`?                          | **Yes, on all four that read STEP at all**, across six `.step` and four `.stp` files                                             |
| Does `occt-import-js` run on Node **and** Deno?               | **Yes.** 10/10 `success: true` on both, identical triangle counts, instantiation 19–26 ms                                        |
| Can its output feed the repo's `renderMesh` unchanged?        | **Yes.** A ~24-line adapter, the repo's own unmodified rasterizer, **ten of ten valid 256×256 PNGs**, adapt cost 0.6–3.3 ms      |
| What does a STEP parse cost in memory?                        | **207–278 MB peak RSS**, including an 8 KB twelve-triangle cube at **207 MB**                                                    |
| Is that proportional to file size?                            | **No.** ~243 MB intercept plus ~25 bytes per input byte. The intercept is **87 %** of the largest measured peak                  |
| Is the cost per file or per process?                          | **Per process.** `maxRSS` flat at 243 990 528 across all ten files and a second full pass; no leak; warm parses ~30 % faster     |
| Does `DEFAULT_MAX_MESH_BYTES` bound it?                       | **No.** The largest `positions` array in the whole sample is **796 932 bytes**. The mesh is not what costs anything              |
| Can the parser stream?                                        | **No.** All four entry points are whole-buffer; the file is resident **twice** at the moment of the call                         |
| How long does a parse take?                                   | **217–1 307 ms** cold, ~30 % less warm, synchronous, returning its result directly                                               |
| What does a STEP file larger than 1.39 MB cost?               | **Unmeasured.** No such file exists in this library                                                                              |
| What does Ctrl+S propose in each GUI?                         | **Unmeasured.** `GetForegroundWindow()` returned 0 all session; every keystroke aborted                                          |
| Does any slicer write outside the input's directory?          | **Yes — Anycubic wrote `stl/obj_1_….stl` into the calling process's cwd**, which was this repository                             |
| Does the spawn set a working directory?                       | **No.** `spawn(command, args, { detached: true, stdio: 'ignore' })` **(code)** `app.ts:1175`                                     |
| Does the `SpawnSlicer` seam take an options object?           | **No.** `(command, args) => SpawnedSlicer`, `launch.ts:198` **(code)**                                                           |
| Is `sessionsDir` there when an in-place launch spawns?        | **Not necessarily.** "Created lazily, only by a launch that needs a directory", `launch.ts:201-202` **(code)**                   |
| Does `rescan` reclassify a file whose bytes have not changed? | **No.** A stat match short-circuits at `:192-193`, **before** `classifyFile` at `:197` **(code)**                                |
| Is `unsupported` terminal?                                    | **Yes.** `claimPendingPreviews` selects `state = 'pending'` only; the sole thing that re-pends is a content-hash change          |
| Has this codebase shipped that defect before?                 | **Yes — 326 blank projects**, recorded in two docblocks **(code)**                                                               |
| What licence is the parser?                                   | **LGPL-2.1**, no npm dependencies, one 7 604 031-byte WASM blob, three licence texts in the package                              |
| Does the packaged app use an asar archive?                    | **No.** `package-app.ts` passes `asar: false`, with a docblock arguing for it **(code)**                                         |
| Does the packaging `REQUIRED` list name every migration?      | **No. `001_init.sql` alone** (`package-app.ts:241`); 002 has never been in it **(code)**                                         |
| Does `MeshLimits` already reach every parser?                 | **Yes, whole.** `makePreviewHandlers` → `makeMeshHandler` → `readMesh`, from both call sites **(code)**                          |
| Does esbuild bundle the emscripten glue for Electron?         | **Unmeasured.** The one implementation risk that could turn a small task into a large one                                        |

**Four rows carry the whole subsystem and are repeated as global constraints 8, 10, 11 and 12**,
because a reviewer sees only the diff, the task text and those constraints.

---

## Scope

| In this plan                                                                       | Not in this plan                                     |
| ---------------------------------------------------------------------------------- | ---------------------------------------------------- |
| `.step` / `.stp` → `kind: 'model'`, and the version mechanism that applies it      | Any other STEP extension — `.p21`, `.stpz`, `.stpnc` |
| `parseStepFile`, the `readMesh` arm, and the nine docblocks that stop being true   | IGES and BREP, which the same library also exposes   |
| `DEFAULT_MAX_STEP_BYTES`, `MeshLimits.maxStepBytes`, `SPM_MAX_STEP_MB`             | The interactive browser viewer (spec 7)              |
| `classified_by`, `CLASSIFIER_VERSION`, migration 003, four `rescan` edits          | Converting STEP to a stored mesh at import time      |
| `behaviour.opensStep`, the Cura refusal, the widened spawn seam and its `cwd`      | A worker thread or a child process for the parse     |
| `LICENSE`, `THIRD-PARTY-NOTICES.md`, three new `REQUIRED` entries, and 002 and 003 | Matching a slicer's tessellation density             |
| One comment correction in `packages/web`                                           | macOS and Linux                                      |

**Deliberately deferred, with reasons the spec argues in full:**

- **The interactive viewer** (spec 7). Not because it is hard: because nobody has measured what a
  STEP parse costs a Chromium tab, and `ModelFormat.peakCost` is a multiplier with no intercept
  against a cost that is 87 % intercept. Both defensible readings give wrong answers in opposite
  directions — 1.27 MB or 10.2 KB for the same `limitOf`. The interim behaviour is what the code
  already does: a thumbnail everywhere a thumbnail appears, and an honest "this viewer opens STL,
  OBJ, 3MF" if the user clicks through. Task 4 makes the one comment that describes it true again.
- **The in-place launch branch for STEP** (spec 4.4, F-6). The measurement that would decide it —
  what Ctrl+S proposes in each of the four STEP-capable GUIs — does not exist, and the last time
  that substitution was made it produced a Critical data-loss defect in D. STEP stays on the
  copy-into-a-launch-directory branch, which is what the code already does, so it ships by changing
  nothing.
- **A worker thread or a child process for the parse** (spec 5.5, F-10). A worker thread shares the
  address space, so it would not reduce the floor; a child process would isolate it and pay it **per
  file**, which the per-process finding argues against. Both become worth reconsidering if open
  question 2 comes back badly, and neither is built here.
- **macOS and Linux.** Every measurement behind this plan is Windows 11 — which slicers exist and
  where, the `cwd` incident, the packaging layout, and the memory figures. D and E shipped under the
  same limitation and said so.

---

## Global constraints

A reviewer should treat a violation as a defect regardless of what a task says. 1–7 are carried from
the C, D and E plans and still bind; 8–16 are F's own, and 8, 10, 11 and 12 are the four the whole
subsystem rests on.

1. **The renderer is the existing Angular app, unmodified except at the named seams.** F's entire
   `packages/web` diff is **one comment** (spec 7.2, and see task 4 for why the spec's prose says
   two and the code has one). No route, no DTO field, no capability, no component. A behavioural
   change under `packages/web` in this subsystem is a defect.
2. **The main process is the only thing that touches the filesystem, the database or a subprocess.**
   `nodeIntegration: false`, `contextIsolation: true`, `sandbox: true` stay as they are, and the
   renderer never names a filesystem location.
3. **Errors keep their identity across the boundary.** `AppError.code` survives; a refusal arrives as
   an `AppError` the UI can switch on. Both of F's new refusals — the Cura one and the size ceiling —
   are `AppError('Validation', …)` with details the UI could read.
4. **`deno task verify` stays green**, and every package typechecks at the end of every task. Adding
   a field to `MeshLimits` or a parameter to `SpawnSlicer` is not done until `typecheck:core`,
   `typecheck:server` and `typecheck:desktop` are all green.
5. **Every assertion must be able to fail** — break the code it covers, confirm red, restore. Assert
   the path and the `cwd` that were spawned, not that a spawn happened; assert the row a handler
   leaves, not that it threw.
6. **The app never writes into the user's library folder as a side effect of launching a slicer.**
   Launch artefacts live under `<userData>`. F adds a second directory there and no write anywhere
   else.
7. **The next-start sweep surfaces and never deletes.** Nothing is deleted that the app has not
   compared and the user has not seen.
8. **Detection and thumbnails ship together, and the commit that first contains `CLASSIFIER_VERSION`
   must not be an ancestor of the commit that adds `case '.step':` to `readMesh`.** (F-17.) This is
   checkable from `git log` alone and it is not advisory: `unsupported` is terminal,
   `claimPendingPreviews` selects `pending` only, and the sole thing that re-pends a row is a
   content-hash change. A `.step` left at `kind: 'other'` is invisible to the queue and leaves no
   terminal row; a `.step` promoted to `model` with no handler behind it is blanked for ever, with no
   second handler in the chain to fall through to. This codebase has shipped that defect once — 326
   blank projects — and documented it in two docblocks.
9. **The library ships unmodified from npm** (F-14). `occt-import-js@0.0.23`, pinned exactly, no
   patch, no fork, no vendored rebuild, no postinstall step that edits it. Patching an LGPL library
   makes the patches LGPL, and a patched build would also be an unmeasured artifact wearing a
   measured one's numbers — every result in §5.1 and §5.4 is for 0.0.23 as published.
10. **Every write that sets `kind` also writes `CLASSIFIER_VERSION`.** There are four such sites after
    task 4 — the first-sight `INSERT`, the stat-mismatch `UPDATE`, the new version-mismatch
    `UPDATE`, and no other. Leave any one alone and its rows are permanently stale: reclassified on
    every rescan for ever, which turns 402 zip reads from a cost per version bump into a cost per
    **tick**.
11. **The migration's backfill is strictly below the shipping constant.** `DEFAULT 0` in
    `003_classifier_version.sql`, `CLASSIFIER_VERSION = 1` in `classify.ts`. A migration that
    backfilled the shipping constant would leave nothing stale, reclassify nothing, and the feature
    would simply be absent — the migration succeeds, the rescan succeeds, and there is no symptom.
    **The assertion that catches this is `0 < CLASSIFIER_VERSION`, never `CLASSIFIER_VERSION === 1`**
    — a test pinned to today's value goes red on the next legitimate bump and teaches whoever bumps
    it to edit the test.
12. **Every spawn sets an explicit `cwd`, and that directory exists at the moment of the spawn.**
    (F-7.) Not an optional field on an options bag: a `cwd` that can be omitted is a `cwd` that will
    be. The in-place case is the one that matters — it is the case an implementer is most likely to
    leave defaulting to `undefined`, which is silently the shipped defect again, and it is the case
    where `sessionsDir` would have been an `ENOENT` on a fresh profile.
13. **The STEP arm never returns `null`.** `null` from a handler is a message-less `unsupported` and
    `unsupported` is terminal. Every way `parseStepFile` can decline — a bad magic header, a file over
    the ceiling, an OCCT failure, an empty tessellation — throws `AppError('Validation', …)`, so the
    row is `failed` **with a message somebody can read**. `readMesh`'s `default:` arm keeps returning
    `null`, and that is the only `null` in the chain.
14. **No docblock or document is left asserting a mechanism the code no longer has.** This project's
    signature defect. Each is named in the task that falsifies it and lands **in that task's
    commit**, not as a follow-up. **The list is a floor and not a boundary**: spec 5.7's seven
    docblocks, spec 7.2's one comment (see task 4), and **five more that no spec section lists** —
    `desktop/src/previews.ts:74` and `server/src/env.ts:160` (task 2), and `README.md:36`, `:37` and
    the whole **Preview memory** section (task 2). Four of those five were found by sweeping for the
    claim rather than by reading the list, which is the method the last one will be found by too:
    **grep the repository for `stream`, `never holds`, `not a function of the file`, `one budget` and
    `256 MB` before calling any task done**, and correct whatever that turns up in the commit that
    falsified it.
15. **Nothing is deleted.** No task deletes a launch directory it did not create; nothing sweeps
    `<userData>/slicer-cwd/` and no document says anything does; migration 003 adds a column and
    touches no row's existing values; and `land`-style implicit cleanup does not appear anywhere in
    F.
16. **`assertMeshFits` cannot bound the STEP floor, and nothing in F may be written as though it
    does.** The triangle count does not exist until OCCT has already tessellated, so there is no
    counting-pass-before-allocation on this arm and `DEFAULT_MAX_MESH_BYTES` bounds only the
    adapter's own `positions` array — 796 932 bytes at the sample's worst, against a 243 MB floor.
    The single most misleading available inference in this subsystem is that the mesh ceiling
    protects the process, and a docblock, a README line or an error message that implies it is a
    defect.

---

## Decisions taken up front

These are plan-level choices, not spec decisions. Without them three tasks would make them three
different ways.

1. **The migration is `packages/core/src/db/migrations/003_classifier_version.sql`, and
   `MIGRATIONS` in `migrate.ts` gains `{ version: 3, file: '003_classifier_version.sql' }`.**
   `runMigrations` reads a frozen list, so the file alone does nothing. The name says what the column
   is for rather than what it is called, matching `002_preview_claim.sql`.
2. **The `existing` SELECT in `rescan` gains _two_ columns — `classified_by` and `kind`.**
   **This extends the spec.** Spec 3.5's table names `classified_by` alone, with the reason "there is
   nothing to compare against otherwise". The same sentence's logic applies to `kind`: F-3 says the
   preview row is re-pended "if and only if the kind actually changed", and the old kind is not in
   the row the loop is holding. The branch cannot be written as specified without it. _Rejected:_ a
   second `SELECT kind FROM files WHERE id = ?` inside the loop, which is one query per stale file
   for a column the outer query is already reading; and re-pending unconditionally, which would
   re-render 1 311 STLs on a version bump made for a `.step` change and which F-3 explicitly refuses.
3. **`parseStepFile` returns `Promise<Mesh>` and never `Promise<Mesh | null>`, so every decline is a
   throw.** **This extends the spec.** F-8 fixes the signature; F-2 fixes the magic-byte refusal as
   an `AppError`; the spec does not say what happens when OCCT answers `success: false` or tessellates
   to zero triangles. The signature settles it — there is no `null` to return — and F-2's argument
   settles which way it should have gone anyway: a throw is `failed` with a message, `null` is a blank
   terminal row nobody can diagnose. The spike's own adapter sketch returns `null` in both cases; it
   is a scratchpad script, not a handler, and this is the one place this plan deliberately does not
   copy it.
4. **The OCCT module is instantiated once per process, memoised in a module-level promise, and the
   memo is cleared if instantiation rejects.** Instantiation is 19–26 ms and +24 MB, warm parses are
   ~30 % faster, and the 243 MB floor is per process and arrives with the first parse — so a second
   instantiation buys nothing and a per-call one pays 26 ms per thumbnail. Clearing on rejection
   matters because a cached rejected promise would wedge the STEP arm for the life of the process,
   turning one bad start into every STEP file `failed`.
   **The memo is a closure over an injected factory, not a module-level `let`**, and that is part of
   the shape rather than a testing convenience: `makeOcctLoader(factory)` returns the memoising
   loader, and `step.ts` holds exactly one of them (`const loadOcct = makeOcctLoader(occtimportjs)`).
   A module-level `let occtPromise` offers no seam to count instantiations against and — worse — no
   way back: `node --test` and `deno test` share one process across a file, so the first test that
   resolves the memo makes the rejection case unreachable for every test after it, and the rejection
   case is the half that matters. With a factory-taking constructor each test builds its own loader,
   the call count is the fake factory's own, and no test depends on the order of any other.
5. **The Cura refusal sits immediately after `chooseSlicer` and before the install lookup.**
   `open()`'s docblock already states the rule — everything that can refuse cheaply runs before
   anything is written or downloaded — and this is the first point at which both the product and the
   file's extension are known. Before the install lookup, so a STEP file aimed at Cura says "Cura
   cannot read STEP" whether or not Cura is bound to an install, which is the more useful of the two
   messages. _Consequence, stated rather than discovered:_ an `as-is` launch of a STEP file into Cura
   now gets this message instead of `refuseNotAProject`'s. Both are `Validation`, neither spawns, and
   the UI does not offer `as-is` for a `model` file, so the only way to reach the difference is a
   hand-made IPC call.
6. **The size-ceiling check is a function in `limits.ts`, `assertStepFileFits(sizeBytes, limits)`,
   called by `parseStepFile` before the read.** **This is a placement difference from the spec.**
   Spec 5.6's table puts the `limits?.maxStepBytes ?? DEFAULT_MAX_STEP_BYTES` in `step.ts`; the
   behaviour is identical either way, and this placement keeps the check beside the constant it reads
   and reuses `megabytes()`, which is a private function in `limits.ts` and would otherwise be
   respelled. It also puts `assertStepFileFits` next to `assertMeshFits`, which is where spec 5.6's
   warning — "`assertMeshFits` does not read `maxStepBytes`; a ceiling with one reader in a shared
   options type is worth naming so nobody adds a second reader by analogy" — is actually readable.
7. **`dist/occt-import-js.wasm` ends up as a plain file beside the desktop bundle in _both_ branches
   of the esbuild question.** The `.wasm` is fetched by the glue at call time and is never bundled
   into JavaScript by anything, so it has to be staged whatever esbuild does with the 96 KB of glue.
   That means F-13's `REQUIRED` entry is the same in both branches and task 5 does not depend on how
   task 1's measurement came out.
8. **The scratch directory is `SLICER_CWD_DIR = 'slicer-cwd'`, a constant in `launch.ts` beside
   `SLICER_SESSIONS_DIR` (`:90`), and `SlicerLauncherOptions` gains `scratchCwdDir: string`.**
   `app.ts` joins it to `userData` at `:1156` alongside `sessionsDir`, so there is one spelling of
   the name and `app.ts` stays the only file that knows where `userData` is.
9. **`RescanResultDto` gains no field.** A `reclassified` count is a contract change in three packages
   for a number nothing displays, and the re-pends are already counted where the existing re-pend
   counts them. This is F-3's own ruling and it is repeated here because "add a counter" is the
   obvious thing to do while writing the branch.
10. **The dependency is declared in two places and the lockfile is committed with it.**
    `packages/core/package.json` gains `"occt-import-js": "0.0.23"` in `dependencies` — the pattern
    `zod` follows in three packages — and root `deno.json`'s `imports` gains
    `"occt-import-js": "npm:occt-import-js@0.0.23"`. `deno install` rewrites `deno.lock`; **commit
    it**, because CI runs `deno install --allow-scripts --frozen` in eight jobs and a stale lockfile
    fails all eight with one cause.
11. **The frozen classifier snapshot lives in `packages/core/test/classify.test.ts` and pairs the
    version with the answers inside one object literal**, asserted whole. Two separate assertions —
    one on the answers, one on the version — do not create the coupling; a single literal that has to
    be edited does.
12. **Every docblock correction lands in the commit that falsifies it.** Not a follow-up task, not a
    "docs:" commit afterwards. Constraint 14 is checkable only if the diff that breaks a sentence is
    the diff that fixes it.
13. **The one STEP fixture is `cube.stp` out of the installed `occt-import-js@0.0.23`, resolved at
    test time and not committed.** This is the decision C1 forces and it is load-bearing for four
    test bullets, so it is stated once here rather than three times below.
    _The problem:_ `packages/core/test/fixtures/` holds four **generators** and no binary model —
    every mesh suite builds its input in source — and **a STEP file cannot be generated without a
    CAD kernel.** The ten files the spike measured live in `D:\SPM Library`, which none of the eight
    CI jobs can read; the two the earlier draft of task 1 pinned by name are third-party models with
    unrecorded provenance and licence, and one is 1.39 MB.
    _The decision:_ the only STEP file that can exist in CI without a CAD kernel is the one that
    ships with the CAD kernel. `occt-import-js@0.0.23` carries its own `cube.stp` — 8 247 bytes,
    12 triangles — and the spike measured it from a plain `npm install` of the published package
    (§5.3, §7). `deno install` puts it under `node_modules/occt-import-js/`, in every one of the
    eight jobs, and constraint 9 pins the version exactly, so the path cannot move without a
    deliberate version change. _Rejected:_ committing a library file (unrecorded licence, and F is
    the subsystem that is adding a third-party notice, so importing an unlicensed artifact in the
    same subsystem is the wrong trade); committing a copy of `cube.stp` (8 KB of LGPL-package
    content redistributed to save one `resolve` call).
    _The shape:_ a **fifth generator**, `packages/core/test/fixtures/make-step.ts`, in the shape of
    the four beside it, exporting `stepFixturePath()` — the resolved absolute path, throwing a
    message that names the package and the expected relative path if it is not there — and
    `writeStepFixture(dir, name)`, which copies it under a caller-chosen name so a test can produce
    `model.step`, `model.stp` or `not-really.stp` in a temp library. Every task below that consumes
    a STEP fixture names this helper and nothing else.
    _What gets pinned instead of 3 380 and 20 530:_ `triangleCount === 12`, `positions.length === 108`
    floats, and the fixture's own `8_247` bytes as an identity check on the file — **and the
    docblock says plainly that 12 is a weak swap-canary**, because twelve triangles is what any
    correct tessellation of a box returns, where 3 380 was a number only this library produces.
    What actually enforces constraint 9 is the exact version in `package.json` and the committed
    `deno.lock`; what covers the real library is the `deno task dev:desktop` target in the
    Definition of done, run against the user's ten files by hand.
    _One cost, named:_ every process that touches this fixture pays the 207 MB floor and 217 ms+ of
    parse once. Keep STEP-parsing tests few and let them share the process; do not add one per
    assertion where one parse can carry several.
14. **`readStepBytes(absPath, limits, io = STEP_IO)` is the seam that makes "refuses before reading"
    assertable**, and it is task 2's to add. Spec §9 requires the ordering to be asserted and not
    just the error, and neither mechanism the earlier draft offered exists: `parseStepFile` calls
    `statSync` and the read directly, with nothing to inject, and `statSync` on an absent path
    throws `ENOENT` rather than answering with a size. There is also no portable way to build a path
    whose `stat` succeeds and whose read fails. So the order becomes one function —
    `const STEP_IO = { size: (p: string) => statSync(p).size, read: (p: string) => readFileSync(p) }`,
    and `readStepBytes` stats, calls `assertStepFileFits`, and only then reads — with `io` a default
    parameter a test overrides with a reader that throws if it is ever called. Narrow on purpose:
    two functions, both `fs`, and the seam is invisible to every caller including `parseStepFile`,
    whose handed-over signature does not change.
15. **`classify.ts` exports `MODEL_EXTENSIONS` and both `classifyFile` and the snapshot read it.**
    **This extends the spec**, which asks in §9 for a snapshot over "every extension the module
    branches on" without saying how the test learns what those are. A hand-written list of keys
    catches a _changed_ answer and misses the commonest future bump — a **new** extension, `.ply` or
    `.3ds`, where no existing answer changes, nothing forces a row into the literal, the test stays
    green and the version goes unbumped. That is constraint 11's silent no-op arriving through a
    different door, and F's own case is caught only by the accident that `.step` was previously
    `other`. So `classifyFile`'s first line becomes
    `if (MODEL_EXTENSIONS.some((ext) => lower.endsWith(ext))) return { kind: 'model', slicer: null }`
    over `export const MODEL_EXTENSIONS = ['.stl', '.obj', '.step', '.stp'] as const`, and the
    snapshot test **computes** its answers by iterating that array plus the `.3mf` fixtures, so an
    added extension with no row in the frozen literal fails the whole-object comparison. **What it
    still cannot catch, and the comment must say so:** a branch added outside `MODEL_EXTENSIONS` —
    a new `.gcode`-shaped arm returning some other kind — and a change inside `classify3mf` that
    produces the same answers.
16. **`REQUIRED` moves into `packaging.ts` as `requiredArtifacts(outDir, appDir, executable)`**, and
    task 5 owns the move. `packaging.ts` exists precisely because `package-app.ts` "packages an
    application as a side effect of being imported" and so cannot be reached by `node --test`; its
    own docblock describes it as "the names `package-app.ts` gives what it writes", which is what
    the list is. `package-app.ts` keeps the loop that stats them. The move is a real change with a
    size: ~35 lines of array and comments relocated, one import, one call site — and it is what
    turns the five new entries from unasserted text into something `deno task test:desktop:unit`
    can fail on. **The alternative was rejected on evidence:** `package:desktop` is run by no CI
    job — all eight run `ubuntu-latest` and none of them packages — so leaving the list where it is
    leaves it covered by a manual Windows run and nothing else.
17. **The concurrency arithmetic is written out twice and pointed at once.** Three verbatim copies
    were planned; drift between copies is the defect class F exists to fix, so the count comes down
    to the two that have distinct audiences with no path to each other. `DEFAULT_CONCURRENCY`'s
    docblock in `previews/queue.ts` carries the three-row table because **spec 5.7 requires it there
    including the concurrency ≥ 2 line**. `README.md`'s **Preview memory** section carries it
    because an operator raising `SPM_PREVIEW_CONCURRENCY` is not reading source, and because the
    repository already pairs the two that way — `DEFAULT_MAX_MESH_BYTES`'s docblock says "the README
    carries the arithmetic for pairing it with `SPM_PREVIEW_CONCURRENCY`" today. The desktop's
    `PREVIEW_CONCURRENCY` docblock gets the floor, the blocking note and a pointer at
    `DEFAULT_CONCURRENCY`'s docblock — no table, because its reader is a developer who can follow a
    reference. **The remaining
    drift risk is named rather than designed away:** the table exists twice, in `queue.ts` and in
    the README, and the two change in one commit or not at all.

---

## Tasks

Five tasks. The split follows the dependency edges the code actually has: task 1 is the parser and is
completely inert, because nothing classifies as a STEP model yet; task 2 bounds it; task 3 is the
launch-side fix and is independent of all of the above; task 4 is the commit that makes the feature
visible and is the one the ordering constraint is about; task 5 is the licence and the packaging, and
it needs task 4's migration file to exist before it can name it.

**Landing order, as four checkable statements rather than a preference:**

- **Task 2 lands after task 1.** Not a blanking window — a build break. Every one of task 2's
  `packages/core` bullets edits `packages/core/src/previews/mesh/step.ts`, which does not exist
  until task 1 creates it: `assertStepFileFits` has no caller, `readStepBytes` has nothing to
  extract, and `deno task typecheck:core` fails on the import. Checkable: at the tip of task 1,
  `step.ts` exists; at the tip of task 2, it calls `assertStepFileFits`.
- **Task 4 lands after task 1.** Constraint 8. Checkable: at the tip of task 4,
  `packages/core/src/previews/mesh-handler.ts` contains `case '.step':`, and `git log --oneline` puts
  that commit first. If it does not, every `.step` file in every library reachable by that build is
  permanently `unsupported`.
- **Task 4 lands after task 2.** Not a spec constraint; a real one. Task 1's parser reads the whole
  file with no ceiling, which is harmless while nothing reaches it and is a hole the moment something
  does. Checkable: at the tip of task 4, `MeshLimits` has `maxStepBytes` and `parseStepFile` calls
  `assertStepFileFits`.
- **Task 5 lands after task 4.** `REQUIRED` names `dist/migrations/003_classifier_version.sql`, and
  `package-app.ts` throws on a `REQUIRED` entry that is not a non-empty file. Naming it before task 4
  creates it makes `deno task package:desktop` fail.

**Task 3 is independent and may land anywhere, including first.** It is a fix to shipped subsystem-D
code that F carries because F is the document that found it, and it applies to `.stl` and `.obj`
today. Nothing in it depends on STEP being classified or rendered.

Two notes on form, learned in D and E: Prettier reflows markdown and is **not idempotent** for
tables, fenced blocks or sub-lists nested inside a `- [ ]` item — it re-indents them further on every
pass, so `deno task fmt:check` can never go green. Every table and code block below therefore sits at
column 0 between list segments, and no list is nested.

### Task 1 — The dependency, `parseStepFile`, the `readMesh` arm, and the six false docblocks

`packages/core`, plus whatever `packages/desktop/build.ts` needs to make the parser reachable in the
Electron bundle. **Completely inert on landing:** `classifyFile` still returns `other` for `.step`, so
no job ever reaches the new arm. That is what makes it safe to land first, and constraint 8 is why it
must be.

- [ ] **Do the risky thing first.** Add the dependency, write a five-line scratch script that imports
      `occt-import-js` and parses one library STEP file, and run it under `node --test`'s runtime,
      under `deno run`, and inside `deno task dev:desktop`. Open question 10 — whether esbuild bundles
      the 96 KB emscripten glue for the Electron main process — is the one thing here that can turn a
      small task into a large one, and it is answered by running the build, not by reading it. **Do
      not write the parser first and discover this at the end.** While the package is freshly
      installed, settle the other thing that is cheaper to learn now than later: **find `cube.stp`
      inside `node_modules/occt-import-js/` and write its exact relative path down** — it is the only
      STEP fixture CI can have (decision 13), the spike measured it out of a plain `npm install` of
      this same published version, and if the tarball turns out not to carry it that is a blocker to
      raise rather than to work around (open question 15).
- [ ] Add `"occt-import-js": "0.0.23"` to `dependencies` in `packages/core/package.json`, and
      `"occt-import-js": "npm:occt-import-js@0.0.23"` to `imports` in root `deno.json`. Exact version,
      no caret (constraint 9). Run `deno install`, and **commit the resulting `deno.lock`** (decision
      10). `deno.json` also sets `minimumDependencyAge: P1D`; `0.0.23` is long-published so this
      should not bite, and if it does the remedy is a one-line entry in that block's `exclude`, which
      takes package names and not versions.
- [ ] Stage the `.wasm` beside the desktop bundle: a `copyWasm()` in `packages/desktop/build.ts` in
      the shape of `copyMigrations()` and `copyIcons()`, writing
      `node_modules/occt-import-js/dist/occt-import-js.wasm` to `packages/desktop/dist/`. Read-then-write,
      the same way `copyMigrations` does it and for the same reason. This is needed in **both** branches
      of the esbuild question (decision 7) — the `.wasm` is fetched by the glue at call time and is
      never bundled into JavaScript by anything.
- [ ] **And add `join(outDir, 'occt-import-js.wasm')` to `build.ts`'s own `assertWritten` call
      (`:107-110` is the function; the call is the one that already names `main.js`, `preload.js` and
      the two icons).** This is the in-build twin of task 5's `REQUIRED` entry and it is not the same
      assertion: `assertWritten` fails at **build** time, in `deno task build:desktop` and therefore
      in `deno task dev:desktop`, where `REQUIRED` fails only in `deno task package:desktop`, which
      no CI job runs. If the fallback branch also stages `dist/occt-import-js.js`, name that here
      too. The reason the icons are "named individually rather than counted" is the reason this is
      named at all: a `copyWasm()` that silently copies nothing produces a shell that starts and
      renders a blank thumbnail for every STEP file.
- [ ] **If the glue bundles cleanly**, leave `COMMON.external` as it is (`['electron']`) and confirm
      the glue resolves the staged `.wasm`. **If it does not**, take the fallback the spec already
      names: add `occt-import-js` to `external`, stage `dist/occt-import-js.js` beside the `.wasm`,
      load the glue with `createRequire`, and pass an explicit `locateFile`. Either way, **record which
      branch was taken in `build.ts`'s docblock**, because the next person to touch the bundle needs
      to know whether the resolution is the glue's default or this repo's.
- [ ] **The one sentence the fallback needs, which the branch above leaves open: _where_ the
      `createRequire` goes.** In the fallback `step.ts` still contains a bare
      `import … from 'occt-import-js'`, `occt-import-js` is `external`, and the packaged app has no
      `node_modules` — so that specifier resolves to nothing at runtime, and moving the
      `createRequire` into `step.ts` is not the fix: `packages/core` cannot compute a path only the
      desktop bundle knows, and core is also what the Deno server and `node --test` load, where the
      plain import is the **measured-working** path (§5.1, 10/10 on both). So the redirection is one
      of exactly two things and the choice is recorded in `build.ts`'s docblock beside the branch:
      **either** an esbuild `alias` (or a small resolve plugin) entry in `build.ts` pointing
      `occt-import-js` at a desktop-only shim that does the `createRequire` and the `locateFile`,
      leaving `step.ts`'s import untouched for Deno and Node — **or** an explicit loader seam in
      `step.ts`: `makeOcctLoader` already takes its factory (decision 4), so the module exports a
      `setOcctFactory()` the desktop's entry point calls once at startup with its `createRequire`d
      glue, and core keeps the plain import as the default nobody else has to change. **Prefer the
      `alias`**: it keeps the one measured path as the source's only path, confines the unmeasured
      one to the bundle that needs it, and adds no exported mutable state to `packages/core`.
- [ ] **This task is not finished until a STEP thumbnail renders in `deno task dev:desktop`.** The
      three targets are not equivalent: Deno and Node were measured 10/10 (§5.1), the Electron bundle
      was not measured at all, and it is the only one with no `node_modules` at runtime. A green
      `node --test` is not evidence about the target that was never measured.
- [ ] `packages/core/src/previews/mesh/step.ts`, beside `stl.ts`, `obj.ts` and `threemf.ts`, exporting
      `parseStepFile(absPath: string, limits?: MeshLimits): Promise<Mesh>` — the same signature shape
      as `parseStlFile` (`stl.ts:308`), taking the path rather than bytes, so the arm below reads like
      its three siblings.
- [ ] The module holds the factory once, in a closure over an injected factory rather than in a
      module-level `let` (decision 4). The exported `makeOcctLoader` is the seam the memo tests drive;
      `step.ts` itself builds exactly one loader and every parse goes through it:

```ts
export function makeOcctLoader(factory: () => Promise<Occt>): () => Promise<Occt> {
  let pending: Promise<Occt> | null = null
  return () => {
    if (pending === null) {
      pending = factory().catch((error: unknown) => {
        // Never cache a rejection: a cached one would wedge every STEP file in this process.
        pending = null
        throw error
      })
    }
    return pending
  }
}

const loadOcct = makeOcctLoader(occtimportjs)
```

- [ ] **The magic guard** (F-2). `const STEP_MAGIC = 'ISO-10303-21;'` — thirteen bytes. After the file
      is read and **before** anything reaches `ReadStepFile`, skip leading whitespace (`0x09`, `0x0a`,
      `0x0d`, `0x20` only) and compare the next thirteen bytes. On a mismatch throw
      `AppError('Validation', 'this file does not begin ISO-10303-21;, so it is not a STEP file',
{ found })`, where `found` is those thirteen bytes decoded as Latin-1 with non-printables replaced by
      `.`. All ten library files have the sequence at offset 0 with no BOM and no leading whitespace
      (§0), so the tolerance is insurance rather than a measured need, and it is cheap. Say that in
      the docblock rather than implying the whitespace was observed.
- [ ] **The adapter**, which is measured rather than designed (§5.4) — ten of ten library files
      through the repo's own unmodified `renderMesh`, `encodePng`, `assertMeshFits` and
      `allocateMesh`, producing ten valid 256×256 PNGs, at an adapt cost of 0.6–3.3 ms. Two shape
      mismatches, both measured, both handled by one loop: `renderMesh` wants **one** `Mesh`, a
      `Float32Array` triangle soup of `triangleCount * 9` floats, while `occt-import-js` returns an
      **array** of **indexed** meshes; and `positionsIsTypedArray: false` and `indexIsTypedArray:
false` on **all ten files**, so it returns plain JavaScript number arrays and the de-index loop does
      the float conversion for free.

```ts
function occtToMesh(result: OcctResult, limits: MeshLimits | undefined): Mesh {
  if (!result?.success || !result.meshes?.length) throw /* AppError('Validation', …) */
  let triangleCount = 0
  let vertexCount = 0
  for (const m of result.meshes) {
    triangleCount += m.index.array.length / 3
    vertexCount += m.attributes.position.array.length / 3
  }
  if (triangleCount < 1) throw /* AppError('Validation', …) */
  assertMeshFits(vertexCount, triangleCount, limits)
  const positions = allocateMesh(triangleCount * 9, 'positions')
  let o = 0
  for (const m of result.meshes) {
    const p = m.attributes.position.array
    const idx = m.index.array
    for (let i = 0; i < idx.length; i++) {
      const v = idx[i] * 3
      positions[o++] = p[v]
      positions[o++] = p[v + 1]
      positions[o++] = p[v + 2]
    }
  }
  return { positions, triangleCount }
}
```

- [ ] **The two `throw`s in that block are decision 3 and they are not the spike's answer.** The spike
      sketch returns `null` at both points; `null` from this arm is a message-less `unsupported` and
      `unsupported` is terminal (constraint 13). The messages: for `success: false`, that the STEP file
      could not be read by the parser, carrying whatever `result.error` holds if it holds anything;
      for zero triangles, that the file parsed but described no surfaces to draw. Both
      `AppError('Validation', …)`.
- [ ] **Say in the docblock that the `assertMeshFits` call over-charges, and why it is left that way.**
      `meshBytesFor` is `vertexCount * 12 + triangleCount * 36`, and this adapter allocates no vertex
      table at all — it de-indexes straight into `positions`. So the check is conservative by the
      vertex term. That is the correct direction to be wrong in and it costs nothing on this sample
      (the largest `positions` array in the whole ten is 796 932 bytes against a 256 MB ceiling), but
      an unexplained over-charge is the kind of thing a later reader "fixes".
- [ ] The `readMesh` arm in `packages/core/src/previews/mesh-handler.ts` — two cases, one arm, placed
      with the other three:

```ts
case '.step':
case '.stp':
  return parseStepFile(absPath, limits)
```

- [ ] **Nothing else in the preview chain changes, and one thing that looks like it should does not.**
      `EMBEDDED_HANDLER_WITH_MODELS` is first in `PREVIEW_HANDLERS` and claims `model`, so it sees
      every STEP job first — and `extractEmbeddedThumbnail` returns `null` for anything that is not a
      readable zip, which is the "not my job, ask the next one" answer. STEP falls through to the
      rasterizer exactly as `.stl` does. **`handlers.ts` needs no edit**; do not add one.
- [ ] `packages/core/src/index.ts` exports `parseStepFile` beside the other parsers if they are
      exported, and does **not** export it if they are not. Match what is there; do not widen core's
      public surface as a side effect.
- [ ] If `deno task typecheck:core` cannot resolve the package's TypeScript declarations, add a
      minimal ambient declaration at `packages/core/src/previews/mesh/occt-import-js.d.ts` naming
      **only** the factory, `ReadStepFile`, and the result shape this module reads. Do not declare
      `ReadFile`, `ReadIgesFile` or `ReadBrepFile`: spec 1.2 keeps IGES and BREP out of scope, and a
      declared entry point nothing has tested is how an `unsupported` row gets written for a file that
      could have rendered.
- [ ] **Correct the docblocks this task falsifies** (spec 5.7, constraint 14). They land in this
      commit. The table below is the whole list for this task — six rows over **five** of spec 5.7's
      seven entries, because that spec's single `mesh-handler.ts` row covers two paragraphs of one
      docblock and they are corrected differently. **Spec 5.7's other two are not this task's:** the
      `registry.ts` `behaviour` docblock is task 3's and `package-app.ts`'s `appCopyright` docblock is
      task 5's. The `packages/web` comment is task 4's, and the two docblocks spec 5.7 does not list
      — `desktop/src/previews.ts:74` and `server/src/env.ts:160` — are task 2's.

| File and symbol                                     | What the sentence says now, and what it must become                                                                                                                                                                                                                                                                                                                                                                                                                             |
| --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `mesh-handler.ts`, `readMesh` (`:31-37`)            | "none of them ever holds the file … the peak of a preview job is therefore its `positions` array plus a fixed window, **and not a function of the file at all**". True of three arms, false of the fourth. Must name the exception, say the STEP arm holds the whole file **twice** at the moment of the call (once as the JS `Uint8Array`, once inside the WASM heap), and say it costs ~244 MB regardless of the file                                                         |
| `mesh-handler.ts`, `readMesh` (`:39-42`)            | **The same docblock, second paragraph — not `makeMeshHandler`'s, which begins at `:58` and says nothing about asynchrony.** "Asynchronous for one reason: `DecompressionStream` … STL and OBJ could have stayed synchronous". A fourth arm now has its own reason — `occtimportjs()` is a factory returning a promise — and the parse itself is **synchronous and blocking** once it starts, 217–1 307 ms of it                                                                 |
| `previews/mesh/limits.ts`, `assertMeshFits`         | "The counts come from a counting pass that allocates nothing … **which is the only order in which a limit is worth having.**" For STEP the counts arrive _after_ OCCT has tessellated, so this call bounds only the adapter's own `positions` allocation. Must say which arms it describes                                                                                                                                                                                      |
| `previews/mesh/limits.ts`, `DEFAULT_MAX_MESH_BYTES` | "**Every read in this package is streamed**, so the document is no longer part of the peak". Must except STEP, and must say that this constant does **not** bound STEP's cost — the single most misleading available inference (constraint 16)                                                                                                                                                                                                                                  |
| `previews/queue.ts`, `DEFAULT_CONCURRENCY`          | "a worker is worth about 290 MB at the worst". Still true for meshes; needs the per-process STEP floor beside it and the arithmetic below, **including the concurrency ≥ 2 line**, because this docblock is what an operator reads before raising `SPM_PREVIEW_CONCURRENCY`                                                                                                                                                                                                     |
| `desktop/src/previews.ts`, `PREVIEW_CONCURRENCY`    | "each worker may hold one mesh, so the two numbers are one budget". Needs the floor, and needs the blocking note, because this is the docblock for the queue that runs **in the Electron main process**, on the same thread as the IPC dispatch table and the `spm://` handler that serves the thumbnails it produces. **The three-row table does not go here** — this one carries the floor, the blocking note and a pointer at `DEFAULT_CONCURRENCY`'s docblock (decision 17) |

- [ ] The `DEFAULT_CONCURRENCY` docblock's arithmetic, verbatim, because a formula that holds only at
      the default is worse there than no formula. The three rows are the table below, and the third is
      the one the docblock exists for: this is what an operator reads **before** raising
      `SPM_PREVIEW_CONCURRENCY`. **This docblock and the README's Preview memory section (task 2) are
      the only two places the table appears** — three copies were planned and the third became a
      pointer, because drift between copies is the defect class F exists to fix (decision 17). These
      two do still both carry it, and they change in one commit or not at all.

| Case                                       | Peak                                                                  |
| ------------------------------------------ | --------------------------------------------------------------------- |
| Before F                                   | `concurrency × (mesh + ~80 MB) + ~120 MB`                             |
| After F, at concurrency 1                  | the larger of `mesh + ~80 MB + ~120 MB` and ~244 MB — **not** the sum |
| After F, at concurrency ≥ 2 — **they add** | `(concurrency − 1) × (mesh + ~80 MB) + ~120 MB + ~244 MB`             |

- [ ] Why the second row is "whichever is larger" and the third is a sum: at one worker a mesh job and
      a STEP parse cannot be in flight together, so only one of the two terms is ever the peak. At two
      or more, a worker can be _holding_ an allocated `positions` array across an `await` when the STEP
      parse starts, and the reference library's worst is 208.8 MB of it. **Label the third row in the
      docblock as arithmetic on two separately measured processes rather than a measurement**, which
      is what it is — nobody has measured a process that does both (open question 3).
- [ ] `DEFAULT_CONCURRENCY` **stays 1** (F-9). Its value is not the change; its docblock is. The floor
      does not multiply with concurrency and that is a property of the code rather than a hope:
      `runPreviewQueue`'s "workers" are plain async functions racing over one job array in one process
      on one thread, so there is one module instance and one WASM heap however many there are.
- [ ] **The fixture, before any test that needs one** (decision 13). Write
      `packages/core/test/fixtures/make-step.ts` beside `make-3mf.ts`, `make-mesh.ts`, `make-png.ts`
      and `patch-zip.ts`, exporting `stepFixturePath(): string` — the `cube.stp` inside the installed
      `occt-import-js@0.0.23`, resolved from `node_modules/`, throwing a message that names the
      package, the version and the expected relative path if it is absent — and
      `writeStepFixture(dir: string, name: string): string`, which copies it under a caller-chosen
      name and returns the path. **This is the only STEP fixture in the repository**, every bullet
      below uses it, and nothing binary is committed: `packages/core/test/fixtures/` holds four
      generators and no model today, and a STEP file cannot be generated without a CAD kernel.
      Record the exact relative path in the helper's docblock once `deno install` has run — the
      first bullet of this task is where it is learned.
- [ ] Tests, `packages/core/test/step.test.ts`, under `node --test` **and** `deno test` (both suites
      run the core directory), against `stepFixturePath()`. **Pin it by its triangle count**:
      `triangleCount === 12`, `positions.length === 108` floats, and the fixture's own **8 247 bytes**
      as an identity check that the file under test is the one these numbers were measured on
      (§5.3). **Say in the test's comment that 12 is a weak swap-canary** — twelve triangles is what
      any correct tessellation of a box returns, where the library files' 3 380 and 20 530 (§5.4)
      were numbers only this build produces. Those two remain in the spike for anyone re-running
      against `D:\SPM Library` by hand; what enforces constraint 9 in CI is the exact version in
      `package.json` plus the committed `deno.lock`, and what covers the real library is the
      `deno task dev:desktop` target below.
- [ ] Tests, the magic guard: a file named `.stp` whose first bytes are not `ISO-10303-21;` — write
      one with `writeFileSync`, no fixture needed — throws `AppError` with `code === 'Validation'`.
      **And `stepFixturePath()` parses**, so the guard is not passing by refusing everything — an
      assertion satisfied by a `parseStepFile` that threw unconditionally would be no assertion at
      all.
- [ ] Tests, **the row and not the throw** (spec §9, constraint 5, and the first half of the
      Definition of done's failed-row line). The bullet above asserts an exception; the thing that
      ships is a database row, and "asserted as `failed`, not merely as throws, because the whole
      point is which row it leaves" is the spec's wording. So: drive the same not-really-STEP `.stp`
      through `makePreviewHandlers()` and `runPreviewQueue` the way the chain test below does, and
      assert the `previews` row ends `state = 'failed'` with a **non-empty `error`** containing
      `ISO-10303-21;`. `error` is the column (`001_init.sql:89`) and `queue.ts:313-315` is what
      writes it, truncated to 500 characters. The ceiling's twin of this assertion is task 2's.
- [ ] Tests, constraint 13, directly: **the STEP arm never returns `null`.** Drive `readMesh` (or
      `makeMeshHandler().run`) with `writeStepFixture(dir, 'model.step')` and with a `.stp` file that
      is not STEP, and assert the first returns a mesh and the second **throws** — then assert
      `readMesh` on a `.txt` path still returns `null`, in the same file, so the two outcomes are
      visibly different and a later "tidy-up" that converts the throw into a `null` goes red.
- [ ] Tests, the whole chain: **a `.step` file through the real `PREVIEW_HANDLERS` ends `ready`, not
      `unsupported`.** `writeStepFixture(libraryDir, 'cube.step')` for the input, and assert the row's
      `state`, not that a handler was called. Note that `classifyFile` still answers `other` for
      `.step` in this task, so the test inserts the `files` row at `kind: 'model'` itself rather than
      going through `rescan` — task 4's end-to-end bullet is the one that closes that gap, and it is
      the reason this assertion is not enough on its own. This is the assertion whose absence cost
      326 projects, and it is the reason `EMBEDDED_HANDLER_WITH_MODELS` claiming `model` first is
      worth pinning rather than reasoning about.
- [ ] Tests, the memo (decision 4), driven through `makeOcctLoader` and **not** through
      `parseStepFile`: build a loader over a fake factory, call it twice, assert the factory's call
      count is **1**; build a second loader over a factory that rejects once and then resolves, and
      assert the first call rejects, the second **resolves**, and the factory was called **twice**.
      The second half is the one that matters — a cached rejection turns one bad start into every
      STEP file `failed` for the life of the process, and nothing else in the suite would notice.
      **This is why the memo is a closure and not a module-level `let`:** `node --test` and
      `deno test` share one process across a file, so a memo held in the module would be resolved by
      the first parse in this suite and the rejection case would be unreachable for every test after
      it. Each test here builds its own loader and no test depends on the order of another. That the
      production module wires the real factory through the same function is covered by the parse
      tests above, which would not work at all if it did not.
- [ ] Do not write a test that measures peak RSS. There is no assertion about it that is not flaky
      across machines, and a test that measured it would be re-measuring the spike rather than pinning
      a behaviour. The floor is governed by task 2's ceiling and by the docblocks above, and it is
      watched by open question 2 rather than by CI.

**Interface handed to tasks 2 and 4 (an asserted invariant, not a summary — in D the launch record's
field list was handed over verbatim and still drifted by four fields):**
`parseStepFile(absPath: string, limits?: MeshLimits): Promise<Mesh>` from
`packages/core/src/previews/mesh/step.ts`; the two `case` labels `'.step'` and `'.stp'` on `readMesh`;
the rule that this arm throws rather than returning `null`; and
`stepFixturePath()` / `writeStepFixture(dir, name)` from
`packages/core/test/fixtures/make-step.ts`, which are the only way any later task gets a STEP file
(decision 13).

### Task 2 — The STEP size ceiling, and the three build targets it has to reach

`packages/core`, `packages/server`, `packages/desktop`, and the README. **No signature changes at
all** — the field rides the `MeshLimits` object that already reaches every parser whole
(`makePreviewHandlers` → `makeMeshHandler` → `readMesh`, from `server/main.ts:64` and
`desktop/previews.ts:124`). That is the argument for putting it there rather than beside it, and it
is also why the shape of subsystem E's plan §6.4 failure — a task requiring a type the DTO did not
carry — cannot repeat here: every seam this task uses was read before it was written.

- [ ] `packages/core/src/previews/mesh/limits.ts`: `DEFAULT_MAX_STEP_BYTES = 10_000_000`, beside
      `DEFAULT_MAX_MESH_BYTES`, and `MeshLimits` gains `maxStepBytes?: number` documented as defaulting
      to it.
- [ ] `assertStepFileFits(sizeBytes: number, limits: MeshLimits | undefined): void` in the same file,
      in `assertMeshFits`'s exact shape (decision 6): read
      `limits?.maxStepBytes ?? DEFAULT_MAX_STEP_BYTES`, and on a file over it throw
      `AppError('Validation', …)` **naming both sizes** through the existing private `megabytes()`
      helper, with `{ sizeBytes, maxStepBytes }` in the details. The message's job is the operator's
      next question, which is always "by how much". **The text, verbatim, because a brief that
      describes a message gets a different one from every implementer and the Definition of done
      asserts what it says:**

```ts
throw new AppError(
  'Validation',
  `this STEP file is ${megabytes(sizeBytes)}, more than the ` +
    `${megabytes(maxStepBytes)} permitted for one STEP file`,
  { sizeBytes, maxStepBytes },
)
```

- [ ] "Permitted for one STEP file" rather than `assertMeshFits`'s "this server permits", which is the
      one thing not copied from the neighbour: the same string ships inside the Electron app, where
      there is no server, and this is a new message rather than an existing one being reworded.
- [ ] **The read moves behind `readStepBytes`, which is what makes the ordering assertable**
      (decision 14). `parseStepFile` reads the file directly today; extract that into one function in
      `step.ts` whose whole job is the order, with the `fs` calls behind a default parameter:

```ts
const STEP_IO = {
  size: (p: string) => statSync(p).size,
  read: (p: string) => readFileSync(p),
}

function readStepBytes(
  absPath: string,
  limits: MeshLimits | undefined,
  io: typeof STEP_IO = STEP_IO,
): Uint8Array {
  assertStepFileFits(io.size(absPath), limits)
  return io.read(absPath)
}
```

- [ ] The size comes from `statSync`, **not from the buffer's length** — a check on the buffer is a
      check after the 40 MB is already in memory, which is exactly the cost the ceiling exists to
      avoid. `parseStepFile` calls `readStepBytes(absPath, limits)` and passes no `io`; the parameter
      exists so the test below can hand in a reader that throws if it is ever reached, and there is no
      portable alternative — `statSync` on an absent path throws `ENOENT` rather than answering with
      a size, and no portable path both stats and fails to read.
- [ ] **Three things about `MeshLimits` that are not tidy, said in its docblock rather than smoothed
      over.** `maxStepBytes` bounds a **file** where every other member bounds a **mesh**, so the
      type's name becomes slightly wrong — it is not renamed, because a rename touches every parser
      signature in the package for a naming improvement. `assertMeshFits` does **not** read it
      (`limits.ts:52-57` uses `maxMeshBytes` alone), so it has exactly one reader and nobody should
      add a second by analogy. And it is **not** a memory model: it is a guard against the unmeasured
      (constraint 16, open question 2).
- [ ] `packages/core/src/index.ts` exports `DEFAULT_MAX_STEP_BYTES` beside `DEFAULT_MAX_MESH_BYTES`
      (`:115`), because `packages/desktop/src/previews.ts` imports the mesh one from `@spm/core` and
      will import this one the same way.
- [ ] `packages/server/src/env.ts`, in `resolveMaxMeshBytes`'s exact shape (`:183-192`):

```ts
export const MAX_STEP_MB = 2_048
export const DEFAULT_MAX_STEP_MB = DEFAULT_MAX_STEP_BYTES / 1_000_000

export function resolveMaxStepBytes(raw: string | undefined): number {
  if (raw === undefined) return DEFAULT_MAX_STEP_BYTES
  const mb = requireWholeNumber(
    'SPM_MAX_STEP_MB',
    raw,
    `a size. Expected a whole number of megabytes from 1 to ${MAX_STEP_MB}`,
    MAX_STEP_MB,
  )
  return mb * 1_000_000
}
```

- [ ] `ServerEnv` gains `maxStepBytes: number` (`:207-217`) and `readServerEnv` gains
      `maxStepBytes: resolveMaxStepBytes(get('SPM_MAX_STEP_MB'))` (`:226-233`), beside the mesh line.
- [ ] **`MAX_STEP_MB = 2_048` matches `MAX_MESH_MB` and has a weaker reason than that one does, and
      the docblock must say so.** `MAX_MESH_MB`'s 2 048 is structural — `positions` is one
      `Float32Array` and 2 GB is 512 million elements, inside V8's element limit. Nothing equivalent
      constrains a STEP input; 2 048 here is a typo guard matched to the neighbouring constant so an
      operator reading `env.ts` does not have to learn two ceilings. It is **not** a promise that a
      2 GB STEP file parses: nothing above 1.39 MB has been measured at all.
- [ ] `packages/server/main.ts:64`: `makePreviewHandlers({ maxMeshBytes, maxStepBytes })`, reading
      `maxStepBytes` from the env object beside wherever `maxMeshBytes` is destructured.
- [ ] `packages/desktop/src/previews.ts`: `PREVIEW_MAX_STEP_BYTES = DEFAULT_MAX_STEP_BYTES` beside
      `PREVIEW_MAX_MESH_BYTES`; `PreviewTickerOptions` gains `maxStepBytes?: number` (`:101-113`); and
      the `makePreviewHandlers` call at `:124` passes
      `maxStepBytes: opts.maxStepBytes ?? PREVIEW_MAX_STEP_BYTES` the same way it passes the mesh
      ceiling. **The desktop gets the default and no environment variable**, because the desktop has
      no environment-variable surface for preview limits and F does not invent a configuration file
      for one.
- [ ] **Two false docblocks this task falsifies that no spec section lists** (constraint 14). Both sit
      on the line this task edits, which is how they were missed: a sweep for the claim found them,
      the list did not.

| File and symbol                                        | What the sentence says now, and what it must become                                                                                                                                                                                                                                                                                                                                                                                     |
| ------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `desktop/src/previews.ts:74`, `PREVIEW_MAX_MESH_BYTES` | "The mesh ceiling, and with `PREVIEW_CONCURRENCY` the whole memory budget: 1 x 256 MB." `PREVIEW_MAX_STEP_BYTES` is being added on the next line, so the two numbers stop being the whole budget in the same diff that says so. Must say the STEP floor sits beside it and is **not** multiplied by `PREVIEW_CONCURRENCY` — and must not imply this ceiling bounds a STEP parse (constraint 16)                                         |
| `server/src/env.ts:160`, `MAX_MESH_MB`                 | "A backstop, not a filter: **every read is streamed**, so the biggest file in the reference library needs 208.8 MB and the default permits 256." This is the server's copy of the exact sentence spec 5.7 requires be excepted at `limits.ts:11`, and `MAX_STEP_MB` is being added twenty lines below it. Must except STEP the same way, and say `SPM_MAX_MESH_MB` does not bound a STEP parse — `SPM_MAX_STEP_MB` is the one that does |

- [ ] **Where 10 MB comes from, in the constant's docblock, including the part that undercuts it.**
      The fitted model is ~243 MB of intercept plus ~25 bytes of peak per input byte, so a 10 MB input
      predicts 243 + 250 ≈ **493 MB — the entire 500 MB NAS budget, on one file.** It is also **7.2x
      the largest STEP file in the reference library** (1 388 035 bytes). And it cannot be accurate,
      because cost tracks surface complexity rather than size: 386 KB yielded 22 137 triangles while
      497 KB yielded 2 698, an 8x spread from similar inputs. **A size-keyed guard mis-prices both,
      and there is no other signal available before the parse.**
- [ ] **Say that raising `SPM_MAX_STEP_MB` is forward-only, and say what the operator actually does
      about it.** `failed` is terminal, so a raised ceiling gets the new limit for files the queue has
      not yet seen and **nothing at all** for the ones already refused — the same shape as the 326
      blank projects, arriving through a configuration change rather than a release. The only remedy
      the shipped code offers is to touch the file's bytes: a rescan that sees the content hash change
      resets the preview row to `pending` and zeroes `attempts`. This is already true of
      `SPM_MAX_MESH_MB`; F does not fix it and does not make it worse, and it is written down so
      nobody discovers it in the field.
- [ ] **`README.md`, which spec 5.7's table does not list and which carries the same claim in three
      places.** Add `SPM_MAX_STEP_MB` to the environment table beside `SPM_MAX_MESH_MB` (`:37`), with
      the default `10` and the range 1 to 2048. Then all three corrections, which land in this commit
      with everything else (constraint 14):
- [ ] **`:36`, the `SPM_PREVIEW_CONCURRENCY` row** — "Each worker may hold one whole mesh, so this
      multiplies the memory the queue uses." Incomplete for the same reason the Preview memory
      section is: the STEP floor is per process and does not multiply, so the row must say the
      per-worker part multiplies and the floor does not. It already points at **Preview memory**,
      which is where the arithmetic stays.
- [ ] **`:52`, the Preview memory section's opening** — "Nothing is read whole any more — a 164 MB
      STL and a 3MF whose model part inflates to 674 MB both pass through a fixed 256 KB window."
      This is the README's copy of `limits.ts:11`'s sentence and F makes it false. Must except STEP
      and say the file is resident **twice** at the moment of the call.
- [ ] **`:73`, the rule of thumb** — `concurrency × (SPM_MAX_MESH_MB + 80) + 120` megabytes is wrong
      for a process that has parsed a STEP file, in exactly the way the `DEFAULT_CONCURRENCY`
      docblock is, and the README is what an operator reads before raising either variable. Carry
      task 1's three-row table across **verbatim** and label the concurrency ≥ 2 line as arithmetic
      rather than measurement. **This is the second and last copy of that table** (decision 17): it
      is here rather than pointed at because an operator raising `SPM_PREVIEW_CONCURRENCY` is not
      reading source, and it is the pairing `DEFAULT_MAX_MESH_BYTES`'s docblock already assumes —
      "the README carries the arithmetic for pairing it with `SPM_PREVIEW_CONCURRENCY`". The two
      copies change in one commit or not at all.
- [ ] Tests, `packages/core`: `assertStepFileFits` refuses at the boundary — a size one byte over the
      ceiling throws `Validation` and a size exactly at it does not. Assert both directions; a ceiling
      test that only asserts the refusal passes an implementation that refuses everything. **The
      message is asserted in a separate case with numbers a megabyte apart** — `41_000_000` against
      `{ maxStepBytes: 10_000_000 }`, so the string reads `41.0 MB` and `10.0 MB` — because
      `megabytes()` is `toFixed(1)` and the boundary pair renders as the same string twice.
- [ ] Tests, the ordering, which is the half a naive test misses: **the read never happens.** Drive
      `readStepBytes` with its `io` (decision 14) — the path is never touched, so no fixture and no
      filesystem are involved:

```ts
const exploding = {
  size: () => 1_001,
  read: () => {
    throw new Error('read happened')
  },
}
// throws the Validation error, never 'read happened'
readStepBytes('/never/opened.step', { maxStepBytes: 1_000 }, exploding)

let read = 0
const counting = {
  size: () => 1_000,
  read: () => {
    read++
    return new Uint8Array()
  },
}
readStepBytes('/never/opened.step', { maxStepBytes: 1_000 }, counting) // read === 1
```

- [ ] Both halves, because a seam that never reads anything would pass the first on its own.
      **The two mechanisms an earlier draft of this plan named do not exist** and neither is worth
      reaching for: there is nothing to spy on a direct `statSync`/`readFileSync` pair, and
      `statSync` on an absent path throws `ENOENT` rather than answering with a size.
- [ ] Tests, the threading, one per hop, because the whole point of this task is that the field
      arrives: `makePreviewHandlers({ maxStepBytes: 1_000 })` produces a chain whose mesh handler
      refuses `writeStepFixture(dir, 'cube.step')` — the fixture is 8 247 bytes (decision 13,
      `packages/core/test/fixtures/make-step.ts`), so a ceiling of 1 000 puts it over without needing
      a large file anywhere in the repository. Then break the forwarding in `handlers.ts` — which
      needs no edit, so breaking it means temporarily dropping the argument — and confirm red.
- [ ] Tests, **the row and not the throw** (spec §9, constraint 5, and the second half of the
      Definition of done's failed-row line). Through `runPreviewQueue` this time: a file named
      `over.step` of **2 000 000 bytes**, `maxStepBytes: 1_000_000`, and the `previews` row ends
      `state = 'failed'` with an `error` containing **`2.0 MB`** and **`1.0 MB`** — both sizes as
      `megabytes()` renders them, not merely a non-empty `error`. **The content of that file does not
      matter and writing 2 MB of anything is the point**: the ceiling refuses before the read and
      before the magic guard, so a file that is not STEP at all still produces the ceiling's message,
      which is a second observation of the ordering above. **Do not reuse the 8 KB fixture here** —
      `megabytes()` is `toFixed(1)`, so 8 247 bytes and a lowered ceiling both render `0.0 MB` and
      "names both sizes" degenerates to naming one twice. Task 1 owns the magic-guard twin of this
      assertion; between them they are the only two places in F where the failure contract is
      observed as a row.
- [ ] Tests, `packages/server/test/env.test.ts`, in the shape of the `SPM_MAX_MESH_MB` cases already
      there: unset → `10_000_000`; `"40"` → `40_000_000`; `"0"`, `"-1"`, `"2049"` and `"ten"` all
      throw `Validation` naming `SPM_MAX_STEP_MB`.

**Interface handed to task 4 (an asserted invariant):** `MeshLimits` now reads
`{ maxMeshBytes?: number; maxStepBytes?: number }`; `DEFAULT_MAX_STEP_BYTES = 10_000_000` is exported
from `@spm/core`; and `parseStepFile` refuses an oversized file before it reads a byte.

### Task 3 — `opensStep`, the Cura refusal, and the explicit `cwd`

`packages/desktop` only. **Independent of every other task and of STEP itself** — the `cwd` half is a
fix to shipped subsystem-D code that applies to `.stl` and `.obj` today, and it may land first. It is
here because F is the document that found it.

- [ ] `packages/desktop/src/slicers/registry.ts`: `SlicerDef.behaviour` gains
      `opensStep: boolean` — **`false` for `cura`, `true` for `prusaslicer`, `anycubic`, `bambu` and
      `orca`.** It is a measured property of the product, from the same table that produced
      `savesInPlace`, `discardsForeignProjects`, `alwaysPromptsOn3mf` and `promptsWithoutOwnConfig`.
- [ ] The field's own docblock carries the measurement, three ways plus a control: Cura 5.13.0 handed
      a `.step` or a `.stp` on argv reaches one window titled `Untitled - UltiMaker Cura 5.13.0` with
      no dialog and nothing to dismiss; the same install in the same session handed `cone.stl` shows
      `cone - UltiMaker Cura 5.13.0`, so the absence is measured rather than a broken probe; its own
      log says `Unsupported Mime Type Database file extension` seven milliseconds after `Attempting to
read file`; and its plugin directory lists eleven plugins by name, none of which reads STEP, in both
      5.12.0 and 5.13.0.
- [ ] **Say in the docblock what it is not.** `opensStep` is not a general capability matrix and must
      not grow into one. It is one boolean because exactly one measurement distinguishes exactly one
      product; a `formats: Set<string>` per slicer would be four rows of speculation and one row of
      evidence, and the four would be unfalsifiable until somebody added a format nobody had measured.
- [ ] **Amend the `behaviour` docblock at `registry.ts:63-66`**, which is the part a field addition is
      most likely to skip (spec 5.7, constraint 14). It says these flags are "Read by the launch paths
      to decide **what the app may honestly claim**" — true of all four flags today, because all four
      feed `notices()`. `opensStep` is read to **refuse a launch**, and a refusal is not a claim about
      a launch that is going ahead. The sentence must say the flags drive two things: what `notices()`
      says, and whether a launch happens at all. **The "never a strip set" half is untouched** — the
      strip sets are indexed by the flavour of the _file_ and cannot live on a `SlicerId` key, while
      STEP capability is indexed by the _product_ and cannot live anywhere else. The two cases are
      opposites, and that reasoning is what makes this field admissible under a docblock that refuses
      another one.
- [ ] **`SlicerInstallDto` does not grow a capability field.** Nothing in the UI would read it: there
      is no per-launch slicer picker. When there is one, that is the change that adds it.
- [ ] The refusal, in `launch.ts`, immediately after `chooseSlicer` (`:454`) and **before** the
      `installId` lookup (decision 5). The extension comes from `extname(source.name).toLowerCase()`,
      the same expression `#prepare` uses at `:648`:

```ts
if ((extension === '.step' || extension === '.stp') && !SLICERS[slicerId].behaviour.opensStep) {
  refuseStepFormat(slicerId, extension)
}
```

- [ ] `refuseStepFormat` throws `AppError('Validation', …)` carrying `{ slicerId, extension }`
      (F-4), and **derives the list of capable products from the registry rather than spelling it**.
      This repo's rule, applied by `SLICER_IDS`, `makePreviewHandlers` and `DEFAULT_CONCURRENCY`
      alike: read rather than copied. The message names the product, says it cannot read STEP files,
      and says which other slicers to choose — because the alternative the user is otherwise left
      with is the measured one: a healthy process, an empty plate, and a warning in a log file they
      will never open. **The text, verbatim, for the same reason `assertStepFileFits`'s is given
      verbatim:**

```ts
function refuseStepFormat(slicerId: SlicerId, extension: string): never {
  const capable = SLICER_IDS.filter((id) => SLICERS[id].behaviour.opensStep).map(
    (id) => SLICERS[id].displayName,
  )
  throw new AppError(
    'Validation',
    `${SLICERS[slicerId].displayName} cannot open STEP files. ` +
      `Choose one of ${capable.join(', ')} instead.`,
    { slicerId, extension },
  )
}
```

- [ ] Which reads, today, as "UltiMaker Cura cannot open STEP files. Choose one of PrusaSlicer,
      Anycubic Slicer Next, Bambu Studio, OrcaSlicer instead." — and that is the sentence to check
      against the common shape below, because it is the one the user sees. It offers no conversion
      advice: the app has no converter and nothing in the spike measured one.
- [ ] **It is an error and not a `notices()` sentence.** `notices()` says what _will_ happen during a
      launch that is going ahead; this launch does not go ahead. Warning and launching anyway is the
      silent-discard case with extra words, and D already settled the analogous question for
      Anycubic's strip refusal: "the tempting fallback — launch the original instead — _is_ the
      silent-discard case."
- [ ] **The common shape of this refusal is "your default slicer is Cura and this file is a STEP"**,
      because `chooseSlicer` takes an explicit `opts.slicerId` or the configured default and the
      current UI has no per-launch picker. The message has to read correctly as that.
- [ ] `SLICER_CWD_DIR = 'slicer-cwd'` in `launch.ts` beside `SLICER_SESSIONS_DIR` (`:90`), and
      `SlicerLauncherOptions` gains `scratchCwdDir: string` beside `sessionsDir` (`:201-202`), with a
      docblock saying `<userData>/slicer-cwd`.
- [ ] **And the class gains the field the snippet below reads**, which is the half an options-object
      bullet skips: `readonly #scratchCwdDir: string` beside `readonly #sessionsDir: string`
      (`launch.ts:411`), and `this.#scratchCwdDir = options.scratchCwdDir` beside
      `this.#sessionsDir = options.sessionsDir` in the constructor (`:421-431`). Required, not
      optional, and with no default — constraint 12 is that a `cwd` which can be omitted is a `cwd`
      that will be, and the same reasoning applies one level up to the directory it points at.
- [ ] `SpawnSlicer` (`launch.ts:198`) widens. **A required object with one required field, not an
      optional bag** (constraint 12), and narrow on purpose: `detached` and `stdio` are the real
      spawn's business and no test asserts them through this seam.

```ts
export type SpawnSlicer = (
  command: string,
  args: readonly string[],
  options: { cwd: string },
) => SpawnedSlicer
```

- [ ] `#spawnOrClean` (`launch.ts:711-713`) threads it. It already receives the whole `LaunchPlan`,
      which already carries `directory: string | null` (`:401-408`), so no signature above it changes:

```ts
#spawnOrClean(executable: string, slicerId: SlicerId, plan: LaunchPlan): SpawnedSlicer {
  try {
    const cwd = plan.directory ?? this.#scratchCwdDir
    if (plan.directory === null) mkdirSync(cwd, { recursive: true })
    return this.#spawn(executable, SLICERS[slicerId].argv(plan.path), { cwd })
  } catch (error) {
    if (plan.directory !== null) rmSync(plan.directory, { recursive: true, force: true })
    throw new AppError('Internal', `could not start ${SLICERS[slicerId].displayName}`, {
      cause: String(error),
    })
  }
}
```

- [ ] The `mkdirSync` is **inside** the `try` and **immediately before every spawn that needs it** —
      not once at construction, so a profile where the user deleted the directory between launches
      still works, and not lazily-on-first-use, because "created lazily" is exactly the property that
      makes `sessionsDir` unusable here. Inside the `try` so a failure to create it converts into the
      same `AppError('Internal', …)` rather than escaping raw.
- [ ] `app.ts`'s closure (`:1174`) takes the options and spreads them:
      `spawn(command, [...args], { cwd, detached: true, stdio: 'ignore' })`, keeping the `child.unref()`
      and the comment above it. `app.ts` also builds
      `const scratchCwdDir = join(app.getPath('userData'), SLICER_CWD_DIR)` beside `sessionsDir`
      (`:1156`) and passes it to `new SlicerLauncher({ … })`.
- [ ] **Write the "which directory, and why not either of the two obvious answers" reasoning into the
      `SLICER_CWD_DIR` docblock**, because an earlier draft of the spec got it wrong in a way that
      would have broken every in-place launch. **Not `userData` itself:** it holds `state.json`,
      `slicers.json` and `browse.json` plus `model-downloads/` and `slicer-sessions/`, and pointing a
      slicer's cwd at the directory holding the app's own configuration is a smaller version of the
      defect being fixed. (The library database is **not** there — it is `<libraryDir>/.spm/app.db` —
      which is worth stating because the opposite is an easy thing to assume.) **Not `sessionsDir`:**
      it is created lazily by a launch that needs a directory, an in-place launch by definition needs
      none, so on a fresh profile the path does not exist, `spawn` throws `ENOENT`, and every in-place
      launch fails for every slicer until some other launch happens to create it — and a cwd-relative
      export landing loose there is surfaced to the user as an **orphan session** they have to answer.
- [ ] **Say what the `cwd` fixes and what it does not**, in the same docblock. It bounds one measured
      mechanism — cwd-relative resolution — and says nothing about a slicer resolving against an
      absolute configured path; Anycubic's `--export-stl` with `--outputdir` set is unmeasured and the
      app passes neither flag. A launch-directory cwd makes a loose stray visible, because `#scan`
      reports a file in a launch directory that is neither `launch.json` nor the launched file as a
      session of its own. **A stray in a _subdirectory_ stays invisible in both cwds**, because
      `#scan` filters `child.isFile()` (`sessions.ts:717-718`) — and the one measured cwd-relative
      write in this whole subsystem is `stl/obj_1_….stl`, a subdirectory. So for that shape the `cwd`
      moves the file from an inherited unknown to a directory the app owns, and does not move it into
      anything that surfaces it. **That is an improvement and not a solution** (open question 5).
- [ ] **Nothing sweeps `slicer-cwd`, and the docblock must not say anything does** (constraint 15). It
      is not under `sessionsDir`, so `sweepAtStart` never sees it, and F deliberately adds no sweeper:
      deleting a file a slicer wrote is D's constraint 10 territory, and the directory grows only by
      the strays it exists to catch — which, on the evidence, is one product on one flag. What it must
      never become is a directory this project _says_ is swept when it is not.
- [ ] **The `.step` files in this suite are bytes, not models, and this task uses no fixture.**
      Nothing here parses one: the launcher copies the file and spawns a recorder. So a
      `writeFileSync(join(dir, 'part.step'), 'ISO-10303-21;')` is the whole input, the same way this
      suite already makes its `.stl` and `.3mf` inputs. **Do not reach for task 1's
      `writeStepFixture`** — this task is independent of tasks 1 and 2 and may land first, and a
      dependency on their helper would silently make that false.
- [ ] Tests, `packages/desktop/test/slicers-launch.test.ts`. **Widen the spawn recorder to capture the
      options object, and understand that nothing forces you to.** A two-parameter recorder stays
      assignable to the widened `SpawnSlicer` type, so `deno task typecheck:desktop` is green with the
      `cwd` uncaptured and unasserted — this is a change an implementer must make deliberately, and it
      is the single most likely place in F for a test to be written that cannot fail.
- [ ] Tests, the `cwd`, **both paths, by value**: a `.3mf` or `.step` launch (which builds a launch
      directory) spawns with `cwd` equal to that launch directory; an `.stl` launch (which does not)
      spawns with `cwd` equal to the scratch directory. **The in-place assertion is the one that
      matters** — a `cwd` left `undefined` there is the shipped defect with a type annotation over it,
      and it is also the case that would have shipped had the fallback stayed `sessionsDir`.
- [ ] Tests, the `cwd` exists at spawn time: assert `existsSync(options.cwd)` **inside the recorder**,
      at the moment of the spawn, not afterwards in the test body. This is the half that catches a
      `mkdirSync` moved to construction, and it is what would have caught the `sessionsDir` answer on a
      fresh profile.
- [ ] Tests, the Cura refusal: a `.step` file launched with `slicerId: 'cura'` throws `AppError` with
      `code === 'Validation'` and `details.slicerId === 'cura'`, and **the spawn recorder's call count
      is zero.** Assert the count, not that it threw. The existing recorder makes this a no-slicer
      test.
- [ ] Tests, the refusal does not over-refuse: the same `.step` file launched with each of
      `prusaslicer`, `anycubic`, `bambu` and `orca` **spawns**. Four assertions, because a refusal
      keyed on the wrong side of the boolean would pass a test suite that only ever asks about Cura —
      an assertion satisfied by refusing everything is not an assertion.
- [ ] Tests, the launch path for a `.step`: the exact path spawned is **inside the launch directory**
      and its basename is the source's, asserted the way D's `.3mf` case is, "rather than trusting this
      paragraph". This is the assertion that would notice somebody moving STEP onto the in-place branch
      without the measurement in open question 1.
- [ ] Tests, the registry: `SLICERS.cura.behaviour.opensStep === false` and the other four `=== true`,
      asserted individually rather than as a filter over the table, so a row that flips is named in
      the failure.

### Task 4 — The classifier version, migration 003, the four `rescan` edits, and the web comment

`packages/core`, plus one comment in `packages/web`. **This is the commit that makes the feature
visible**, and constraint 8 is about this task and no other: it must not land before task 1, and it
must not land before task 2. After it, the user's ten existing STEP files reclassify and render.

**It is one commit and not four.** The migration without the write sites leaves every row permanently
stale; the write sites without the migration have no column to write into.

- [ ] `packages/core/src/files/classify.ts`: `classifyFile` gains `.step` and `.stp` as model
      extensions. The path is already lowercased once at the top (`absPath.toLowerCase()`), so the
      uppercase `.STEP` the user already has in their library is handled by the existing shape and
      `extensionOf` in `mesh-handler.ts` folds case for the same reason. **Neither needs changing.**
- [ ] **The `model` line becomes a list the snapshot test can enumerate** (decision 15). Today it is
      `if (lower.endsWith('.stl') || lower.endsWith('.obj'))`, and a chain of `endsWith` is a set no
      test can read, which is why the frozen snapshot below would not catch the commonest future bump:

```ts
/** The extensions that classify as `model` on their name alone. Enumerated by the frozen
 *  snapshot in `test/classify.test.ts`, so an addition here with no row there fails. */
export const MODEL_EXTENSIONS = ['.stl', '.obj', '.step', '.stp'] as const
```

- [ ] and `classifyFile`'s first branch becomes
      `if (MODEL_EXTENSIONS.some((ext) => lower.endsWith(ext))) return { kind: 'model', slicer: null }`.
      Nothing else in the function changes: the `.3mf` branch, the `other` default and the purity are
      exactly as they are.
- [ ] **Extension only. No content check** (F-1). Zero mismatches in both directions over all 2 946
      files: no file with STEP content carries a non-STEP extension, and all ten with a STEP extension
      begin `ISO-10303-21;` at offset 0. The argument against a magic check is the contract, not the
      cost: `classifyFile` is pure and synchronous for `.stl` and `.obj` today, and a magic check would
      put `open` throwing on a locked, deleted or permission-denied file on the one path in the module
      that has no I/O error path at all. The guard that is worth having is task 1's, at the point of
      use, where the parser has the bytes already.
- [ ] `CLASSIFIER_VERSION = 1`, exported from `classify.ts`, with a docblock that says what bumping it
      costs and when to do it: it re-runs `classifyFile` over every indexed file once, which for the
      reference library's **402 `.3mf` files** is 402 zip reads. It does **not** re-hash — the content
      hash is untouched, because nothing about the bytes changed — so it is a one-time cost on the
      order of a normal rescan's classification work and not of a full backfill.
- [ ] `packages/core/src/db/migrations/003_classifier_version.sql`, one statement, with a comment block
      in `002_preview_claim.sql`'s shape explaining what it is for:

```sql
ALTER TABLE files ADD COLUMN classified_by INTEGER NOT NULL DEFAULT 0;
```

- [ ] **`DEFAULT 0` is the whole mechanism and the wrong default is a silent no-op** (constraint 11).
      Write that into the migration's comment: 0 is a value `CLASSIFIER_VERSION` can never take, which
      makes "this row predates the mechanism" expressible rather than inferred; a backfill of the
      shipping constant would leave nothing stale, reclassify nothing, and produce a feature that is
      simply absent with no symptom to notice. `NOT NULL DEFAULT 0` is also what makes the column
      readable without a null branch, and SQLite's `ADD COLUMN` accepts it precisely because the
      default is a constant — the same shape as 002's `ALTER TABLE previews ADD COLUMN claimed_at
INTEGER`, which is the only precedent this repository has.
- [ ] **And answer the downgrade question in the same comment, because it is the one a reader of a
      migration asks and nothing else in F answers it.** An older build opening a database this one
      has migrated finds `user_version = 3`: `runMigrations` skips every migration whose version is
      `<= user_version` (`migrate.ts:14-15`), so it runs nothing and does not fail. Its eight-column
      `INSERT` into `files` omits `classified_by`, which takes the column's `DEFAULT 0` — so rows
      written by the older build come back as "predates the mechanism", which is exactly what they
      are, and the newer build reclassifies them on its next rescan. **The downgrade is benign and
      the reason is the `DEFAULT`**, which is worth one sentence beside the `DEFAULT` rather than
      being rediscovered by whoever wonders.
- [ ] `packages/core/src/db/migrate.ts`: `MIGRATIONS` gains
      `{ version: 3, file: '003_classifier_version.sql' }`. `runMigrations` reads a frozen list, so the
      file on disk does nothing without this line.
- [ ] `packages/core/src/projects/rescan.ts`, edit 1 of 4 — **the `existing` SELECT (`:164-165`) gains
      two columns** (decision 2), and its row type gains both:

```ts
const existing = new Map(
  (
    lib.db
      .prepare(
        'SELECT id, rel_path, size_bytes, mtime_ms, kind, classified_by FROM files WHERE project_id = ?',
      )
      .all(row.id) as {
      id: string
      rel_path: string
      size_bytes: number
      mtime_ms: number
      kind: string
      classified_by: number
    }[]
  ).map((f) => [f.rel_path, f]),
)
```

- [ ] Edit 2 of 4 — `insertFile`'s `INSERT` (`:113-116`) gains a ninth column and a ninth `?`, bound to
      `CLASSIFIER_VERSION` at the call site (`:175-185`):

```ts
const insertFile = lib.db.prepare(
  `INSERT INTO files (id, project_id, rel_path, kind, slicer, size_bytes, mtime_ms, content_hash, classified_by)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
)
```

- [ ] Edit 3 of 4 — the stat-mismatch `UPDATE` (`:198-201`) also sets `classified_by`:

```ts
'UPDATE files SET kind = ?, slicer = ?, size_bytes = ?, mtime_ms = ?, content_hash = ?, classified_by = ? WHERE id = ?'
```

- [ ] Edit 4 of 4 — **the stat-match short-circuit at `:192-193` becomes conditional**, and the
      version-mismatch branch goes inside it. Two new prepared statements beside the three that are
      already hoisted out of the loop: `reclassifyFile`, and an existence check for the preview row.

```ts
const reclassifyFile = lib.db.prepare(
  'UPDATE files SET kind = ?, slicer = ?, classified_by = ? WHERE id = ?',
)
const previewExists = lib.db.prepare('SELECT file_id FROM previews WHERE file_id = ?')
```

```ts
if (Number(known.size_bytes) === file.size && Number(known.mtime_ms) === file.mtimeMs) {
  if (Number(known.classified_by) === CLASSIFIER_VERSION) continue
  const classification = classifyFile(file.absPath)
  reclassifyFile.run(classification.kind, classification.slicer, CLASSIFIER_VERSION, known.id)
  if (classification.kind !== known.kind) {
    if (previewExists.get(known.id)) resetPreview.run(now, known.id)
    else insertPreview.run(known.id, now)
    result.previewsQueued++
  }
  continue
}
```

- [ ] **The two-armed `insertPreview` / `resetPreview` is not defensive padding.** `resetPreview`
      (`:120-125`) is the only re-pend statement in the file and the stat-mismatch path already guards
      it the same way (`:211-215`). A bare `UPDATE previews … WHERE file_id = ?` against a row that is
      not there updates nothing and reports nothing, so a file whose preview row is missing — a
      database restored without it, a row deleted by hand, any future path that inserts a file without
      one — would reclassify to `model` and then never render.
- [ ] **Only a kind that actually changed re-pends.** A file that reclassifies to the same kind gets
      its `classified_by` written and its preview row left exactly as it was, so a version bump made
      for a `.step` change does not re-render 1 311 STLs. **`result.previewsQueued` is incremented
      where it re-pends**, as the existing path does, and `RescanResultDto` gains no field
      (decision 9).
- [ ] **Write the open consequence into the branch's comment rather than hiding it**: re-pending on a
      kind change is right for `other → model`. The reverse — `model → other`, which no change in F
      causes but a future one could — would leave a `ready` row with a PNG for a file the viewer no
      longer offers. Harmless today, and the kind of thing that should be decided when something
      actually causes it (open question 6).
- [ ] **Correct the comment in `packages/web/src/app/features/projects/project-detail.page.ts`**
      (spec 7.2, F-16, constraint 14). It lands in this commit because this is the commit that
      falsifies it. The viewer-link comment at `:441-444` says the link is "Offered for model files
      alone, **which is exactly the set the viewer's three loaders cover**", and names `.stl`, `.obj`
      and mesh `.3mf`. F makes that false. **The gate at `:446` and the thumbnail hit-target gate at
      `:393` are left exactly as they are** — hiding the link for STEP would hide the honest message
      the viewer already renders and would put the viewer's format list in a second place, which is
      the thing `SUPPORTED_FORMATS` exists to prevent. A link that leads to "this viewer opens STL,
      OBJ, 3MF" is a better answer than a control that silently is not there. **No behaviour changes
      in `packages/web` in this task** (constraint 1).
- [ ] **One comment, not two, and this is where the plan reads against the spec's count.** Spec 7.2's
      prose says "It does need two corrections" and spec 5.7 says "Two more outside `core`". The code
      has one false sentence. The second thing 7.2 names is **the thumbnail hit-target**, and its
      comment (`:381-392`) makes no format claim at all — it is entirely about `aria-hidden` and
      `tabindex="-1"` on a duplicate link ("It is a duplicate of the labelled 'View <name>' control
      in the same row"), and 7.2's own words are that it "is gated identically and follows the same
      decision", which is a statement about the **gate**, not about a sentence. Constraint 14 is
      about sentences that stop being true; editing a comment that asserts nothing to make a count
      come out at two is padding, and this repository does not write documentation for its own sake.
      **So: correct one comment, leave the hit-target's alone, and if a reviewer holds the spec's
      count as binding the remedy is to amend the spec's sentence, not to invent an edit.** Every
      other statement of the count in this plan — the Architecture paragraph, the Scope table,
      constraint 1, this task's title and the Definition of done — says one, and they were changed
      together so no brief can be extracted that disagrees with another.
- [ ] **Placement: this correction is here and not in a sixth step**, which is a deliberate departure
      from spec §8, whose step 6 is "the `packages/web` comment corrections (7.2)". Constraint 14 and
      decision 12 require a falsified sentence to be corrected **in the commit that falsifies it**,
      and the commit that falsifies this one is this task's — a later step would leave a window in
      which `main` carries a comment the code contradicts. The spec's own 5.7 states the same rule
      ("Each is part of the change, not a follow-up"), so this follows the spec's rule over its
      ordering list. **No other task moves a spec step.**
- [ ] Tests, reclassification, the headline case: a file inserted at `kind: 'other'` with
      `classified_by = 0`, rescanned **with its size and mtime untouched on disk**, comes back
      `kind: 'model'` with a re-pended preview row. **The "untouched" is the whole test** — a fixture
      that rewrites the file passes against the broken behaviour, because the stat mismatch would have
      reclassified it anyway. The file's bytes are irrelevant here: `classifyFile` reads the extension
      and nothing else, so a `writeFileSync(…, 'ISO-10303-21;')` named `part.step` is the input. The
      real STEP fixture is only needed by the end-to-end bullet below, which renders one.
- [ ] Tests, the migration's default: a database opened at `user_version = 2` with `files` rows in it,
      migrated, has `classified_by = 0` on every row **and `0 < CLASSIFIER_VERSION`**. **The second
      half is the assertion** (constraint 11), and it must not be spelled `CLASSIFIER_VERSION === 1`.
      A migration that backfilled the shipping constant leaves the first half true, nothing stale, and
      the feature absent with no other symptom.
- [ ] Tests, **all three write sites, three assertions and not one**: after a first-sight insert, after
      a stat-mismatch update, and after a version-mismatch reclassify, the row's `classified_by` equals
      `CLASSIFIER_VERSION`. Leaving any single site alone is invisible until the next rescan, which is
      why one combined assertion would not catch it.
- [ ] Tests, **idempotence, which is what makes a missed site visible**: rescan twice with nothing
      touched on disk; the second pass reclassifies nothing and queues no previews. Assert
      `previewsQueued === 0` on the second pass. This is the assertion that catches a row permanently
      stale — reclassified every tick for ever, 402 zip reads a tick rather than a version bump — and
      it is the one a "does it reclassify?" suite omits.
- [ ] Tests, same kind, no re-pend: a file whose reclassification returns the kind it already had gets
      its `classified_by` written and its `ready` preview row left untouched — assert the row's
      `state`, `png_path` and `attempts` are all unchanged, not merely that `previewsQueued` is 0.
- [ ] Tests, the `insertPreview` fallback: a version-stale file whose preview row has been **deleted**,
      reclassified to a new kind, ends with a `pending` preview row — not with nothing, which is what a
      bare `resetPreview` produces.
- [ ] Tests, the forgotten bump (decision 11). One frozen literal in
      `packages/core/test/classify.test.ts` pairing the constant with `classifyFile`'s answer for every
      extension the module branches on, asserted **whole** against a computed table. **"Computed" is
      load-bearing and it is what decision 15 exists for:** the test builds its `answers` object by
      iterating `MODEL_EXTENSIONS` and the `.3mf` fixture cases and calling `classifyFile` on each,
      then compares the whole `{ version, answers }` object against the literal below with a deep
      equality. A hand-listed set of keys catches a **changed** answer and misses an **added**
      extension — `.ply`, `.3ds` — where nothing existing changes, no row is forced into the literal,
      the test stays green and the version goes unbumped. Computing the keys turns that into a
      failure: the new extension appears in `answers` and not in the literal, and the deep equality
      is what notices.

```ts
const CLASSIFIER_SNAPSHOT = {
  version: 1,
  answers: {
    '.stl': 'model',
    '.obj': 'model',
    '.step': 'model',
    '.stp': 'model',
    '.3mf/cura': 'slicer_project',
    '.3mf/prusaslicer': 'slicer_project',
    '.3mf/orca': 'slicer_project',
    '.3mf/bambu': 'slicer_project',
    '.3mf/anycubic': 'slicer_project',
    '.3mf/unsliced': 'slicer_project',
    '.3mf/mesh': 'model',
    '.3mf/unreadable': 'other',
    '.gcode': 'other',
    '.txt': 'other',
  },
}
```

- [ ] The comment above that literal says what it is for and what repairs it: changing what any
      extension classifies as, **or adding one to `MODEL_EXTENSIONS`**, breaks this test, and the only
      edit that repairs it is one that touches `CLASSIFIER_VERSION` **in the same commit**, because
      the version sits inside the literal being edited. **And it says what it cannot catch**, so
      nobody trusts it further than it goes: a change inside `classify3mf` that produces the same
      answers on the fixture set, and a branch added **outside** `MODEL_EXTENSIONS` — a new
      `.gcode`-shaped arm returning some other kind — which the enumeration does not reach. The
      snapshot pins the function's answers, not its reasoning, and F has no measurement that says
      which internal changes warrant a bump.
- [ ] **This literal contains `version: 1` and constraint 11 forbids `CLASSIFIER_VERSION === 1`, and
      the two are not in conflict — say so in the comment, because they read as a contradiction and
      both land in this task.** They are opposite tests of the same constant. The **migration** test
      asserts `0 < CLASSIFIER_VERSION`, because a bump is legitimate there and a test pinned to
      today's value would go red for the wrong reason and teach whoever bumped it to edit the test.
      The **snapshot** pins the value on purpose, because going red on a bump _is_ its mechanism: it
      is how the edit that changes an answer is forced to touch the version in the same commit. One
      test must survive a bump; the other exists to be broken by one.
- [ ] Tests, the assertion the whole feature is for: the ten-file end-to-end shape, scaled down — a
      library containing a `.step` file indexed at `kind: 'other'` before the upgrade, opened by a
      build that has migration 003 and the handler arm, ends with that file `kind: 'model'` and its
      preview row `ready` with a PNG. **This one needs a file that really parses**, so the input is
      `writeStepFixture(libraryDir, 'part.step')` from `packages/core/test/fixtures/make-step.ts` —
      task 1's helper over the `cube.stp` inside the installed `occt-import-js` (decision 13), which
      is the only STEP file the eight CI jobs can reach. This is the only test that observes
      constraint 8 being satisfied rather than reasoned about.

**Interface handed to task 5 (an asserted invariant):** the migration filename
`003_classifier_version.sql` exactly as it appears in `MIGRATIONS`, and the fact that
`copyMigrations()` in `build.ts` copies every `.sql` file in the source directory, so 003 arrives in
`dist/migrations/` without a build change.

### Task 5 — The licence, the third-party notice, and the packaging assertions

Repository root and `packages/desktop`. **Lands after task 4**, because `REQUIRED` names migration
003 and `package-app.ts` throws on an entry that is not a non-empty file.

**These are facts about artifacts and licence texts, and obligations the user has already decided to
meet. No legal advice is offered and none is implied.**

- [ ] A `LICENSE` file at the repository root, **MIT**. There is none today, which `package-app.ts`'s
      own docblock records. MIT is compatible with the LGPL-2.1 dependency because LGPL's obligations
      attach to the library rather than to the code that uses it.
- [ ] **The copyright holder is a name, and a name is not something an implementation task invents.**
      If the exact line is not already settled, ask rather than guess — this is one of the two places
      in F where the right move is to stop. **It is open question 14**, listed there as well as here
      because the open-questions list is where an executor looks for blockers and a task that can
      block on a human decision has to appear in it.
- [ ] `THIRD-PARTY-NOTICES.md` at the root, naming `occt-import-js@0.0.23`, its LGPL-2.1 licence,
      OpenCascade underneath it, and pointing at the three licence texts that ship beside it. **The
      texts themselves ship** — `LICENSE.md`, `dist/license.occt-import-js.txt` (27 030 B) and
      `dist/license.occt.txt` (26 936 B), 54 KB in total — because copying them is cheaper than
      referencing files inside a `node_modules` the packaged app does not have.
- [ ] **Read `node_modules/occt-import-js/dist/license.occt.txt` after `deno install` and record in
      the notice what §6 of the shipped text actually says** (spec 6.1). An earlier draft of the spec
      claimed it carries no static-linking exception and **withdrew the claim**: the word "exception"
      appears nowhere in the 1 163-line spike, which asked what the licence _is_ and never what it
      _excepts_. **The obligations do not move either way** — an exception can only loosen the relink
      condition, and the three artifacts here already meet the stricter reading — which is why this is
      a thing to record rather than a thing to wait on.
- [ ] Stage the notice and the three texts into the packaged app, in the shape `copyMigrations()` and
      `copyIcons()` already have, into `packages/desktop/dist/third-party/`. The `.wasm` is already
      staged by task 1 and is not staged twice.
- [ ] **asar is already off, and the replaceability is asserted rather than inferred** (F-13).
      `package-app.ts` passes `asar: false` with a docblock that argues for it deliberately, so
      `resources/app` is a plain directory tree and any `.wasm` staged into it is already an ordinary
      file a user can replace — **the property the obligation wants holds today, by a decision made
      for an unrelated reason.** The same docblock says an installer "would want both of those
      inverted" and calls turning asar on "two lines in this file", so the assumption that it stays
      off is exactly the kind that expires quietly. If asar is ever turned on, the `.wasm` and the
      licence texts go in `asarUnpack` and the assertion below keeps passing unchanged. Say that in
      the `REQUIRED` docblock.
- [ ] **`REQUIRED` moves into `packaging.ts` first, and then gains its five entries** (decision 16).
      The list at `package-app.ts:232-257` becomes
      `export function requiredArtifacts(outDir: string, appDir: string, executable: string): string[]`
      in `packages/desktop/packaging.ts`, comments and all; `package-app.ts` imports it, calls it
      where the array used to be, and keeps the `for (const file of REQUIRED)` loop that stats them.
      **Size it as a real change, because it is one:** ~35 lines relocated, one `node:path` import
      added to `packaging.ts`, one call site. Nothing about what is checked changes.
- [ ] **Why the move is in this task rather than skipped:** `package-app.ts` cannot be imported —
      "it packages an application as a side effect of being imported", which is `packaging.ts`'s own
      stated reason for existing — so as long as the list lives there, **no test can read it**, and
      `packaging.test.ts` today asserts `packagedExecutableName`, `APP_NAME` and `APP_SLUG` and
      nothing about `REQUIRED`. And nothing else covers it: **`deno task package:desktop` is run by
      no CI job** — all eight run `ubuntu-latest` and none of them packages — so the five entries
      would otherwise be text that one manual Windows run checks. `packaging.ts`'s docblock already
      describes itself as "the names `package-app.ts` gives what it writes", which is what the list
      is.
- [ ] The list gains **five** entries — three new and two that have always been missing:

```ts
join(appDir, 'dist', 'occt-import-js.wasm'),
join(appDir, 'dist', 'third-party', 'THIRD-PARTY-NOTICES.md'),
join(appDir, 'dist', 'third-party', 'LICENSE.md'),
join(appDir, 'dist', 'migrations', '002_preview_claim.sql'),
join(appDir, 'dist', 'migrations', '003_classifier_version.sql'),
```

- [ ] **The two migrations are a consistency fix F carries rather than a defect it found.** `REQUIRED`
      names `001_init.sql` alone (`:241`) and 002 has never been in it. The list's own docblock says
      the failure it exists to prevent is "one that opens and cannot open a library", and a missing
      migration file is exactly that: `runMigrations` reads a frozen list and `readFileSync` throws on
      the first file that is not there, so a staging that dropped 002 produces an app that starts and
      fails the moment a folder is picked. `001` alone is a spot-check that `copyMigrations` ran at
      all, not that it finished.
- [ ] **Name the cost of that decision in the docblock, because it is the reason someone might not
      take it:** the list now has to be edited with every migration for ever, and the next one to be
      forgotten will be forgotten the same way 002 was. The durable fix is to derive the check from
      core's `MIGRATIONS` rather than respell the filenames — the same "read rather than copied" rule
      task 4 applies to the classification rule — but that changes `REQUIRED` from a list of paths
      into something that imports from `core`, and **F is not the change that should do it.** Record
      it as what to do if a fourth is ever missed.
- [ ] **Rewrite the `appCopyright` docblock in `package-app.ts`** (spec 5.7, constraint 14). It says
      "**There is no LICENSE file and no `author` field anywhere in this repo**", and that is the
      stated reason `appCopyright` is omitted and `LegalCopyright` in the shipped executable currently
      says Electron's. False the moment the `LICENSE` lands. **The docblock must be rewritten either
      way** — either to state a copyright line or to state a better reason for not having one — and
      which of those is open question 7. Do not leave the sentence standing.
- [ ] Tests, `packages/desktop/test/packaging.test.ts`, which can now reach the list because of the
      move above. Two assertions, in the shape of the `APP_NAME`/`APP_SLUG` case already there:
      `requiredArtifacts('out', join('out', 'resources', 'app'), 'x.exe')` contains a path ending
      `dist/occt-import-js.wasm`, both third-party files, and **all three** migrations — asserted per
      entry, not as a count, for the reason the icons are named individually rather than counted; and
      every returned path starts with the `outDir` it was given, so an entry that forgets to join
      cannot pass. It runs under `deno task test:desktop:unit`, which **is** a CI job.
- [ ] **And the packaging run stays the other half, because the unit test cannot replace it.** The
      unit assertion says the list names the files; only `deno task package:desktop` says the build
      wrote them. Prove that half can fail the way the Definition of done requires: delete one staged
      file from a built output and confirm `package:desktop` throws naming it. **That run is manual
      and on Windows** — no CI job packages — so it is a step in this task and a line in the
      Definition of done, not something CI will catch if it is skipped.
- [ ] Tests, the licence artifacts exist and are non-empty at the repository root: `LICENSE` and
      `THIRD-PARTY-NOTICES.md`. A one-line assertion, and it is worth having because both are files
      nothing imports — the class of file a build can stop producing without breaking a bundle or a
      test that watches imports, which is the same reasoning `favicon.svg` and `manifest.webmanifest`
      are already in `REQUIRED` for.

---

## Open questions

The spec's §10 has sixteen. Questions 1–13 are the ones of those that reach a task; **14 and 15 are
this plan's own** — neither is in the spec's §10, and both are here because an executor reads this
list for blockers and both can stop a task dead. **None of them is resolved here.** Each says what an
implementer should do on meeting it mid-flight, and for two of them the answer is specifically
"nothing in F changes".

1. **What does Ctrl+S propose in each slicer's GUI for a STEP input?** **Unmeasured**, and it is the
   question that decides whether STEP could ever take the in-place branch. The probe could not deliver
   a keystroke: `GetForegroundWindow()` returned `0` for the whole session, the workaround that
   cleared the same wall on 2026-08-28 did not help, and the cause is undiagnosed. F-6 ships the
   conservative branch, which is also the status quo and therefore costs nothing. **On a measurement
   arriving mid-flight:** **do nothing in F.** Even if all four slicers propose a name that is not the
   source's, moving STEP onto the no-copy branch is a one-line change in `#prepare` with its own test
   (task 3's launch-path assertion is what would notice it happening silently), and it should be its
   own change with the measurement attached — not a passenger on a subsystem whose plan says the
   opposite. Record the measurement, leave the branch.
2. **What does a STEP file much larger than 1.39 MB cost, and does it fail gracefully?**
   **Unmeasured**, and the single biggest gap in the memory story. The intercept dominates the
   measured range so completely that the slope "could be off by an order of magnitude in either
   direction and this data would not notice". **On a measurement arriving mid-flight:** something
   specific — `DEFAULT_MAX_STEP_BYTES` is one constant in one place and it moves with the evidence,
   and task 2's docblock is where the new arithmetic goes. **But note that raising it is
   forward-only**: the rows the old number condemned are `failed` and terminal, and only a change to a
   file's bytes brings one back. That is a reason to prefer erring high on the constant, not a reason
   to trust it.
3. **What does a process that does both a large mesh and a STEP parse peak at?** **Unmeasured.** The
   400–410 MB backfill figure and the 244 MB STEP figure come from processes that each did one thing;
   they are not additive and not independent. **On meeting it:** the direction is up and F puts no
   number on it. Do not invent one for a docblock — task 1's concurrency ≥ 2 line is already labelled
   as arithmetic rather than measurement, and that labelling is the point.
4. **What does a STEP parse cost a Chromium tab?** **Unmeasured**, and the prerequisite for the
   viewer. Beyond the number there is a modelling question the harness cannot answer: `peakCost` has
   no intercept and STEP is almost all intercept, so `ModelFormat` itself would have to change. **On
   meeting it:** do not add a `'.step'` row to `FORMATS`. The `FORMATS` docblock records three costs
   that were wrong for exactly the Node-RSS-for-Chromium substitution that would be made without the
   harness.
5. **Does a slicer saving from a STEP input write into a subdirectory?** **Unmeasured**, and it
   decides whether the launch-directory flow actually closes. `#scan` reads one level and files only,
   so a project saved into `<launch dir>/foo/` is invisible to the session list. The one data point is
   Anycubic's measured `stl/obj_1_….stl`, which is exactly that shape and was produced by an export
   flag rather than by a save. **On meeting it:** the fix is a decision about `#scan`'s depth and it
   **belongs to D, not to a `.step` special case.** Do not add a STEP-shaped exception to `#scan`.
6. **What re-pends a `model → other` reclassification?** F re-pends on a kind change, which is right
   for `other → model`; the reverse leaves a `ready` row with a PNG for a file the viewer no longer
   offers. **No change in F causes it. On meeting it:** decide it when something actually causes it,
   and do not guess at it now — task 4's comment says so at the branch.
7. **Does `LegalCopyright` change once a LICENSE exists?** **A decision, not a measurement.**
   `package-app.ts` omits `appCopyright` _because_ there is no LICENSE and no author, and argues that
   leaving Electron's notice is a true statement about the compiled code. With MIT and a named holder
   that argument no longer applies unchanged. **On meeting it:** the docblock must be rewritten either
   way; which way is the user's call, not the implementer's.
8. **Is the 10 MB ceiling right?** **A judgement standing on a barely-constrained slope**, labelled as
   one in the constant's docblock. Real CAD exports reach tens of megabytes, so the first user with a
   30 MB assembly is the measurement. **On meeting it:** folded into question 2.
9. **Should the STEP parse move off the queue's thread?** **Designed against, not settled** (F-10). A
   worker thread would keep the Electron main process responsive during a measured 217–1 307 ms
   synchronous parse and would **not** reduce the memory; a child process would isolate the floor and
   pay it per file. **On meeting perceptible jank:** it moves with question 2 — if large files turn
   out to be affordable and slow, the child-process option changes from "wasteful" to "the only way to
   contain a blast radius". Do not build either as a passenger on F.
10. **Does esbuild bundle the emscripten glue for the Electron main process?** **Unmeasured**, and the
    one implementation risk that could turn a small task into a large one. **On meeting it:** the
    fallback is known — external, stage the glue beside the `.wasm`, `createRequire`, explicit
    `locateFile` — and it is what F-13 requires anyway, so the licence obligation and the likely
    implementation point the same direction. Task 1's first bullet is to settle this before anything
    else is written.
11. **Does `minimumDependencyAge` interact with CI as well as with the developer's machine?**
    **Unmeasured.** CI runs `deno install --allow-scripts --frozen` in eight jobs and whether `--frozen`
    consults the age gate is not something this repository has been in a position to find out.
    `0.0.23` is long-published, so the likely answer is that nothing happens. **On meeting eight red
    jobs with one cause and no obvious relation to the change:** the remedy is a one-line entry in
    `deno.json`'s `exclude`, which takes package names and not versions.
12. **macOS and Linux.** **Unmeasured, entirely**, as they were for D and E. Everything
    platform-shaped here is Windows: which slicers exist and where, the `cwd` incident, the packaging
    layout, and the memory figures (`maxRSS` maps to `PeakWorkingSetSize` on Windows and to a different
    quantity elsewhere). **On meeting it:** ship what was measured and say so. Do not design a
    non-Windows path from inference.
13. **What does a `spm://` thumbnail request do during the block, and what happens if the user quits
    mid-parse?** **Both unmeasured**, and they are different reports rather than two readings of
    "perceptible": a stall a user waits through, and a window that will not close because `will-quit`
    cannot be dispatched until the parse returns. **On meeting either:** it is evidence for question 9
    and is not a reason to add a timeout, a cancel path or a second thread inside F.
14. **What is the copyright holder's name?** **A decision, and the only one in F that blocks a
    task on a human.** Task 5 writes a `LICENSE` and the Definition of done asserts it exists, and
    MIT's text carries a year and a named holder — which an implementation task cannot invent and
    must not guess. Spec 10.11 is the neighbouring question and is not this one: it asks whether
    `LegalCopyright` in the shipped executable changes once a LICENSE exists, which presumes the
    holder is known. **On meeting it: stop and ask.** There is no defensible default — not the git
    author, not the repository name, not "the contributors" — and every other bullet in task 5 can
    be finished while the answer is outstanding.
15. **Does the published `occt-import-js@0.0.23` tarball carry its own `cube.stp`?** Everything in
    §5.3 says yes — the spike measured that file at 8 247 bytes out of a plain `npm install` of this
    exact version, and the package ships 123 files including its C++ sources — but the plan has not
    re-run `deno install` to confirm the path, and **decision 13 makes it the only STEP fixture the
    eight CI jobs can reach**. Task 1's first bullet settles it in the same breath as the esbuild
    question, before anything is written. **On finding it absent:** stop. Every alternative is a
    decision somebody else has to make — committing a third-party model with unrecorded provenance
    and licence into a subsystem that is adding a third-party notice, or shipping the STEP tests as
    something CI cannot run. Do not pick one while implementing.

---

## Definition of done

- `deno task verify` green, `deno task test:desktop` green, `deno task e2e` green, CI green on `main`
  across all eight jobs, with `deno.lock` committed.
- `deno task package:desktop` green, with `dist/occt-import-js.wasm`, the notice, the LGPL text and
  **all three** migrations present and non-empty in the built output, asserted by `requiredArtifacts`.
  **This is a manual run on Windows** — no CI job packages — so it is checked by whoever finishes
  task 5, and the unit half of it (`packaging.test.ts` over `requiredArtifacts`) is what CI carries.
- `deno task build:desktop` fails if the `.wasm` was not staged, because `build.ts`'s own
  `assertWritten` names it — the build-time twin of the line above, and the one that runs inside
  `deno task dev:desktop`.
- **A STEP thumbnail renders in `deno task dev:desktop`**, not only under `node --test`. The Electron
  bundle is the one of the three targets that was never measured.
- `git log --oneline` shows the commit adding `case '.step':` to `readMesh` **before** the commit
  adding `CLASSIFIER_VERSION`, and the commit adding `CLASSIFIER_VERSION` after the one adding
  `MeshLimits.maxStepBytes`. Constraint 8, checkable without reading a diff.
- A library whose `files` rows predate the mechanism, opened by this build, ends with every `.step`
  and `.stp` file at `kind: 'model'` with a `ready` preview row and a PNG — and a **second** rescan
  over the same untouched library reclassifies nothing and queues nothing.
- A database migrated from `user_version = 2` has `classified_by = 0` on every row, and the test that
  says so asserts `0 < CLASSIFIER_VERSION` rather than `CLASSIFIER_VERSION === 1`.
- A `.step` file launched into Cura throws `AppError('Validation')` with `details.slicerId === 'cura'`
  and the spawn recorder's call count is **zero**; the same file into each of the other four spawns.
- Every spawn in `slicers-launch.test.ts` asserts a `cwd` **by value**, for both the launch-directory
  path and the in-place path, and the in-place assertion checks the directory **exists at the moment
  of the spawn**.
- A `.stp` file that is not STEP leaves a `failed` row **with a message** (task 1's row bullet), and a
  `.step` file over `SPM_MAX_STEP_MB` leaves a `failed` row with a message naming both sizes (task 2's
  row bullet) — **asserted as rows, not as thrown errors.** Both tasks also assert the throw at the
  unit level; neither of those unit assertions satisfies this line.
- No `.step` or `.stp` file anywhere in the test corpus reaches `unsupported`.
- The seven docblocks in spec 5.7, the **one** comment in spec 7.2 (task 4 says why the spec's prose
  says two), the two docblocks no spec section lists — `desktop/src/previews.ts:74` and
  `server/src/env.ts:160` — and the README at `:36`, `:37` and its whole preview-memory section have
  all been corrected, each in the commit that falsified it, and none of them claims that
  `DEFAULT_MAX_MESH_BYTES` or `SPM_MAX_MESH_MB` bounds a STEP parse.
- `LICENSE` and `THIRD-PARTY-NOTICES.md` exist at the repository root, and `package-app.ts` no longer
  says there is no LICENSE file in this repo.
- Nothing in `packages/web` changed except one comment.
