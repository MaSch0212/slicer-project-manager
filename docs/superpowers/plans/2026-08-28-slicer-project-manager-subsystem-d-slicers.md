# Slicer Project Manager — Subsystem D: slicer configuration and launching

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to
> implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** turn a library entry into a running slicer. Detect what is installed, let the user bind a
product to an install, open a slicer project as-is, start a new one from any file with the
authoring slicer's configuration stripped out, and — in remote mode, where there is no local path —
download, launch, watch and offer back whatever the slicer wrote.

**Architecture:** three additive pure modules in `packages/core` (a ZIP rewriter, the strip
registry, and change detection — reachable from no server route); everything else in
`packages/desktop` — a static slicer registry, a one-shot PowerShell detector, `slicers.json`
beside `state.json` in `userData`, and a launcher whose `spawn` is injected. `packages/web` gains
one electron-only route and one capability-gated link. `packages/contract` gains a `slicers` block
on `ApiClient`, reached over `SHELL_CLIENT` because it must work in both library modes.

**Spec:** [`2026-08-28-slicer-project-manager-subsystem-d-slicers.md`](../specs/2026-08-28-slicer-project-manager-subsystem-d-slicers.md)
— references of the form "spec 3.4" are to it. Its parent,
[`2026-08-22-slicer-project-manager-design.md`](../specs/2026-08-22-slicer-project-manager-design.md),
is binding: where D and the parent disagree, the parent wins.

**Measurements:** `.superpowers/spikes/2026-08-28-slicer-launch-facts.md`, Parts 1 and 2, five
installed slicers on one Windows 11 machine.

**Prior plans:** [A](2026-08-22-slicer-project-manager-subsystem-a.md),
[B1](2026-08-23-slicer-project-manager-subsystem-b1-rasterizer.md),
[B1 follow-ups](2026-08-24-slicer-project-manager-b1-followups.md),
[B2](2026-08-25-slicer-project-manager-subsystem-b2-viewer.md),
[C](2026-08-26-slicer-project-manager-subsystem-c-electron.md).

---

## What was measured before this plan was written

Every row was run and observed, not read in vendor documentation. **A task that contradicts one of
these is wrong.**

| Question                                                | Measured                                                                                                                                                             |
| ------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| How does a file reach a slicer?                         | A bare path as `argv[1]`. All five. No flag, no refusal                                                                                                              |
| Does a successful spawn mean the file opened?           | **No.** Anycubic silently discarded a `.3mf` — window up, plate empty, no error. Three of five never show a filename in the title                                    |
| Does a slicer hold a handle on the file it opened?      | **No.** Exclusive read and rename succeeded on all five; exclusive read/write on the four it was run against                                                         |
| Does opening a file modify it, or its folder?           | No. No mtime change, no new files, no sidecars, no locks. Autosave goes to `%TEMP%\<slicer>_model\…`                                                                 |
| What does Ctrl+S target?                                | PrusaSlicer, Anycubic, Bambu, Orca: **in place, silently**. **Cura: always Save-As**, never in place                                                                 |
| Where does Cura propose to save?                        | A sticky global directory from `%APPDATA%\cura\<ver>\cura.cfg` `dialog_save_path` — **currently a real folder inside the user's model library**                      |
| Are whole-file hashes a change detector?                | **No.** All four in-place savers produce a different container hash for identical content — three from wall-clock ZIP timestamps, PrusaSlicer from a payload comment |
| Is mtime one?                                           | **No, in both directions.** The four in-place savers skip the write when nothing is dirty; Cura's re-save of identical content moved mtime                           |
| Is deleting the temp file while a slicer holds it safe? | **Yes** — and **the file reappears complete at the same path** on the next Ctrl+S (PrusaSlicer, Anycubic, Bambu, Orca)                                               |
| Does stripping suppress the adopt prompt?               | **Per-slicer, two of five.** Cura: gone. Anycubic: a silent discard becomes a clean load. Orca: two modals become one. PrusaSlicer and Bambu: unchanged              |
| What happens on a half-strip?                           | Removing `slice_info.config` alone yields `slicer_project` with `slicer: null` — worse than either end state — and the foreign profiles are adopted anyway           |
| Must thumbnails be stripped?                            | No. `plate_*.png`, `pick_*.png`, `top_*.png`, `Metadata/thumbnail.png` survived every successful strip                                                               |
| Which detection mechanism finds every install?          | **None alone.** Registry uninstall keys find 5 of 6; `Get-AppxPackage` is the only thing that sees OrcaSlicer                                                        |
| Which registry field names the executable?              | `DisplayIcon`. **`InstallLocation` is empty for four of the five keys.** Cura registers under `WOW6432Node`, so all three hives must be read                         |
| Is an install a product?                                | **No.** This machine has two Curas — two keys, two directories, three processes at once. An install is a `(path, version)` pair                                      |
| Is a slicer's path stable?                              | **Not Orca's.** `…\WindowsApps\OrcaSlicer.OrcaSlicer_2.4.3.0_x64__3qd7h69xpne0g\` embeds the version                                                                 |
| Can a version be read off the executable?               | Not for Cura or Orca — both have an **empty version resource**                                                                                                       |
| Is there a real slicer fixture in this repo?            | **No.** `packages/core/test/fixtures/` holds generators only                                                                                                         |

The last row is why spec 9.2 says one thing cannot be tested here: whether stripping actually stops
a slicer prompting. Generated archives prove the rewriter works, not that Cura is satisfied. Rows
about prompts stay measured facts carried by the spec, and **no task may claim a test covers them.**

---

## Scope

| In this plan                                                                            | Not in this plan                          |
| --------------------------------------------------------------------------------------- | ----------------------------------------- |
| `packages/core`: an entry-preserving ZIP rewriter, the strip registry, change detection | Any change to `classify.ts`               |
| The slicer registry, Windows detection, `slicers.json`                                  | macOS and Linux detection or launching    |
| `/settings/slicers`, and the `canLaunchSlicer` / `canConfigureSlicers` flip             | The embedded model browser (spec E)       |
| Open-as-is and new-project-from-a-file, local mode                                      | Writing to any slicer's own configuration |
| Remote mode's download-launch-watch-reconcile, with Cura's limit stated                 | Headless slicing, G-code, profile reading |
| Session listing, orphan surfacing, user-answered reconcile                              | Installers, code signing, auto-update     |

**Deliberately deferred, with reasons:**

- **macOS and Linux.** The spikes ran on Windows 11 only, and spec 2.1 expects parts of detection
  and launching to _invert_ on macOS (`open -a` returns no child pid; a document-open AppleEvent to
  a running app is the default). D ships Windows behind a named seam and reports
  `detectionSupported: false` elsewhere, which is the honest degradation.
- **Start Menu `.lnk` targets and `Program Files` globs.** Measured as usable corroboration and
  rejected anyway: they add a second and third way to produce a path the app will later _execute_,
  for a case that did not occur on the measured machine. Manual entry (spec 4.5) covers the same
  gap with the user's own consent instead of a heuristic.
- **`classify.ts` adopting the `Application` metadata in `3D/3dmodel.model`.** A stronger
  provenance signal that survives stripping — and adopting it would reclassify files already
  indexed in every existing library, which is a change to the server's observable behaviour. Its
  own measured change, not a passenger on D.

---

## Global constraints

A reviewer should treat a violation as a defect regardless of what a task says. 1–7 are carried
from the C plan and still bind; 8–11 are D's own.

1. **The renderer is the existing Angular app, unmodified except at the named seams** —
   `API_CLIENT`, `SHELL_CLIENT` (`packages/web/src/app/features/desktop/shell-client.token.ts`),
   `routes.electron.ts`, and one capability-gated link on `features/settings/settings.page.ts`. A
   component that has to know it is running in Electron is a design failure.
2. **No change to how the Deno server behaves.** Core's new modules are imported by no route, the
   route table is untouched, and the server's DTOs are unchanged. Assert it (task 1).
3. **The main process is the only thing that touches the filesystem, the database or a
   subprocess.** `nodeIntegration: false`, `contextIsolation: true`, `sandbox: true` stay as they
   are.
4. **Every IPC channel validates its input in the main process, and the renderer never names a
   filesystem location.** `slicers.open` takes a `fileId` and a `projectId`, never a path. The
   preload already strips `localPath` from every argument at every depth
   (`packages/desktop/src/sanitise-args.ts`) — do not add an exception, and no change to that file
   is needed.
5. **Errors keep their identity across the boundary.** `AppError.code` survives; a refusal arrives
   as an `AppError` the UI can switch on.
6. **`deno task verify` stays green**, and the contract typechecks at the end of every task — see
   decision 8 on why the `slicers` interface grows in three instalments rather than one.
7. **Every assertion must be able to fail** — break the code it covers, confirm red, restore.
   Assert the path that was spawned, not that a spawn happened.
8. **The app never writes into the user's library folder as a side effect of launching a slicer.**
   Launch artefacts live in `<userData>/slicer-sessions/`. The only write into the library is a
   `files.upload` the user explicitly asked for. This generalises the data-loss path spec 6.2
   found: a `model`-kind `.3mf` handed to a slicer in place gets the slicer's project proposed
   **over the user's mesh**.
9. **Never half-strip, and never fall back to launching the original.** The strip is
   all-or-nothing per flavour — a half-strip measurably leaves the foreign profiles _and_ produces
   an unattributable file. A failed strip refuses to launch, and the message names which of the
   three reasons it was: encrypted, unreadable, or configuration left behind.
10. **The next-start sweep surfaces and never deletes.** A file with no record is an unfinished
    session, not litter. `launch.json` outlives the file it describes. Nothing is deleted that the
    app has not compared and the user has not seen.
11. **A spawn is not evidence the file opened.** The UI says "Handed _file_ to _slicer_", never
    "opened in your slicer". The only observable fact is whether the spawned process is alive, and
    even that is not "the slicer was closed".

---

## Decisions taken up front

1. **The strip set is indexed by the flavour of the _file_, not by the slicer being launched.**
   What can be removed is whatever the authoring slicer put in; the launched slicer only determines
   what the user then sees. _Rejected:_ a `strip` field on `SlicerDef`, which is a `SlicerId`-keyed
   table and therefore cannot express the parent §3.4 rule-4 case — a classification with no
   `SlicerId` at all. The strip sets have exactly one home, in `packages/core`.
2. **The rewriter copies compressed bytes verbatim and emits a non-zip64 directory when the values
   fit.** _Rejected:_ refusing zip64 outright, which an earlier spec draft did — 28 zip64 files in
   the reference library classify as `model`, all between 1,620 B and 7.75 MB, so every size and
   offset fits in 32 bits. Also rejected: a decompress/recompress round trip, which would change
   payload bytes for no gain.
3. **One CRC table and one header layout in the repo.** `packages/core/test/fixtures/make-3mf.ts`
   already has a `writeZip` and a `crc32`; the table and the two header layouts move into
   `src/files/zip-write.ts` and the fixture imports them. _Rejected:_ leaving the fixture alone,
   which leaves two ZIP writers that must stay in sync and no test that they do. The fixture keeps
   its own job — building an archive from scratch with fresh compression — and its `Zip64Options`
   surface is untouched, because task 1's tests need exactly those switches.
4. **`slicers.json`, not `state.json`.** Slicer configuration is a list rewritten by every scan and
   every binding change; `state.json` is three keys written when a user answers a question about
   which library there is. They share a **writer**, not a file: `state.ts`'s atomic
   write-temp/fsync/rename moves to a `json-store.ts` both call. _Rejected:_ a fourth key in
   `state.json`, where one corrupt write costs the user their slicer bindings _and_ their library
   choice.
5. **One PowerShell subprocess emitting one JSON document, on demand.** `Get-AppxPackage` forces
   PowerShell anyway, `reg.exe` cannot express the MSIX half, and one subprocess is one failure
   mode, one timeout and one parse to test. _Rejected:_ two mechanisms in two processes; and
   detection at app start, which costs hundreds of milliseconds before a user has asked for
   anything, while a stale path is caught by a `stat` before every spawn regardless.
6. **The stored identity of an install is its origin key; the path is a hint.** Orca's install path
   embeds its version, so a cached path breaks silently on update and the failure mode is a spawn
   into a hole. _Rejected:_ storing the path as the identity.
7. **The seam is `SHELL_CLIENT`, the methods go on `ApiClient`, and every entry is a `shellCall`.**
   `API_CLIENT` is whatever transport the _library_ is on, and in remote mode that is
   `HttpApiClient`. `libraryCall` refuses a null session by design, and in remote mode
   `deps.session` is null — so a `libraryCall` slicer entry cannot work at all. `HttpApiClient`
   refuses every slicer method with `AppError('Forbidden', …)`, exactly as it does `library.pick`.
   8b. **`bind` and `setDefault` take `null`,** which spec 8.3 says and the task briefs left out.
   Task 2 implemented them non-null because nothing asked, and the whole-branch review found it
   against the documents rather than against a request. Restored in the implementation and stated
   here: unbinding a product is the only way back from a binding the app made by itself, and
   clearing a default is otherwise impossible once one is set. _Rejected:_ leaving them non-null
   and recording that a default is only ever replaced — which is a smaller edit and describes a
   setting with no way out.

8. **The `slicers` interface grows in three instalments, one per task that implements it.**
   `DispatchTable` is a mapped type over `ApiClient`, so a method added to the interface without a
   dispatch entry fails `deno task typecheck` — which is the guarantee we want, and which means the
   contract addition must be atomic with its implementation. Task 2 adds the seven configuration
   methods, task 4 adds `open`, task 5 adds `sessions` / `resolveSession` / `discardSessions`.
   _Rejected:_ adding the whole block in task 2, which leaves three tasks' worth of red typecheck.
9. **`spawn` and the detection subprocess are injected**, the way `fetch` is injected into
   `remote.ts`. The launcher, the session lifecycle, the sweep rules and the reconcile decision are
   then testable under plain `node --test` with no slicer, no Electron and no Windows. _Rejected:_
   mocking `node:child_process`, which tests the mock.
10. **The returning file is added under a derived non-clashing name, never substituted.** A
    cross-slicer round trip is measurably lossy, so replacing the original destroys the only copy
    of something the user may not have meant to convert. _Rejected:_ `files.delete` then
    `files.upload` as the default — it is two existing calls with no core change, but the window
    between them means a failed upload leaves the user with neither file. Substitution is
    _ordered_, not barred: add first, delete second, with the control that already exists.

---

## Tasks

Five tasks. The split follows the dependency edges the code actually has: task 1 is pure and
dual-runtime and nothing above it can be written without it; task 2 is main-process state and
subprocess parsing with no UI; task 3 is the only Angular diff; task 4 is the launcher; task 5 is
the loop that reads what task 4 wrote. **Between task 4 and task 5 the app can create launch
directories it cannot yet reconcile** — that is stated rather than hidden, and task 5 closes it.

Two notes on form, learned the hard way while writing this: Prettier reflows markdown, and it is
**not idempotent for tables, fenced blocks or sub-lists nested inside a `- [ ]` item** — it
re-indents them further on every pass, so `deno task fmt:check` can never go green. Every table and
code block below therefore sits at column 0 between list segments, and no list is nested.

### Task 1 — The ZIP rewriter, the strip registry, and change detection

Everything in this task is in `packages/core`, pure, and reachable from **no server route**. It
runs under both `deno task test:core:node` and `deno task test:core:deno`.

- [ ] `packages/core/src/files/zip-write.ts`: an entry-preserving rewriter beside the existing
      reader (`files/zip.ts`, which provides `readZipEntries`, `findZipEntry`, `readZipEntryBytes`,
      `readZipEntryText` and `openZip`, and which has **no writer in `src` at all**). It takes an
      input path, a set of entry names to drop, and a map of entry names to replacement bytes, and
      writes a new archive.
- [ ] Rewriter rule: surviving entries are copied **with their compressed bytes verbatim**. No
      decompress/recompress round trip. `stored` (method 0) and `deflate` (method 8) both work, and
      the operation costs one linear copy.
- [ ] Rewriter rule: **archive order is preserved and `[Content_Types].xml` stays first.** OPC
      requires the content-types item to be the first item in the package, and a rewriter that
      emits in central-directory order can silently move it.
- [ ] Rewriter rule: **general-purpose flag bit 3 (data descriptor) is cleared** — the rewriter
      writes real sizes into the local header, taken from the central directory, which always
      carries them. **Bit 11 (UTF-8 names) is preserved.** Every other bit is copied.
- [ ] Rewriter rule: a **non-zip64** central directory and EOCD are emitted whenever every size,
      offset and count fits in its 32-bit or 16-bit field, even when the input was zip64.
- [ ] Rewriter rule: replacement bytes are written **`stored`, with a recomputed CRC-32 and fresh
      sizes**. Carrying the original CRC over is the easy mistake and produces an archive most
      readers will still open until one does not.
- [ ] Rewriter rule: **refuse**, with an `AppError`, an entry with the encryption bit (bit 0) set,
      and an archive whose values genuinely do not fit what the rewriter can emit. Nothing else is
      a reason to refuse.
- [ ] Move the CRC-32 table, `crc32`, and the local-header and central-directory layouts out of
      `packages/core/test/fixtures/make-3mf.ts` into `zip-write.ts`, and have the fixture import
      them. The fixture keeps `writeZip`, `ZipInput`, `Zip64Options`, `concatBytes` and every
      `*Project` generator exactly as they are — its job (build from scratch, fresh compression) is
      not the rewriter's job, and its zip64 switches are what this task's own tests drive.
- [ ] `packages/core/src/files/strip3mf.ts`: the strip sets, the all-or-nothing operation over
      them, and the post-strip re-classification. **This is the one authoritative home for a strip
      set.** Import `classify3mf` from `./classify.ts` directly — note that the package barrel
      (`packages/core/src/index.ts`) exports `classifyFile` and `SLICER_HEADER_REGISTRY` but **not**
      `classify3mf`, and this task does not need to change that. The sets are the table below.

| File classified as                                                   | Entries removed                                                                                                                                                           |
| -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `cura`                                                               | every entry whose name begins `Cura/`                                                                                                                                     |
| `prusaslicer`                                                        | `Metadata/Slic3r_PE.config`, `Metadata/Slic3r_PE_model.config`                                                                                                            |
| `anycubic`, `bambu`, `orca`, or `slicer_project` with `slicer: null` | `Metadata/slice_info.config`, `Metadata/project_settings.config`, `Metadata/model_settings.config`, `Metadata/custom_gcode_per_layer.xml`, `Metadata/cut_information.xml` |
| `model`                                                              | nothing — there is no configuration in it                                                                                                                                 |

- [ ] **Thumbnails and plate images are kept**: `plate_*.png`, `pick_*.png`, `top_*.png` and
      `Metadata/thumbnail.png` survived every successful strip and nothing prompted. This is not
      incidental — the embedded-thumbnail fast path is what gives essentially every project file a
      preview without rendering, so a strip that discarded the artwork would cost real UI.
- [ ] In `strip3mf.ts`: rewrite `_rels/*.xml` parts, dropping any `<Relationship>` whose `Target`
      names a removed part, and leave every other part alone. Check `[Content_Types].xml` for
      references to removed parts — in all five measured flavours it needs nothing, because it
      declares `Default Extension` entries only, but "five files did not need it" is not "the
      format does not require it".
- [ ] In `strip3mf.ts`: **after stripping, re-classify the output, and fail the strip when the
      result is not `kind: 'model'`.** A run-time check, not only a test. It is not theoretical: a
      `.3mf` carrying both `Cura/*` and `Metadata/Slic3r_PE.config` classifies `cura`, gets the
      Cura set, and comes out `prusaslicer`.
- [ ] `packages/core/src/files/entry-hash.ts`: change detection. It is here rather than in the
      desktop package because it is pure, it reads the same central directory `zip.ts` parses, and
      it belongs under core's dual-runtime suite — which also keeps task 5 about orchestration
      only. Two exports, `entryHash` and `entryDiff`, defined in the next two bullets.
- [ ] `entryHash(path)` — SHA-256 over, for each entry **in name order**: the entry name, then the
      **decompressed** bytes. It ignores local and central headers, timestamps, compression method
      and entry order. It **excludes, in `Metadata/Slic3r_PE.config`, the leading
      `; generated by … at … UTC` comment line**. For a file that is not a ZIP — an `.stl`, an
      `.obj` — it is a plain SHA-256 of the bytes.
- [ ] `entryDiff(a, b)` — `{ added: string[]; removed: string[]; changed: string[] }`, by entry
      name, over decompressed content. It reports **that** an entry changed, never which setting
      inside it changed.
- [ ] Export `strip3mf`, its result type, `entryHash` and `entryDiff` from
      `packages/core/src/index.ts`. Do not export the rewriter's internals.
- [ ] Tests, strip: a stripped file classifies `model` and **never** `slicer_project` with
      `slicer: null` — drive it from a fixture carrying all five Bambu-lineage entries, assert the
      output's classification, then delete one name from the set and confirm the assertion goes
      red; surviving entries are **byte-identical** to the originals, compared both decompressed
      and as stored compressed bytes, for a `stored` and a `deflate` entry; `[Content_Types].xml`
      is the first entry of the output when it was the first of the input; a `_rels` part that
      referenced a removed target no longer does, and its central-directory CRC-32 matches its
      actual bytes.
- [ ] Tests, rewriter: a zip64 input whose values fit produces a **readable non-zip64** output —
      build it with `make-3mf.ts`'s `Zip64Options`, read it back with `readZipEntries`, compare the
      entry list; an entry with the encryption bit set is **refused** with an `AppError` and no
      output file is left behind.
- [ ] Tests, change detection: two archives with identical entry content and different ZIP
      timestamps hash **equal**; two `Metadata/Slic3r_PE.config`s differing only in the
      generated-on line hash **equal**; one changed byte anywhere hashes **differently**;
      `entryDiff` over those two names the changed entry and leaves `added`/`removed` empty.
- [ ] Tests, constraint 2: assert that no file under `packages/server/src` transitively imports
      `zip-write.ts`, `strip3mf.ts` or `entry-hash.ts`, and that the server suite is unchanged.

**Interface handed to tasks 2–5:** `strip3mf`, `entryHash(path) => string` and `entryDiff(a, b)`
from `@spm/core`. The controller hands the exact exported signatures to the next task.

### Task 2 — The slicer registry, detection, and `slicers.json`

Main process only. No UI, no launching.

- [ ] Extract `state.ts`'s atomic writer into `packages/desktop/src/json-store.ts` — the
      write-temp / `fsync` / `rename` sequence, its temp-file cleanup, and its docblock's
      reasoning. `state.ts` keeps its own keys, its `readState` degradation, and every existing
      test in `packages/desktop/test/state.test.ts` **unchanged and passing**.
- [ ] `packages/desktop/src/slicers/registry.ts`: a static table, one row per `SlicerId`
      (`'cura' | 'prusaslicer' | 'anycubic' | 'bambu' | 'orca'`, already in
      `packages/contract/src/dtos.ts`). It is code, not configuration: every field is a measured
      property of the product and a user has no business editing any of it. Each row carries
      `displayName`, `argv(file) => [file]`, a `windows` sub-object and a `behaviour` sub-object.
      **There is deliberately no `strip` field** (decision 1). The measured values are the table
      below; `windows.displayNamePattern` matches the uninstall key's `DisplayName`.

| id            | `windows.exeName`        | `windows.msixPackageFamily`           | `DisplayName` matches | `savesInPlace` | `discardsForeignProjects` | `alwaysPromptsOn3mf` | `promptsWithoutOwnConfig` |
| ------------- | ------------------------ | ------------------------------------- | --------------------- | -------------- | ------------------------- | -------------------- | ------------------------- |
| `cura`        | `UltiMaker-Cura.exe`     | —                                     | `UltiMaker Cura`      | **false**      | false                     | false                | false                     |
| `prusaslicer` | `prusa-slicer.exe`       | —                                     | `PrusaSlicer`         | true           | false                     | **true**             | false                     |
| `anycubic`    | `AnycubicSlicerNext.exe` | —                                     | `AnycubicSlicerNext`  | true           | **true**                  | false                | false                     |
| `bambu`       | `bambu-studio.exe`       | —                                     | `Bambu Studio`        | true           | false                     | false                | **true**                  |
| `orca`        | `orca-slicer.exe`        | `OrcaSlicer.OrcaSlicer_3qd7h69xpne0g` | `OrcaSlicer`          | true           | false                     | false                | false                     |

- [ ] `packages/desktop/src/slicers/detect.ts`: **one** child process,
      `powershell -NoProfile -NonInteractive -Command <script>`, emitting a single JSON document
      covering both mechanisms, with a **20 s timeout** and the process killed on timeout. The
      subprocess is **injected as "a function that returns the JSON document"**, so the parse is
      testable with no PowerShell. The script reads the two mechanisms in the next two bullets and
      emits both; neither is optional and neither is sufficient.
- [ ] Mechanism one, **registry uninstall keys**: `Get-ItemProperty` over
      `HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\*`,
      `HKLM:\SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\*` and
      `HKCU:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\*`, taking `DisplayName`,
      `DisplayVersion` and **`DisplayIcon`**. All three hives: Cura registers under `WOW6432Node`
      despite being 64-bit. **Do not read `InstallLocation`** — it is empty for four of the five
      keys, and a detector built on it finds PrusaSlicer and nothing else.
- [ ] Mechanism two, **`Get-AppxPackage`** for the MSIX families named in the registry, reporting
      `PackageFamilyName`, `PackageFullName`, `Version` and `InstallLocation`. It is the only
      mechanism that sees OrcaSlicer at all — no uninstall key, no Start Menu shortcut, no
      `App Paths` entry, not on `PATH`, and not findable by a recursive filename search.
- [ ] Treat the detector's output as **untrusted input** — it names paths the app will later
      execute. Every returned path is validated before it is stored or offered: absolute, exists,
      is a regular file, and **its basename equals the registry row's `exeName`**. That last check
      is what stops `DisplayIcon` resolving to `CuraEngine.exe`, `prusa-gcodeviewer.exe`,
      `prusa-slicer-console.exe` or an uninstaller, all of which sit beside a real one. Strip a
      trailing `,<index>` and surrounding quotes from `DisplayIcon` before resolving: all five were
      bare paths here, and five files is not a specification.
- [ ] Versions come from `DisplayVersion` (registry) or the MSIX package `Version`, **never from
      the executable**: Cura's and Orca's version resources are empty.
- [ ] `packages/desktop/src/slicers/config.ts`: `slicers.json` in `app.getPath('userData')`,
      written through `json-store.ts`, shaped as the block below. `id` is `registry:<hive>:<key>`,
      `msix:<packageFamily>` or `manual:<generated id>` — **the origin key, never the path.**

```jsonc
{
  "version": 1,
  "installs": [
    {
      "id": "registry:HKLM\\WOW6432Node:UltiMaker Cura 5.12.0",
      "slicerId": "cura",
      "label": "UltiMaker Cura 5.12.0",
      "origin": { "kind": "registry", "hive": "HKLM\\WOW6432Node", "key": "UltiMaker Cura 5.12.0" },
      "version": "5.12.0",
      "pathHint": "C:\\Program Files\\UltiMaker Cura 5.12.0\\UltiMaker-Cura.exe",
      "addedAt": 1756382400000,
    },
  ],
  "bindings": { "cura": "registry:HKLM\\WOW6432Node:UltiMaker Cura 5.13.0" },
  "defaultSlicerId": "orca",
}
```

- [ ] Config semantics: a scan **merges**. New installs are added; ones that no longer resolve are
      **marked `missing`, never dropped**; manual entries are never touched; and **an existing
      binding is never re-pointed.** A scan that silently re-pointed a binding would undo the one
      decision D asks the user to make.
- [ ] Config semantics: a `SlicerId` with exactly one install is bound to it on first scan, because
      there is nothing to choose. A `SlicerId` with two is left **unbound** and the UI asks. **The
      app offers; it does not guess** — picking the newer one is exactly what the rejected
      file-association mechanism does.
- [ ] Config semantics: an **unrecognised `version`** means the app runs with no configured
      installs, says so, and **refuses to write over the file** until `slicers.resetConfig`. A
      downgrade quietly overwriting a newer config is worse than a feature being unavailable for
      one launch. An **unparseable** file degrades to "no configuration" with a warning in the log,
      exactly as `readState` does today, and for the same reason.
- [ ] `resolveInstall(installId)`: `stat` the `pathHint` and re-check its basename; on any mismatch
      re-resolve from the **origin key**, rewrite the hint, and only then hand a path back. When
      re-resolution finds nothing the install becomes `missing` and the caller is told the install
      is gone rather than spawning into a hole. The common case costs one `stat` and no subprocess.
- [ ] Manual entry: `dialog.showOpenDialog`, file mode, filtered to executables. Stored with
      `origin: manual` and its path used **verbatim** — the user named it, so the `exeName` check
      does not apply, though the file-exists check still does. This is the answer to every gap in
      detection: per-user installs, portable installs, a vendor whose `DisplayIcon` does not name
      the main executable, and any sixth slicer someone wants to point at a `.3mf`.
- [ ] Off Windows (`process.platform !== 'win32'`): detection is not run, `detectionSupported` is
      `false`, and manual entry is the only mechanism. Do not design anything else.
- [ ] Add to `packages/contract/src/api-client.ts` a `slicers` block with **seven** methods —
      `get()`, `scan()`, `addManual(slicerId)`, `remove(installId)`, `bind(slicerId, installId)`,
      `setDefault(slicerId)`, `resetConfig()` — plus `SlicerInstallDto` and `SlicerConfigDto` in
      `dtos.ts`, shaped as the block below. `addManual` resolves to `null` when the user cancels —
      not an error, exactly like `library.pick`.

```ts
type SlicerInstallDto = {
  id: string
  slicerId: SlicerId
  label: string
  version: string | null // null for a manual entry with no readable version
  path: string
  origin: 'registry' | 'msix' | 'manual'
  state: 'ok' | 'missing' // the hint failed and re-resolution found nothing
}

type SlicerConfigDto = {
  installs: SlicerInstallDto[]
  bindings: Partial<Record<SlicerId, string>>
  defaultSlicerId: SlicerId | null
  detectionSupported: boolean // false off Windows — the UI offers manual entry only
}
```

- [ ] Wire all seven into `packages/desktop/src/dispatch.ts` as **`shellCall`** entries, each with
      its own `z.tuple` schema, and add the corresponding methods to `ShellApi` (implemented by
      `ShellHost` in `app.ts`). **Not `libraryCall`**: in remote mode `deps.session` is null and
      `libraryCall` refuses a null session by design. Refuse all seven in
      `packages/web/src/app/core/api/http-api-client.ts` with `AppError('Forbidden', …)`, exactly
      as `library.pick` and `library.connect` already are.
- [ ] Tests, parsing: over a checked-in fixture of the spike's own PowerShell JSON, including
      **both Cura rows** and the **MSIX Orca row** — assert two `cura` installs with distinct ids
      and distinct versions, so a parser that collapses them fails; a `DisplayIcon` pointing at
      `CuraEngine.exe` produces **no** install for `cura`; a `DisplayIcon` written `"…exe",0`
      resolves to the bare path.
- [ ] Tests, the no-installs path: a fixture with nothing detected produces a `SlicerConfigDto`
      with an empty `installs` and every consumer behaves. It is the path the spike could not
      exercise against a real negative, so it is the one most likely to be wrong.
- [ ] Tests, merge and versioning: a merge over an existing config with a user binding leaves the
      binding **byte-identical**, adds the new install, and marks the vanished one `missing` —
      change the merge to drop unresolvable installs and confirm red; a `slicers.json` with
      `"version": 2` yields no installs **and the file on disk is unchanged** after a scan attempt,
      asserted on the bytes and not only on the return value.
- [ ] Tests, resolution and dispatch: `resolveInstall` with a stale `pathHint` calls the injected
      re-resolver exactly once and rewrites the hint, and with a good hint calls it **zero** times;
      the dispatch table's key set still **equals** `ApiClient`'s method set (the existing test);
      every new entry rejects a wrong argument tuple with `Validation`.

**Interface handed to task 3:** `SlicerConfigDto`, `SlicerInstallDto`, and the seven `slicers.*`
methods on `ApiClient`. **Handed to tasks 4–5:** `resolveInstall(installId)`, the registry table,
and the config reader and writer.

### Task 3 — `/settings/slicers`, and the capability flip

- [ ] Flip `canLaunchSlicer` and `canConfigureSlicers` to `true` in **both** desktop shell columns
      — `LOCAL_SHELL_CAPABILITIES` **and** `REMOTE_SHELL_CAPABILITIES` in
      `packages/desktop/src/capabilities.ts`. The browser column is untouched: the Deno server
      keeps reporting both false from `/api/capabilities`, and the union is what makes a desktop
      app pointed at that server able to launch a slicer anyway.
- [ ] **Fix the stale comment while you are there.** `LOCAL_SHELL_CAPABILITIES`' docblock currently
      says "When D flips `canLaunchSlicer` here it lights up in **both** modes with no other
      change". That is **wrong**: remote mode unions `REMOTE_SHELL_CAPABILITIES`
      (`packages/desktop/src/remote.ts:305`) and local mode returns `LOCAL_SHELL_CAPABILITIES`
      (`packages/desktop/src/shell.ts:170`), so flipping one leaves the other false. Replace the
      claim with what the code does.
- [ ] Update **four** assertions in `packages/desktop/test/capabilities.test.ts`: `:39` and `:50`
      (the two shell columns in one test), `:67` (the second `LOCAL_` deep-equal, in the local-mode
      test) and `:78` (the remote-mode union, which now carries the two flags through).
- [ ] Re-point the `:110` test — "a backend cannot veto a capability the shell has". It keeps
      passing untouched, but **its fixture stops distinguishing anything** for the two rows D
      flips. Point it at `canBrowseModelSites`, still false until E, so it goes on proving the
      property it was written for rather than asserting that true unions to true.
- [ ] Add `/settings/slicers` to `packages/web/src/app/routes.electron.ts`, under
      `./features/desktop/slicers/`, with `authGuard`, matching `/settings` in `routes.shared.ts`.
      In local mode `requiresAuth` is false and the guard passes on its first arm; in remote mode
      an unauthenticated window has no business anywhere but `/login`. Leave the `desktop` and
      `desktop/connect` routes and the `**` redirect exactly as they are.
- [ ] The page injects **`SHELL_CLIENT`** (`features/desktop/shell-client.token.ts`), not
      `API_CLIENT`, because slicer configuration is a shell concern that must work in both library
      modes. It shows detected and manual installs grouped by product with their versions and
      paths, the binding for each `SlicerId` where there is a choice, the default slicer, a rescan
      button, manual add and remove, and a reset control for an unreadable config. Where a
      `SlicerId` has two installs and no binding it **asks** rather than showing a default. Where
      `detectionSupported` is false it shows manual entry and says detection is Windows-only.
- [ ] Add a link to it from `packages/web/src/app/features/settings/settings.page.ts`, rendered
      only when `canConfigureSlicers` is true, read from `CapabilitiesStore` as every other
      affordance is. **The link is a `routerLink` string and nothing more:** `features/settings/`
      is shared code and must not import anything from `features/desktop/`. The target route does
      not exist in the web build at all, and the capability that gates it is false there, so it is
      never rendered — the capability model doing its job in place of a build-time condition.
- [ ] Add the new strings to **both** `packages/web/src/app/core/i18n/locales/en.json` and
      `de.json`. `Translations = typeof en` in `translate.service.ts`, so a key missing from `de` is
      a typecheck failure rather than a runtime one.
- [ ] Add a CI bundle-grep pair in `.github/workflows/ci.yml` for the new page's exported class
      name, mirroring the `DesktopConnectPage` pair at lines 95–106: the web bundle must **not**
      contain it, the electron bundle **must**. Grep the class name, not the module path — paths
      become hashed chunk names during bundling, so a path grep can never fail.
- [ ] Tests, capabilities: `capabilities.test.ts` asserts both shell columns **whole** after the
      flip, so a later task cannot quietly move a third flag; and the remote-mode union carries
      `canLaunchSlicer` and `canConfigureSlicers` through **from the shell column over a backend
      that reports both false** — the row spec 2.4 wrote the union for.
- [ ] Tests, the page, with a fake `SHELL_CLIENT` bridge: two `cura` installs with no binding
      render **two selectable rows carrying their distinct version strings** and no pre-selected
      value — assert the rendered text, not that a `<select>` exists; nothing detected still
      renders a usable page with a manual-add control; `detectionSupported: false` hides the rescan
      control and shows the Windows-only message.
- [ ] Tests, the link: **absent** when `canConfigureSlicers` is false and present when it is true —
      assert the rendered anchor and its `href`, not a signal's value.

### Task 4 — The local launch paths

- [ ] `packages/desktop/src/slicers/launch.ts`, with **`spawn` injected**. It resolves the install
      through task 2's `resolveInstall`, builds argv from the registry row's `argv(file)`, and
      returns the pid. Nothing in this file imports `electron`, so the whole of it runs under
      `node --test`.
- [ ] The launch directory: `<userData>/slicer-sessions/<launchId>/`, one per launch, holding the
      file and a `launch.json` recording
      `{ launchId, mode, projectId, fileId, slicerId, installId, fileName, launchedHash, startedAt }`,
      where `launchedHash` is task 1's `entryHash` of the file as launched. Self-describing,
      deleted with the directory, and it survives a crash — which matters, because task 5's rules
      have to work after one.
- [ ] **Path A, open as-is** (`mode: 'as-is'`), for a `kind: 'slicer_project'` file. The slicer
      named by `files.slicer` is launched against the file **unchanged**; when `slicer` is null the
      default is used and the response says which slicer was picked and why. In **local mode** this
      launches the real library path, resolved through core's `resolveFilePath` and so through
      `safeJoin` — no copy, no strip, no launch directory. Safe because nothing locks the file,
      opening it modifies neither the file nor its folder, and no litter appears beside it; useful
      because four of five slicers save back in place, so the work lands in the project folder and
      the next rescan indexes it with no involvement from D at all.
- [ ] **Path B, new project from a file** (`mode: 'new-project'`), for any file whatever its kind.
      The slicer is the user's choice, defaulting to `defaultSlicerId` — this path exists precisely
      because the target is usually _not_ the slicer that wrote the file. In local mode: classify
      the source with `classifyFile` from `@spm/core` (it handles `.stl` and `.obj` as `model` and
      delegates `.3mf` to `classify3mf`), then take one of the next two bullets.
- [ ] Path B, step 2: **if and only if the source is a `.stl` or an `.obj`**, launch it in place
      with no copy. Importing a mesh gives an untitled project in all five, and four of five
      propose `<basename>.3mf` **beside the model** on the first save, which puts the new project
      straight into the project folder where the rescan will find it. Copying it elsewhere would
      break that.
- [ ] Path B, step 3: **every other source goes through a launch directory** — the stripped copy
      where there is something to strip, a verbatim copy where there is not. The copy keeps the
      source's basename, because the basename is what four of five slicers propose on save and what
      Cura carries into its Save-As dialog.
- [ ] **Step 2 does not include a `.3mf`, and this is constraint 8.** A `model`-kind `.3mf` — 28 of
      them in the reference library — launched in place has the slicer propose to write its project
      **over the user's mesh**, and the overwrite prompt reads as "overwrite my project?", not
      "destroy the original mesh". It is copied into the launch directory like everything else.
- [ ] **A failed strip refuses to launch and never falls back to the original** (constraint 9). For
      Anycubic that fallback is precisely the silent-discard case: a spawned process, an empty
      plate, and nothing saying why. The message names which of the three reasons it was — an
      encrypted archive, an unreadable one, or a strip that left slicer configuration behind — and
      says that opening the file as-is from the other path remains available.
- [ ] `notices(slicerId, classification, stripped) => string[]` — a **function of the triple, not a
      lookup by slicer**. Getting that wrong loses two real cases, both in the table below. Mark
      the Bambu-stripped row **inferred** in a code comment: §20 established that Bambu's modal
      fires on the absence of its own `project_settings.config` and a stripped Bambu project has
      none, but that exact pairing was not run.

| Launched    | Source                                | Stripped | What the app says                                                                          |
| ----------- | ------------------------------------- | -------- | ------------------------------------------------------------------------------------------ |
| PrusaSlicer | any `.3mf`                            | either   | It will ask what to do with the file before opening it, and nothing loads until you answer |
| Bambu       | a project it did not author           | either   | It will say the config is invalid and load geometry only                                   |
| Bambu       | **its own project, stripped**         | yes      | The same modal — stripping _creates_ it here (inferred, not run)                           |
| Anycubic    | a Bambu-lineage project               | **no**   | It may discard the file without telling you                                                |
| Orca        | a project from another lineage slicer | no       | It will warn about the version and may rewrite print settings                              |
| Orca        | a project from another lineage slicer | yes      | One informational notice, "loading geometry data only"                                     |
| any         | any                                   | either   | A slicer can take up to a minute to show a window (measured 2 s to 35 s)                   |
| any         | any                                   | either   | It may open a configuration wizard or an update prompt in front of your model              |

- [ ] The **Cura hazard notice**, shown in **both** modes before launching Cura, once per session
      with a "don't show again": Cura never saves in place, its Save-As defaults to a sticky global
      directory that on the measured machine is a real folder inside the user's model library, and
      a user who presses Ctrl+S and Enter writes a copy into it. The launch still happens — Cura
      against a file is perfectly useful for viewing and slicing, and refusing would make the app
      less useful than having no feature.
- [ ] Add `slicers.open(fileId, projectId, opts)` to `ApiClient`, with
      `opts: { mode: 'as-is' | 'new-project'; slicerId?: SlicerId }`, and `SlicerLaunchDto` to
      `dtos.ts`:
      `{ launchId; slicerId; installLabel; stripped: boolean; notices: string[]; pid: number | null }`.
      Wire it as a **`shellCall`** and refuse it in `HttpApiClient`.
- [ ] **`open` takes ids, never a path** (constraint 4). It takes a `projectId` as well as a
      `fileId` because the launch record and the later reconcile both need the project and
      `FileDto` carries no `projectId`, and parent §4.3 exposes no `GET /api/files/:id`. The
      renderer passes the id it is already holding on the project page; the main process still
      resolves the file through core's ownership scoping in local mode and the server's in remote
      mode, so a renderer that names a project it does not own gets `NotFound`.
- [ ] The UI says **"Handed _file_ to _slicer_"**, never "opened in your slicer" (constraint 11).
- [ ] Tests, the data-loss rule: **a `model`-kind `.3mf` is copied into a launch directory and the
      source path is never handed to a slicer** — assert the **exact path that was spawned**, and
      assert the source file's bytes and mtime are unchanged afterwards. Change the branch to
      include `.3mf` and confirm the test goes red. This was a defect in the first draft of the
      spec, which is the best available argument that it needs a test rather than a sentence.
- [ ] Tests, the other two paths: an `.stl` **is** launched in place — the spawned path equals the
      library path and no launch directory was created; a `slicer_project` opened as-is is spawned
      at the library path with no copy and no strip.
- [ ] Tests, refusals: a strip that leaves configuration behind refuses, the message names the
      reason, and **`spawn` was never called** — assert the call count, not only the thrown error;
      a launch whose bound install has vanished reports the install as gone and does not spawn; a
      launch with no binding and two installs for the product refuses with a message naming the
      choice rather than picking one.
- [ ] Tests, notices and the record: every row of the notices table driven as a triple — assert
      that Bambu plus its own project plus stripped produces the modal notice and that Bambu plus
      its own project unstripped does not; `launch.json` is written with a `launchedHash` equal to
      `entryHash` of the launched file.

**Interface handed to task 5:** the launch directory layout, `launch.json`'s field list, and
`resolveInstall`.

### Task 5 — Remote mode, the watch, and the reconcile

- [ ] **Remote launch.** In remote mode there is no local path, so **every** launch goes through a
      launch directory, `.stl` and `.obj` included, and path A becomes the same loop as path B with
      a longer first step: create the directory, download the source into it main-process side,
      classify the download, strip in place where there is something to strip, then launch, watch,
      reconcile.
- [ ] The download uses the existing proxy, which already carries the session cookie.
      `RemoteHost.proxy` takes a `Request` on the renderer origin and is its **only** public entry
      point, so the call is
      `remoteHost.proxy(new Request(RENDERER_ORIGIN + API_PATH_PREFIX + '/files/' + fileId + '/raw'))`
      — `RENDERER_ORIGIN` from `packages/desktop/src/urls.ts`, `API_PATH_PREFIX` (the string
      `/api`) from `protocol.ts`. **The bytes never round-trip through the window.**
- [ ] **The watch**: `fs.watch` on the launch directory with a settle delay, **plus a
      low-frequency poll while a session is live**. Both, and not one, for the reasons in the next
      two bullets.
- [ ] Watch rule: a write in progress is not a corrupt file. A read that finds 0 bytes,
      `EBUSY`/`EACCES`, or a ZIP whose central directory does not parse means **not settled yet** —
      retried with backoff for a **bounded 60 s window at 500 ms** before it is reported as
      unreadable. The scale comes from Cura's non-atomic write: 0 bytes and an exclusive lock for
      at least six seconds.
- [ ] Watch rule: **the watch is an optimisation, not the mechanism of record.** What decides
      whether anything came back is a comparison, run on the watch event, on process exit, and at
      next app start. A missed `fs.watch` event costs promptness, never correctness. **Do not
      remove the poll as redundant** — see open question 6. Anything appearing in the directory
      that is neither the launched file nor `launch.json` is **reported, not adopted**.
- [ ] **Change detection is task 1's `entryHash`**, never a whole-file hash and never mtime. mtime
      is kept as a **hint** for when to bother computing the hash, and never as an answer.
- [ ] Reconcile step 1, when `entryHash` differs from `launchedHash`: re-classify with
      `classifyFile` and carry **the returning file's** slicer identity, not the record's — a Bambu
      project opened in Orca and saved comes back `orca`, so a round trip can change what the file
      _is_.
- [ ] Reconcile step 2: show the user **a computed `entryDiff`**, not a remembered anecdote —
      entries added, removed and changed, by name. State its limit in the UI as plainly as its
      findings: it reports that `Metadata/project_settings.config` changed, **not which setting
      inside it changed**. Do not hard-code any specific finding from the spike into a runtime
      string.
- [ ] Reconcile step 3: upload **on the user's word, as a new file** — through `files.upload` in
      local mode and through a proxied `POST /api/projects/:id/files` in remote mode, because in
      remote mode the bytes are already main-process side and must not detour through the renderer.
      **Never automatic:** a cross-slicer trip is lossy, and path B's returning file is a new
      project the user may not want in the library at all.
- [ ] **The remote upload must set `UPLOAD_LENGTH_HEADER` (`x-spm-content-length`, from
      `packages/desktop/src/protocol.ts`)**, which `RemoteHost.#send` turns into a real
      `content-length`. The server refuses a body with no length with **411** before it writes a
      byte. This is a live trap, and it is why the renderer's own uploads already declare a length.
- [ ] **The returning file is added under a derived non-clashing name**, `<basename> (<slicer>).3mf`,
      appending an ordinal on collision — `bracket (orca).3mf`, then `bracket (orca) (2).3mf` —
      probing until `uploadFile` would accept it. `uploadFile`'s own `Conflict` stays the backstop,
      because the probe is not atomic with the write. Deleting the original is a **separate**
      action with a control that already exists.
- [ ] **Sweep rule 1** (constraint 10): only the user's answer, or an observed-and-settled exit,
      removes a **file**. The exit sweep runs when the spawned process exits and may delete only
      the file, and only while it is _still_ byte-unchanged after a **10 s settle period** — a
      judgement chosen against Cura's six-second lock, not a measurement. The directory and its
      `launch.json` stay, which is stricter than this line said while it read "a directory", and is
      what makes the record-outlives-the-file rule two bullets down do anything at all. It read
      "anything" for one round, which overshot in the other direction: the sweep at next start does
      remove a completely empty launch directory, and a `launch.json` whose file the app itself
      swept over 90 days ago. Neither is a file of the user's, and neither can become one. Even that is not proof: with
      `single_instance` on, the spawned process hands the file over and exits while the slicer
      stays open. **A sweep at next start surfaces and does not delete** — every
      `slicer-sessions/*` directory not belonging to the current process becomes a listed session.
- [ ] **Sweep rule 2**, which is what makes rule 1 survivable: a file with no record is an
      unfinished session, not litter. Whatever the app deletes can come back complete at the same
      path on the next Ctrl+S, so a `.3mf` found in `slicer-sessions/` with nothing to explain it
      is offered to the user — "this came back from a slicer; which project does it belong to?" —
      and never swept.
- [ ] **`launch.json` outlives the file it describes.** When a directory's file is removed the
      record stays, gaining a `sweptAt`, for **90 days**. A recreated file then lands beside a
      record naming its project, its source file and its slicer, and the reconcile is fully
      informed instead of asking the user to remember. A session with no activity for **30 days**
      is listed as **stale** — listed, not deleted. Both numbers are judgements, written down here
      so a later change knows they were chosen.
- [ ] Add `slicers.sessions()`, `slicers.resolveSession(launchId, action, opts?)` and
      `slicers.discardSessions(launchIds)` to `ApiClient`, plus `SlicerSessionDto` as the block
      below. `resolveSession` takes `'import' | 'discard'` and needs a `projectId` **only** for an
      orphan; for a session with a `launch.json` the argument is ignored. All three are
      `shellCall`s and all three are refused by `HttpApiClient`.

```ts
type SlicerSessionDto = {
  launchId: string
  projectId: string
  fileId: string
  fileName: string
  slicerId: SlicerId
  startedAt: number
  processAlive: boolean
  fileState: 'unchanged' | 'changed' | 'settling' | 'unreadable'
  isOrphan: boolean // a file found with no launch.json: the user must say where it belongs
  sourceSlicer?: SlicerId | null
  returnedAs?: SlicerId | null // set when fileState is 'changed' and the classification differs
  sourceSizeBytes?: number
  returnedSizeBytes?: number
  entryDiff?: { added: string[]; removed: string[]; changed: string[] }
}
```

- [ ] Render the session list on `/settings/slicers` (task 3's page) and beside the launch control:
      live sessions, unreconciled ones from previous runs, orphans asking for a project, and stale
      ones. `processAlive` is labelled as what it is and **not** as "the slicer was closed", because
      a handed-off instance outlives the process the app spawned.
- [ ] Tests, the two data-loss rules: a sweep at next start over a directory whose file is
      byte-unchanged **leaves it listed rather than deleting it** — assert the directory still
      exists **and** that it appears in `sessions()`, then change the sweep to delete and confirm
      red; a `.3mf` in `slicer-sessions/` with no `launch.json` comes back as a session with
      `isOrphan: true` and is not deleted.
- [ ] Tests, the record: a record with `sweptAt` is still present after its file is removed, and a
      file recreated at that path is matched back to its project.
- [ ] Tests, change detection end to end: a changed file produces an `entryDiff` whose `changed`
      names the changed entry and whose `added`/`removed` are empty, built with `make-3mf.ts`; a
      file that is 0 bytes on the first read and complete on the third reports `settling` then
      `changed` and **never** `unreadable` inside the 60 s window; a file with the same content and
      a different ZIP timestamp reports **`unchanged`**.
- [ ] Tests, remote and consent: nothing is uploaded without an explicit `resolveSession('import')`
      — assert the upload call count is zero after a watch event fires; the remote download hits
      `/api/files/<id>/raw` through the injected `fetch` and the bytes land in the launch
      directory; the remote upload carries `x-spm-content-length` equal to the body length, because
      without it the server answers 411; launching Cura in remote mode still spawns, and the
      response carries the round-trip notice.

---

## Open questions

The spec's §10 has seventeen. These are the ones that reach a task. **None of them blocks a task;
each qualifies one, and each says what an implementer should do on meeting it.** Do not silently
resolve any of them.

1. **Does the five-entry Bambu-lineage strip set work in Orca and Bambu?** Unmeasured — Orca was
   measured with three of the five, Anycubic with all five, and the chosen set is a superset of
   both. **On meeting it:** use the five-entry set as written. Do not shrink it to the measured
   three; a partial set is exactly what the half-strip finding forbids. Shrinking it needs two
   launches of about two minutes each, and that is a spike, not a task.
2. **macOS and Linux.** Unmeasured and **expected to invert**: `open -a` returns no child pid, so
   "the spawned pid is the app" — which the exit sweep and `SlicerLaunchDto.pid` both rest on —
   fails there, and Flatpak's sandbox may be unable to read a launch directory at all. **On meeting
   it:** report `detectionSupported: false`, offer manual entry, and stop. Do not design a
   non-Windows path from inference.
3. **Is `DisplayIcon` reliably the main executable across other vendors' builds?** Five of five on
   one machine. **On meeting a row whose `DisplayIcon` fails the `exeName` check:** drop the row
   and let manual entry cover it. Do not widen the search to globs or Start Menu shortcuts — that
   is the deferral in Scope, and it produces an executable path with no user consent behind it.
4. **Per-user installs under `%LOCALAPPDATA%\Programs`.** The `HKCU` branch is implemented and
   untested against a positive; the measured machine has none. **On meeting it:** keep the branch
   and cover it with a fixture. Do not delete it for lack of a real positive.
5. **Orca via its AUMID.** Direct execution of the `WindowsApps` executable worked from a
   non-elevated process and accepted argv, so it is the primary route. **On meeting a packaged app
   that refuses direct execution:** refuse the launch and report it. The fallback
   (`IApplicationActivationManager::ActivateForFile`) needs a native binding this project does not
   have, and adding one is a dependency decision, not a detail.
6. **What does `fs.watch` do on a network-backed `userData`?** Unmeasured. **On meeting it:** the
   poll is the mechanism of record and the watch is the optimisation. Do not delete the poll as
   redundant, and do not make correctness depend on an event firing.
7. **Does slicing before saving change any of this?** Unmeasured — every save measured was of an
   unsliced project, including the two-saves-of-identical-content determinism result the whole of
   change detection rests on. **On meeting a hash that moves when nothing was edited:** report
   `changed` and show the diff. Degrading to `unchanged` is the failure that loses work.
8. **Does a stripped file still save in place?** Measured for two of four, inferred for the rest.
   The design survives either answer, because a Save-As proposes the launch directory with the same
   basename. **On meeting it:** the watch must cover both the in-place path and a Save-As into the
   launch directory. Do not assume in-place.
9. **Does Bambu prompt on a stripped copy of its own project?** Inferred, not run. **On meeting
   it:** keep the notice row and mark it inferred in a code comment. Do not delete it for lack of a
   measurement, and do not upgrade its wording to a certainty.
10. **Do any real slicer projects need zip64?** Unmeasured for projects specifically — the 28
    zip64 files in the reference library all classify `model`, so the rewriter has never been asked
    to strip one. **On meeting one whose values do not fit:** refuse with a message naming the
    reason. Never truncate a 64-bit value into a 32-bit field.
11. **`show_drop_project_dialog` in PrusaSlicer's config.** Unmeasured, and it does not change the
    design either way: **the app never writes to a slicer's configuration.** The most it may do is
    mention that the setting exists.
12. **`classify.ts` does not change in D.** The `Application` metadata in `3D/3dmodel.model` is a
    stronger provenance signal that stripping cannot remove, and adopting it would reclassify files
    already indexed in every existing library. **On meeting a file the current rules classify
    "wrong":** classify it the way the current rules do. Changing them is constraint 2.

---

## Definition of done

- `deno task verify` green, `deno task e2e` green, `deno task test:desktop` green, CI green on
  `main`, including the new bundle-grep pair.
- On Windows with a real install: `/settings/slicers` lists both Curas with their distinct
  versions, OrcaSlicer via its MSIX package, and asks which install `cura` should launch rather
  than picking one.
- Open-as-is launches a `slicer_project` at its real library path in local mode, with no copy.
- New-project-from-a-file strips per the file's flavour, launches from
  `<userData>/slicer-sessions/<launchId>/`, and **never** hands a `model`-kind `.3mf` to a slicer
  at its library path.
- A failed strip refuses, names the reason, and never spawns.
- In remote mode the file is downloaded, launched, watched, and what comes back is offered as a new
  file with a computed entry diff — and nothing is uploaded without the user saying so.
- A sweep at next start lists unfinished sessions and deletes nothing; a file with no record comes
  back as an orphan asking which project it belongs to.
- The two capability flags are true in both desktop shell columns and false in the browser column,
  and the union carries them through a backend that reports both false.
- Cura's round-trip limit is stated to the user before the launch, in both modes, and the launch
  still happens.
