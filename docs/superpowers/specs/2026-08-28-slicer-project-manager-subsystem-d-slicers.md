# Slicer Project Manager — Subsystem D: slicer configuration and launching

- **Date:** 2026-08-28
- **Status:** Approved (design); implementation plan pending
- **Parent:** [`2026-08-22-slicer-project-manager-design.md`](2026-08-22-slicer-project-manager-design.md)
  — binding. Where this document and the parent disagree, the parent wins and this one is wrong.
- **Measurements:** `.superpowers/spikes/2026-08-28-slicer-launch-facts.md`, Parts 1 and 2, run on
  the developer's Windows 11 machine against five installed slicers. Section references below of
  the form "(§21)" are to that document.
- **Packages touched:** `packages/desktop` (all of the launching), `packages/web` (one route, one
  link), `packages/contract` (interface + DTOs), `packages/core` (two additive, unreachable-from-
  the-server modules — see 3.6).

## 1. Purpose and scope

D is the reason the desktop shell exists as something more than a browser in a window: it is what
turns a library entry into a running slicer. Everything else in the app can be done from a browser
tab. This cannot.

### 1.1 What D adds

- A **slicer registry** — five slicers, what each is called, how it is found, how it is launched,
  what it must have removed from a `.3mf` before it is handed one, and what it will do to the user
  in each case.
- **Detection** of installed slicers, and a machine-local store of the result.
- `/settings/slicers`, and the two capability flags that light it up.
- **Open this slicer project in its slicer**, as-is.
- **Start a new slicer project from a file**, with per-slicer config stripping to a temp file.
- The **remote-mode round trip** the parent spec's §2.7 records as a known constraint and does not
  solve: download, launch, watch, reconcile — with Cura's limit stated rather than half-solved.

### 1.2 Out of scope

- The embedded model browser (spec E). Printer control, G-code analysis and print-job management,
  which parent §1.2 puts out of scope for the whole product.
- Installers and code signing, deferred with reasons in the C plan.
- **macOS and Linux detection and launching.** The spikes ran on Windows 11 only. Parts of §§4 and
  5 are expected to _invert_ on macOS — see 4.6 and 10.4. D ships a Windows implementation behind
  a seam, and says so, rather than designing for a platform nobody has measured.
- Writing to any slicer's own configuration. Parent §3.7 says the app never writes there, and
  nothing measured here changes that — including PrusaSlicer's `show_drop_project_dialog`, which
  would suppress a modal the app finds inconvenient and is the user's setting to make.

### 1.3 Why this is a spec and not only a plan

Parent §1.1 promises "B–E each get their own spec and plan cycle". In practice B and C went
straight to plans and the subsystem table was left alone, because the table's `This spec` column
kept saying something true about _the parent document_. D is the first subsystem whose detail
lands in a second spec, so its row now points here. B's and C's rows are deliberately left as they
are; retro-fitting links to plans is a different change and not this one.

## 2. What was measured

Every row was run and observed on one Windows 11 machine with all five slicers installed. Nothing
here is from vendor documentation. **A design decision that contradicts a row is wrong.**

| #   | Question                                                      | Measured                                                                                                                                                                                                                              | Spike    |
| --- | ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- |
| 1   | How does a file reach a slicer?                               | A bare path as `argv[1]`. All five. No flag, no refusal.                                                                                                                                                                              | §3       |
| 2   | Does a successful spawn mean the file opened?                 | **No.** Anycubic silently discarded a `.3mf` — window up, plate empty, no error, one log line. Bambu and PrusaSlicer put modals in front of it. Three of five never show a filename in the title.                                     | §3       |
| 3   | Is the spawned process the app?                               | Yes, on Windows, all five. None re-exec or hand off and exit; the returned pid owns the main window.                                                                                                                                  | §5       |
| 4   | Does a second launch hand the file to the running instance?   | Not today — all five started a second process, and two Cura versions ran three processes at once. **But `single_instance` is a user setting** in all four Prusa/Bambu-lineage config files.                                           | §4       |
| 5   | How long until a window?                                      | PrusaSlicer ~2 s, Bambu ~8 s, Cura ~25 s to a titled window, Anycubic ~30 s, Orca ~35 s. Three of five load WebView2 at startup.                                                                                                      | §5       |
| 6   | Does a slicer hold a handle on the file it opened?            | **No.** Exclusive read, exclusive read/write and rename all succeeded on all five while the file was open.                                                                                                                            | §6       |
| 7   | Does opening a file modify it, or its folder?                 | No. No mtime change, no new files. Autosave goes to `%TEMP%\<slicer>_model\…`, never beside the file.                                                                                                                                 | §6, §15  |
| 8   | What does Ctrl+S target?                                      | PrusaSlicer, Anycubic, Bambu, Orca: **in place, silently**, once the project has a path. **Cura: always Save-As**, never in place.                                                                                                    | §13      |
| 9   | Where does Cura propose to save?                              | A sticky global directory from `%APPDATA%\cura\5.13\cura.cfg` `dialog_save_path` — **currently a real folder inside the user's model library.** It re-prompts even for the file it opened, and asks "overwrite?" if aimed back at it. | §13      |
| 10  | Do two saves of identical content produce identical bytes?    | Only Cura. PrusaSlicer stamps `; generated by PrusaSlicer … at HH:MM:SS UTC` inside `Metadata/Slic3r_PE.config`; all four write wall-clock ZIP timestamps, so the container differs every save.                                       | §14      |
| 11  | Does mtime answer "did the user save?"                        | **No, in both directions.** The four in-place savers skip the write entirely when nothing is dirty; Cura's re-save of identical content moved mtime.                                                                                  | §13, §14 |
| 12  | Is the write atomic?                                          | **Not Cura's.** The target sat at 0 bytes and exclusively locked for at least six seconds. Orca's showed no intermediate state at 40 ms polling.                                                                                      | §14      |
| 13  | Sidecar, lock, backup or temp files beside the project?       | **None, any slicer.** A rescan of a launch directory will not invent entries.                                                                                                                                                         | §15      |
| 14  | Does a same-slicer round trip keep its classification?        | Yes, all five, through this repo's own `classify.ts`.                                                                                                                                                                                 | §16      |
| 15  | Does a cross-slicer round trip?                               | **No.** A Bambu project opened in Orca and saved comes back classified `orca`, has lost `Metadata/cut_information.xml`, and had one print setting silently rewritten.                                                                 | §16      |
| 16  | Does stripping the embedded config suppress the adopt prompt? | **Per-slicer, and only for two of five.** Cura: prompt gone. Anycubic: silent discard becomes a clean load. Orca: two modals become one. PrusaSlicer: unchanged. Bambu: unchanged.                                                    | §20      |
| 17  | What happens on a half-strip?                                 | Removing `slice_info.config` alone yields `slicer_project` with `slicer: null` — the one classification worse than either end state — and the foreign print profiles are adopted anyway.                                              | §20      |
| 18  | Must thumbnails and plate images be stripped?                 | No. `plate_*.png`, `pick_*.png`, `top_*.png` and `Metadata/thumbnail.png` were kept in every successful strip and no adoption prompt appeared.                                                                                        | §20      |
| 19  | Does `[Content_Types].xml` need repairing after a strip?      | Not in any of the five flavours — it declares `Default Extension` entries only. `_rels/*` needed a `<Relationship>` dropped only where a removed part was a relationship target.                                                      | §20      |
| 20  | Is deleting the temp file while the slicer holds it safe?     | **Yes** — PrusaSlicer, Anycubic, Bambu and Orca all failed to notice, and **recreated the file complete at the same path** on the next Ctrl+S. Cura not applicable (it never saves in place).                                         | §21      |
| 21  | Which detection mechanism finds every install?                | **None alone.** Registry uninstall keys find 5 of 6; `Get-AppxPackage` is the only thing that sees OrcaSlicer.                                                                                                                        | §2a, §2g |
| 22  | Which registry field names the executable?                    | `DisplayIcon`. **`InstallLocation` is empty for four of the five keys.** Cura registers under `WOW6432Node` despite being 64-bit, so all three hives must be read.                                                                    | §2a      |
| 23  | Are file associations a detector?                             | **No.** One handler per extension, MSIX hidden behind hashed ProgIds, and `Cura.project` names 5.13.0 only — **the mechanism collapses the two Curas.**                                                                               | §2c      |
| 24  | Do two versions of one slicer coexist?                        | Yes. Two Cura installs, two registry keys, two directories, two Start Menu entries, and three Cura processes ran simultaneously across both versions without interfering.                                                             | §2a, §4  |
| 25  | Is a slicer's path stable?                                    | **Not Orca's.** `…\WindowsApps\OrcaSlicer.OrcaSlicer_2.4.3.0_x64__3qd7h69xpne0g\` embeds the version, so a cached path breaks on update.                                                                                              | §2g      |
| 26  | Can a version be read off the executable?                     | Not for Cura or Orca — both have an **empty version resource**. Cura's comes from the registry, Orca's from `Get-AppxPackage`.                                                                                                        | §1       |
| 27  | Is there a slicer fixture in this repo?                       | **No.** `packages/core/test/fixtures/` holds generators only; there is no real `.3mf` or `.stl` anywhere in the tree.                                                                                                                 | §0       |

### 2.1 What the spikes could not settle

Named here because the design leans on some of them, and a reader should know which parts rest on
one machine rather than on five.

- **macOS and Linux entirely** (§10.12, §10.13). Row 3 in particular is expected to invert: `open`
  returns immediately with no child pid, and a document-open AppleEvent to a running app is the
  _default_ on macOS, so handoff is the norm there. Flatpak's sandbox may not be able to read a
  launch directory outside its allowed paths at all, which would break §2.7's plan on that
  platform rather than merely complicate it.
- **A slicer that is genuinely absent** (§10.10). All five are installed on the measured machine,
  so the "not installed" path was never exercised against a real negative. It is therefore the
  least-evidenced path in D and 9.2 gives it an explicit test.
- **Per-user installs** under `%LOCALAPPDATA%\Programs` (§10.11). `HKCU`'s uninstall hive was empty
  of slicers, so that branch is untested against a positive.
- **Whether `DisplayIcon` is reliably the main executable** across other vendors' builds (§10.14).
  Five of five here; that is one machine and one version of each product. 4.5 is the mitigation.
- **Saving after an actual slice** (§19.3). Every save measured was of an unsliced project. Row 10,
  which the change-detection design in 7.3 rests on, has not been re-run against a sliced one.

## 3. The slicer registry

### 3.1 A `SlicerId` is not an install

`SlicerId` (`'cura' | 'prusaslicer' | 'anycubic' | 'bambu' | 'orca'`, already in
`packages/contract/src/dtos.ts`) names a _product_. It does not name something that can be
launched. Row 24 is the reason: this machine has Cura 5.12.0 and Cura 5.13.0, both installed, both
working, both able to run at the same time.

So D carries two types and never conflates them:

- **`SlicerId`** — the product. Five of them, closed. This is what `files.slicer` holds and what
  parent §3.4 detects from a `.3mf`.
- **`SlicerInstall`** — a `(path, version)` pair with an origin. One-to-many with `SlicerId`.

Detection reports installs. The user binds a `SlicerId` to one of them. **The app offers; it does
not guess** (D-7). A `SlicerId` with two installs and no binding is not launchable, and the UI says
so rather than picking the newer one — picking the newer one is precisely what the file-association
mechanism does, and row 23 is why that is rejected.

### 3.2 What a registry row holds

The registry is a static table in `packages/desktop`, one row per `SlicerId`. It is code, not
configuration: every field in it is a measured property of the product, and a user has no business
editing any of it.

```ts
type SlicerDef = {
  id: SlicerId
  displayName: string

  /** How detection finds it on Windows. See 4. */
  windows: {
    /** Matched against the uninstall key's DisplayName. */
    displayNamePattern: RegExp
    /** The basename DisplayIcon must resolve to. Validation, not search — see 4.5. */
    exeName: string
    /** Set only for MSIX products. OrcaSlicer is the only one today. */
    msixPackageFamily?: string
  }

  /** argv for a file. `[file]` for all five (row 1); a function so a sixth need not be. */
  argv(file: string): string[]

  /** The entries to remove from a `.3mf` *this slicer authored*. See 3.3. */
  strip: { entries: readonly string[]; prefixes: readonly string[] }

  /** What the app is allowed to tell the user will happen. See 6.4. */
  behaviour: {
    savesInPlace: boolean
    promptsOnForeignProject: 'always' | 'suppressed-by-strip' | 'user-setting'
    silentlyDiscardsNewerProjects: boolean
  }
}
```

### 3.3 Stripping, and which slicers it actually helps

The rule, as stated: strip the embedded configuration from a `.3mf` used to create a new project,
so the slicer does not ask whether to adopt it; open an existing slicer project as-is.

Measured (row 16), it holds for two of five. The registry therefore carries a per-slicer strip set,
and the app is honest about the rest:

| Slicer          | Stripping does                                                                                        | Honest statement                                                                                                                                                    |
| --------------- | ----------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Cura**        | Removes the "Summary — Cura Project" prompt entirely; the file opens under Cura's own printer/profile | Works as intended                                                                                                                                                   |
| **Anycubic**    | Turns a **silent discard** into a clean load under Anycubic's own configuration                       | **Not prompt suppression — it is what makes the file load at all.** See below                                                                                       |
| **Orca**        | Two modals become one, and the remaining one is informational ("loading geometry data only")          | Partly. The lossy-settings-rewrite modal is the one that disappears, which is the useful half                                                                       |
| **PrusaSlicer** | Nothing to the prompt. Measured down to a three-entry `.3mf` with no configuration in it at all       | The four-way "Load project file" dialog is a function of the `.3mf` extension and the user's `show_drop_project_dialog`, not of content. Stripping cannot remove it |
| **Bambu**       | Nothing. Its modal fires on the **absence of its own** `project_settings.config`                      | Unavoidable for any file Bambu did not write. Stripping can only make it more certain                                                                               |

**Anycubic is the headline and it is not a nicety.** Part 1 §3 recorded Anycubic starting, opening
a window, and leaving the plate empty for a Bambu-lineage `.3mf` it judged too new — no dialog, no
error, only a line in its log. §20 removed the config entries from that same file and it loaded,
with the user's own printer and filament selected. **Cross-slicer project creation does not work
for Anycubic without stripping.** Anywhere the spec talks about "suppressing a prompt", Anycubic is
the case where the alternative is not a prompt but a lie.

Even where stripping does not remove a prompt, it still does the job it was asked to do: a stripped
file carries no foreign print configuration, so a user who clicks through PrusaSlicer's dialog and
picks _Open as project_ gets their own settings rather than someone else's. That is the actual
requirement; prompt suppression was the hoped-for side effect.

**Never half-strip (D-2).** Row 17: removing `slice_info.config` alone left a file that
`classify3mf` reports as `slicer_project` with `slicer: null` — a project the app cannot attribute
to anything — _and_ the foreign printer and filament presets were still adopted. The strip is
all-or-nothing per flavour, and 3.5 makes a failed strip refuse to launch rather than degrade.

**Thumbnails survive.** Row 18: `plate_*.png`, `pick_*.png`, `top_*.png` and
`Metadata/thumbnail.png` were kept in every successful strip and nothing prompted. This is not
incidental — parent §7.1's embedded-thumbnail fast path is what gives essentially every project
file a preview without rendering, so a strip that discarded the artwork would cost real UI.

### 3.4 The strip sets, and which axis indexes them

**The strip set is indexed by the flavour of the file, not by the slicer being launched.** This is a
decision the measurements force and it is easy to get backwards: what can be removed is whatever
the _authoring_ slicer put in, and the _launched_ slicer only determines what the user then sees.

| File classified as                                    | Removed                                                                                                                                                                   | Evidence                                                                                   |
| ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| `cura`                                                | every entry under `Cura/` (15 of them)                                                                                                                                    | §20, measured: prompt gone, model and thumbnail intact                                     |
| `prusaslicer`                                         | `Metadata/Slic3r_PE.config`, `Metadata/Slic3r_PE_model.config`                                                                                                            | §20 probe `p2`. Removes the config; the dialog stays                                       |
| `anycubic`, `bambu`, `orca`, or rule-4 `slicer: null` | `Metadata/slice_info.config`, `Metadata/project_settings.config`, `Metadata/model_settings.config`, `Metadata/custom_gcode_per_layer.xml`, `Metadata/cut_information.xml` | §20 probe `a2` (all five, no prompts in Anycubic); probe `o1` used the first three in Orca |
| `model` (a plain-mesh `.3mf`, `.stl`, `.obj`)         | nothing — there is no configuration in it                                                                                                                                 | §20 classification table                                                                   |

**One set for the whole Bambu lineage, and it is the wider of the two measured.** Anycubic was
measured with five entries and Orca with three; the five-entry set is a superset, and the two extra
entries are per-project data rather than configuration — `cut_information.xml` is dropped by Orca
on a plain round trip anyway (row 15). Choosing the wider set means every launch target gets at
least what it was measured with, and D-2's all-or-nothing rule needs exactly one set per flavour to
be checkable at all. **Not measured:** the five-entry set in Orca or Bambu. It is a strict superset
of sets that loaded, and no stripped file was ever rejected as malformed (§20, "structural
integrity"), but that is an argument, not a measurement — 10.1.

For a file classified `slicer_project` with `slicer: null` — parent §3.4's rule 4, a project saved
but never sliced — the Bambu-lineage set is used, because `project_settings.config` is what rule 4
matched on and only the lineage writes it. The set is a no-op for entries that are not there.

### 3.5 What the strip produces, and what happens when it cannot

The output is a new `.3mf` written to the launch directory (6.3), never into the project.

- Entries that survive are copied **with their compressed bytes verbatim**, and the local headers
  and central directory are rebuilt around the surviving set. No decompress/recompress round trip:
  payloads stay byte-identical, `stored` and `deflate` entries both work, and the operation costs
  one linear copy.
- `_rels/*.xml` parts are rewritten to drop any `<Relationship>` whose `Target` names a removed
  part, and stored uncompressed. Measured (row 19): needed in exactly one probe, where
  `Metadata/thumbnail.png` was removed; PrusaSlicer accepted the rewritten file.
- `[Content_Types].xml` is checked but, in all five flavours, needs nothing (row 19). It is checked
  anyway, because "five files did not need it" is not "the format does not require it".
- An archive the rewriter cannot round-trip — zip64, an entry whose sizes live only in a data
  descriptor, an encrypted entry — **fails the strip**.

**A failed strip does not fall back to launching the original.** For Anycubic that fallback is
precisely the silent-discard case (rows 2 and 16): the app would spawn a process, the user would
see an empty plate, and nothing would say why. The launch is refused with a message naming the
file, and the user can still open it as-is from the other launch path if they want to.

### 3.6 What this needs from `packages/core`, and what it deliberately does not

Two additive modules, both pure, both reachable from **no server route**:

1. `files/zip-write.ts` — the entry-preserving rewriter above. Core has a ZIP _reader_
   (`files/zip.ts`, `readZipEntries` / `readZipEntryBytes`) and no writer at all today; this is the
   writer, and it belongs beside the reader that parses the central directory it has to rebuild.
2. `files/strip3mf.ts` — the strip sets of 3.4 and the all-or-nothing operation over them.

They go in `core` rather than `desktop` for one reason that survives scrutiny: the strip sets are
defined in terms of the same entry names `classify.ts` already matches on, and the invariant that
matters — _a stripped file must classify as `model`, never as rule-4 `slicer: null`_ (row 17) — is
only expressible where both live. Putting them there also runs them under core's dual-runtime
suite (parent §8.1) for free.

**This does not change the Deno server's observable behaviour** (C plan, global constraint 2). No
route imports either module, the route table is untouched, and the server's DTOs are unchanged.
That is assertable rather than assumed, and 9.2 asserts it.

**`classify.ts` does not change in D.** §20 found a second, stronger provenance signal that
stripping cannot remove — `<metadata name="Application">BambuStudio-02.08.02.61</metadata>` inside
`3D/3dmodel.model`, plus the vendor XML namespace on the root element — surviving exactly the entry
removals that defeat the current rules. Adopting it would reclassify files already indexed in every
existing library: a fully stripped `.3mf` that is `model` today would become `slicer_project`. That
is a change to the server's observable behaviour and it belongs to its own measured change, not to
D. Recorded as 10.11.

The corollary is load-bearing and worth stating the other way round: **the app's own stripped temp
files classify as `model` with `slicer: null`** (§20's classification table), which is correct — a
stripped file is a mesh with no project attached — and it is what the create-a-project path wants.

## 4. Detection

### 4.1 Two mechanisms, both required

Ranked as measured (§2's ranking), not as documented:

1. **Registry uninstall keys**, across `HKLM\…\Uninstall\*`, `HKLM\SOFTWARE\WOW6432Node\…\Uninstall\*`
   and `HKCU\…\Uninstall\*`, reading `DisplayName`, `DisplayVersion` and **`DisplayIcon`**. Five of
   six installs, correct versions, both Curas. `InstallLocation` is empty for four of the five keys
   (row 22), so a detector built on it finds PrusaSlicer and nothing else.
2. **`Get-AppxPackage`** for MSIX products. The only mechanism that sees OrcaSlicer at all — no
   uninstall key, no Start Menu shortcut, no `App Paths` entry, not on `PATH`, and not findable by
   a recursive filename search under the usual roots (§2d, §2e).

Neither is optional and neither is sufficient. Start Menu `.lnk` targets and `Program Files` globs
were measured as usable corroboration (3 and 4 in the ranking) but **are not implemented in D** —
they add a second and third way to produce an executable path the app will later run, for a case
that did not occur on the measured machine, and 4.5's manual entry covers the same gap with the
user's own consent instead of a heuristic. File associations and `PATH` are rejected outright by
rows 23 and §2e.

### 4.2 How the process reads them

Node has no registry API and no MSIX API, and this project ships no native dependencies. Detection
therefore runs **one** `powershell -NoProfile -NonInteractive -Command` child process that emits a
single JSON document covering both mechanisms, which the main process parses.

One process rather than two (`reg.exe query` plus PowerShell) because `Get-AppxPackage` forces
PowerShell anyway; because `reg.exe`'s output is a positional text format with no way to express
the MSIX half; and because one subprocess is one failure mode, one timeout and one parse to test.

Consequences, stated because they shape the UI:

- **Detection is on demand, never at app start.** PowerShell startup is hundreds of milliseconds
  and the app has no reason to pay it before a user opens `/settings/slicers`.
- **Its output is untrusted input.** It names paths the app will later execute. Every returned path
  is validated before it is stored or offered: absolute, exists, is a regular file, and its
  basename equals the registry row's `exeName`. That last check is what stops `DisplayIcon` pointing
  at `CuraEngine.exe` or an uninstaller — §1 lists both as real executables sitting beside the real
  one, and notes that "biggest exe in the folder" picks `CuraEngine.exe` over Cura.
- `DisplayIcon` may carry a trailing `,<index>` and surrounding quotes. All five were bare paths
  here; both are stripped anyway, because five files is not a specification.

### 4.3 The two-Cura case

Detection returns two `SlicerInstall` rows for `SlicerId = 'cura'`, from two distinct uninstall
keys with distinct `DisplayName`, `DisplayVersion` and `DisplayIcon`. `/settings/slicers` shows
both, with their versions, and asks which one `cura` should launch. Nothing collapses them and
nothing prefers the newer.

The version comes from `DisplayVersion`, not from the executable: Cura's version resource is empty
(row 26). The same is true of Orca, whose version comes from the MSIX package.

### 4.4 The MSIX-Orca case, and why a path is never trusted from the store

Orca's install path embeds its version (row 25), so a stored absolute path breaks silently the next
time Orca updates — and the failure mode is a spawn of a path that no longer exists, which looks
like "the slicer did nothing".

**The stored identity of an install is its origin key, never its path.**

| Origin     | Key                                                                                                            | Stable across                                                   |
| ---------- | -------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| `registry` | the uninstall subkey name, plus the hive it was found in                                                       | version updates that keep the key; a reinstall usually keeps it |
| `msix`     | `PackageFamilyName` (`OrcaSlicer.OrcaSlicer_3qd7h69xpne0g`) — the version lives in `PackageFullName`, not here | version updates, by construction                                |
| `manual`   | a generated id                                                                                                 | whatever the user chose                                         |

The last known path is persisted **as a hint**. Before every spawn it is `stat`ed and its basename
re-checked; on any mismatch the install is re-resolved from its origin key, the hint is rewritten,
and only then is anything launched. The common case costs one `stat` and no subprocess; an Orca
update costs one PowerShell run at the moment of the next launch and is invisible to the user.

This also catches the case detection cannot: a slicer uninstalled since the last scan. The
`stat` fails, re-resolution finds nothing, and the app says the install is gone rather than
spawning into a hole.

### 4.5 Manual entry

The user can add an install by picking an executable in a native dialog (`dialog.showOpenDialog`,
file mode, filtered to executables). It is stored with `origin: manual` and its path is used
verbatim — the user named it, so 4.2's `exeName` check does not apply, though the file-exists check
still does.

This is the answer to every gap in 4.1 rather than a courtesy: per-user installs (§10.11,
untested), portable and AppImage installs with no install location at all, a vendor whose
`DisplayIcon` does not name the main executable (§10.14), and any sixth slicer someone wants to
point at a `.3mf`. It costs one dialog, it is testable, and the trust story — the user chose this
path — is better than any glob's.

### 4.6 Other platforms

D implements Windows. `SlicerDef.windows` is a named field rather than a flat set of properties so
that a `darwin` or `linux` sibling is an addition and not a rewrite, and the launcher's `spawn` is
injected (9.1) so a platform that cannot use it plugs in at the same seam.

Nothing about macOS or Linux detection is designed here. What is known is only that it shares
nothing with the above: `.app` bundles and `CFBundleIdentifier` on one side; `.desktop` files,
`XDG_DATA_DIRS`, AppImage, Flatpak and Snap on the other. On a non-Windows platform the app reports
no detected installs and offers manual entry, which is the honest degradation and happens to be the
only mechanism that could work on all three.

## 5. Slicer configuration: shape and location

### 5.1 Its own file in `userData`

Parent §3.7 puts slicer configuration in Electron's `userData` and not in `app.db`, because
executable paths are machine-specific and must not travel with a library shared from a remote
server. D adds a second boundary inside `userData`: **`slicers.json`, not `state.json`** (D-10).

`state.json` (C plan, task 4) holds the shell's mode, its remembered folder and its remembered
remote origin — three keys, written on the rare occasions a user answers a question about which
library there is. Slicer configuration is a list with a different shape and a different lifetime,
rewritten by every detection scan and every binding change. They share a **writer**, not a file:
`state.ts`'s atomic write-temp/fsync/rename is extracted to a `json-store.ts` that both call, with
its existing tests intact. One corrupt write should cost the user their slicer bindings or their
library choice, never both.

### 5.2 The shape

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
    {
      "id": "msix:OrcaSlicer.OrcaSlicer_3qd7h69xpne0g",
      "slicerId": "orca",
      "label": "OrcaSlicer",
      "origin": { "kind": "msix", "packageFamily": "OrcaSlicer.OrcaSlicer_3qd7h69xpne0g" },
      "version": "2.4.3.0",
      "pathHint": "C:\\Program Files\\WindowsApps\\OrcaSlicer.OrcaSlicer_2.4.3.0_x64__3qd7h69xpne0g\\orca-slicer.exe",
      "addedAt": 1756382400000,
    },
  ],
  "bindings": {
    "cura": "registry:HKLM\\WOW6432Node:UltiMaker Cura 5.13.0",
    "orca": "msix:OrcaSlicer.OrcaSlicer_3qd7h69xpne0g",
  },
  "defaultSlicerId": "orca",
}
```

- `installs` is what detection and manual entry produce. A scan **merges**: new installs are added,
  ones that no longer resolve are marked rather than dropped, and manual entries are never touched.
  A scan that silently re-pointed a user's binding would undo the one decision D asks them to make.
- `bindings` is D-7's "the user chooses which install a `SlicerId` launches". A `SlicerId` with
  exactly one install is bound to it on first scan, because there is nothing to choose; a
  `SlicerId` with two is left unbound and the UI asks.
- `version: 1` so a file written by a newer build is _recognised_ as unreadable rather than
  misread. On an unrecognised version the app runs with no configured installs, says so, and
  **refuses to write over the file** until the user explicitly resets it — a downgrade quietly
  overwriting a newer config is worse than a feature being unavailable for one launch.
- An unparseable file degrades to "no configuration" with a warning in the log, exactly as
  `readState` does today, and for the same reason: a hand-edited file must not stop the app.

### 5.3 The default slicer, and what parent §3.4 rule 4 wanted from it

Parent §3.4 reports `slicer = null` for a saved-but-unsliced project deliberately, "so the UI can
fall back to the user's default slicer instead of launching the wrong one". D owns that default:
`defaultSlicerId`.

It is worth naming how often that fallback is the _normal_ path rather than an edge case. It is
used whenever the file being launched does not name a slicer, which is:

- a rule-4 project — the case parent §3.4 wrote it for;
- a `.3mf` that failed header detection;
- **and every `kind='model'` file** — every `.stl`, `.obj` and plain-mesh `.3mf`. Parent §7.1
  counts 1,311 STLs against 401 3MFs in the reference library. The default is not a fallback for
  an odd file; it is the primary launch path for most of the library.

`defaultSlicerId` lives in `slicers.json` and **not** in `user_settings` (parent §3.3), even though
that table is where the app's other preferences live. `user_settings` rows travel with the library:
in remote mode they are in the server's database, shared across every machine that user logs in
from. A default naming a slicer that is not installed on _this_ machine is worse than no default,
and parent §3.7's rule already says machine-specific configuration does not go in `app.db`.

## 6. The launch paths

Two, and the difference is visible to the user because it has to be: one opens their project, the
other starts a new one from it.

### 6.1 Open as-is

For a `kind='slicer_project'` file. The slicer named by `files.slicer` is launched against the file
unchanged; if `slicer` is null, the default (5.3) is used and the UI says which slicer it picked
and why.

In **local mode** this launches the real library path, resolved through core's `resolveFilePath`
(and so through `safeJoin`). No copy, no strip, no watch. That is safe because of rows 6, 7 and 13:
nothing locks the file, opening it modifies neither the file nor its folder, and no litter appears
beside it. And it is _useful_ because of row 8: four of five save back in place, so the user's work
lands in the project folder and the next rescan (parent §3.5) indexes it with no involvement from
D at all.

The exception is Cura, in local mode as much as remote: row 9 says Ctrl+S is a Save-As into a
sticky global directory that on this machine points at a different project's folder in the user's
real library. The app neither causes this nor can fix it; 6.4 says what it tells the user.

In **remote mode** there is no local path, so this becomes 7's download-launch-watch-reconcile
loop.

### 6.2 Start a new slicer project from a file

For any file the user wants as a starting point, whatever its `kind`. The slicer is the user's
choice, defaulting to `defaultSlicerId` — this path exists precisely because the target is usually
_not_ the slicer that wrote the file.

1. Classify the source with `classify3mf` to select the strip set (3.4).
2. **If there is nothing to strip** — a `.stl`, an `.obj`, a plain-mesh `.3mf` — launch the source
   file directly, with no copy. Measured (row 8): importing a mesh gives an untitled project in all
   five, and four of five propose `<basename>.3mf` **beside the model** on the first save, which in
   local mode puts the new project straight into the project folder where the rescan will find it.
   Copying the file somewhere else would break that, so it is not copied.
3. **Otherwise** write the stripped copy (3.5) into a launch directory and launch that.
4. Watch the launch directory and reconcile what comes back (6.3, 7.3).

The stripped copy keeps the source's basename, because the basename is what four of five slicers
propose on save and what Cura carries into its Save-As dialog.

Step 4 is not optional and not remote-only. Row 8 says the four in-place savers write back to the
path they were launched with — which for a stripped copy is the launch directory, not the project.
Row 20 says the file reappears there complete even if it was deleted. So in local mode too, this
path produces a file outside the library that is the user's work, and the app has to offer it back.
**Path B is the same loop as remote mode with a shorter first step**, and it is built once.

### 6.3 The launch directory, and the lifetime of the temp file

One directory per launch: `<userData>/slicer-sessions/<launchId>/`, holding the file and a
`launch.json` recording `{ launchId, mode, projectId, fileId, slicerId, installId, fileName,
launchedHash, startedAt }`. Self-describing, deleted with the directory, and it survives a crash —
which matters, because the cleanup rules below have to work after one.

The temp file is temporary and is **never stored in the project** (D-3). The project keeps the
user's original.

Cleanup is three sweeps, and the reason there are three is that **there is no dependable
"slicer closed" signal**:

1. **Not at spawn + N seconds.** Deleting early is safe — row 20, four slicers, none noticed — but
   pointless: the file _reappears_, complete, at the same path, the moment the user saves. An early
   delete only guarantees the reappearance happens unwatched.
2. **When the spawned process exits.** Row 3 makes this observable on Windows: the pid returned by
   `spawn` is the app. But row 4 makes it insufficient — `single_instance` is a user setting, and
   with it on, the spawned process hands the file to a running instance and exits while the slicer
   stays open with the user's work in it. So this sweep runs, and is not final.
3. **At next app start**, over every `slicer-sessions/*` directory not belonging to the current
   process. This is the only sweep guaranteed to run after every slicer that could have touched the
   file has gone, because by then the app itself has restarted.

Sweeps 2 and 3 **compare before deleting**. If the file's content hash (7.3) differs from
`launchedHash`, the user saved something, and deleting it discards work. Such a directory survives
and is surfaced as an unfinished session (`slicers.sessions`, 8.3) on `/settings/slicers` and on
the project it belongs to. Only an unchanged directory is deleted without asking.

A cap is needed or unfinished sessions accumulate forever: directories older than 30 days are
listed with their age and can be discarded in one action, but are not deleted automatically. The
number is a judgement, not a measurement, and is written down here so a later change knows it was
chosen rather than fallen into.

### 6.4 What the app may honestly say

**A successful spawn is not evidence the file opened** (D-8, rows 2 and 12). Three of five slicers
never put a filename in the window title, Orca shows the project name for a `.3mf` but `*Untitled`
for a `.stl`, and Anycubic's failure mode is a healthy process in front of an empty plate. The app
cannot see the plate and must not pretend to.

So the UI says **"Handed _file_ to _slicer_"**, and never "opened in your slicer".

Beside it, the app states what it _knows_ will happen, from the registry's `behaviour` fields —
these are measured facts about named products, not guesses:

| Situation                                           | What the app says (measured)                                                               |
| --------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| PrusaSlicer, any `.3mf`                             | It will ask what to do with the file before opening it, and nothing loads until you answer |
| Bambu, a file it did not author                     | It will say the config is invalid and load geometry only                                   |
| Anycubic, a Bambu-lineage project, **not** stripped | It may discard the file without telling you — which is why the new-project path strips     |
| Orca, a project from another Bambu-lineage slicer   | It will warn about the version and may rewrite print settings                              |
| Any                                                 | A slicer can take up to a minute to show a window (measured 2 s to 35 s)                   |
| Any, first run                                      | It may open a configuration wizard or an update prompt in front of your model              |

What the app _can_ observe is exactly one thing: whether the process it spawned is still alive. It
shows that, labelled as what it is. It does not present process exit as "the slicer was closed",
because row 4 says a handed-off instance outlives it.

### 6.5 How a project is created today, and where a `.3mf`-seeded project fits

Established from the code, not assumed:

- `projects.create({ name, website?, notes?, tags? })` creates a row and an **empty folder**
  (`packages/core/src/projects/usecases.ts`). It takes no file.
- Files arrive afterwards through `files.upload(projectId, name, body)`, from the upload control on
  the project detail page.
- So **there is no "create a project from a selected `.3mf`" flow in the app today**, and D does
  not need to introduce one into `core`: it is `projects.create` followed by `files.upload`, two
  calls that already exist, over an interface both shells already implement.

D's "new project" is therefore the **slicer's** project, not the app's: 6.2 hands a stripped copy
of a file already in the library to a slicer, and what comes back is offered as a new file in the
same project. If a `.3mf`-seeded _app_ project is wanted later, it is a UI composition of two
existing calls and it belongs to whichever subsystem asks for it — spec E is the obvious candidate,
since an intercepted download is exactly that shape.

**The returning file is added, never substituted.** `uploadFile` refuses a name that already exists
(`Conflict`, checked against both the `files` index and the disk, with an exclusive `open(…, 'wx')`
behind it), and D does not add an overwrite path to core to get around that — it would change the
server's observable behaviour, which the C plan's constraint 2 forbids. It would also be wrong on
its own terms: row 15 says a cross-slicer round trip is lossy, so overwriting the original destroys
the only copy of something the user may not have meant to convert. The new file gets a
non-clashing name derived from the original and the slicer that produced it, and the user deletes
the old one with the control that already exists if they want to.

## 7. Remote mode — parent §2.7

Parent §2.7 records this as "the most awkward corner of the design", belonging to D and "not
solved". Here it is solved for four slicers and stated as a limit for the fifth.

### 7.1 The cache is a launch directory

Remote mode reuses 6.3's structure exactly: one `slicer-sessions/<launchId>/` per launch, holding
the downloaded file and its `launch.json`. There is no separate long-lived cache. A per-launch
directory is what makes the reconcile unambiguous — one directory, one file, one record of what was
launched — and row 13 says nothing else will ever appear in it.

The download is done **by the main process**, not the renderer: `remote.ts` already proxies
`/api/files/<id>/raw` and already holds the session cookie, so the bytes never round-trip through
the window. The renderer names a `fileId` and never a path (8.2).

Row 6 is what makes the whole thing tractable and is worth restating: no slicer holds a handle on a
file it has read, so the app can replace, rename, re-download or delete a launch file while the
slicer is still open, with no coordination and no "file in use" failure mode.

### 7.2 The watch

`fs.watch` on the launch directory with a settle delay, plus a low-frequency poll while a session
is live.

Both, and not one, because of what was measured:

- **Cura's write is not atomic and it locks.** The target sat at 0 bytes and exclusively locked for
  at least six seconds (row 12). A watcher that read on the first event would find a zero-byte file
  and a `Get-FileHash` failure. So a read that finds 0 bytes, `EBUSY`/`EACCES`, or a ZIP whose
  central directory does not parse means **not settled yet** — retried with backoff for a bounded
  window (60 s at 500 ms, generous against a six-second measurement) before it is reported as
  unreadable.
- **The watch is an optimisation, not the mechanism of record.** What decides whether anything came
  back is a _comparison_ (7.3), run on the watch event, on process exit, and at next app start. A
  missed `fs.watch` event therefore costs promptness, never correctness — which is the property
  worth having, given that Orca's save was invisible to a 40 ms poll except as a completed change.

Anything appearing in the directory that is not the launched file is reported rather than adopted.
Row 13 says nothing should, so something that does is information.

### 7.3 Change detection: hash the decompressed entries

**Neither a whole-file hash nor mtime is valid** (D-5):

- Three of the four in-place savers produce a different container hash for byte-identical content,
  because they write wall-clock ZIP timestamps (row 10). PrusaSlicer additionally stamps
  `; generated by PrusaSlicer 2.9.6 on … at HH:MM:SS UTC` into the payload of
  `Metadata/Slic3r_PE.config`. Cura alone is byte-stable — and Cura is the one that never writes
  back to the launch file at all.
- mtime fails in both directions (row 11): the four in-place savers skip the write entirely when
  nothing is dirty, and Cura's re-save of unchanged content moved it.

So:

```
entryHash(file) =
  sha256 over, for each entry in name order:
    entry name, then the DECOMPRESSED bytes
  excluding, in Metadata/Slic3r_PE.config, the leading "; generated by … at … UTC" comment line
  ignoring: local and central headers, timestamps, compression method, entry order
```

For a file that is not a ZIP — an `.stl` launched directly by 6.2 step 2 — the hash is a plain
SHA-256 of the bytes. Nothing measured argues against that; it is stated as the fallback it is.

mtime is kept as a **hint** for when to bother computing the hash, and never as an answer.

### 7.4 Reconcile, and the identity of the returning file

When `entryHash` differs from `launchedHash`, something came back. The app then, in order:

1. **Re-classifies it** with `classify3mf`, and carries **the returning file's** slicer identity,
   not the record's (D-6). Row 15: a Bambu project opened in Orca and saved comes back `orca`. A
   round trip can change what the file _is_.
2. **Shows the user the difference before anything is uploaded**: the original file and its
   classification, the returning file and its classification, and the sizes. Where the two
   classifications differ, it says plainly that the round trip converted the file — and it can say
   what that cost in the one case that was measured: `Metadata/cut_information.xml` was dropped and
   one print setting (`ensure_vertical_shell_thickness`) was rewritten from `enabled` to
   `ensure_all` without asking.
3. **Uploads on the user's word, as a new file** (6.5), through `files.upload` — which means it
   inherits the quota check (parent §5.6) with no extra code.

**Never automatic.** Two independent reasons, both measured: a cross-slicer trip is lossy, and 6.2's
returning file is a _new_ project the user may not want in the library at all. An app that silently
uploaded either would be making a decision it has no evidence for.

### 7.5 Cura cannot be promised a round trip

This is stated as a limit rather than half-solved (D-4), because the C plan's instruction on parent
§2.7 was that it "must not be half-solved".

**What was measured** (§13, three separate confirmations): Cura never saves in place. Ctrl+S is
always a Save-As. It defaults to a sticky global directory read from `%APPDATA%\cura\<ver>\cura.cfg`
`dialog_save_path`. It re-prompts on a second Ctrl+S with nothing changed, still pointing at that
foreign directory. It re-prompts even for the file it was launched with, carrying only the basename
across. And if the user types the launch path back in, it asks whether to overwrite — it does not
recognise the path it opened from.

**Therefore:** in remote mode, "open in slicer" with Cura cannot round-trip. The launch file will
be unchanged, the watch will fire on nothing, and the user's work will be in a folder on their own
machine that the remote library knows nothing about.

**What the app does:** says so, before launching, once per session with a "don't show again". The
launch still happens — Cura against a downloaded file is perfectly useful for viewing and slicing,
and refusing would make the app less useful than having no feature. Afterwards the app points at
the upload control, which is how the file gets into the project.

**The hazard, named** (D-4): Cura's default save directory on the measured machine is
`D:\SynologyDrive\3D Druck\Print files\Mama - Küchenschrankbox` — a real folder in the user's real
library, containing two of their own projects. A user who presses Ctrl+S and Enter writes a copy
into it. In _local_ mode that means a surprise project file adopted by the next rescan into a
folder the user was not working in. In _remote_ mode it is worse in a quieter way: the file lands
in a local library the remote server will never see, and a later local-mode session of this same
app will adopt it into an unrelated project. The app neither causes this nor can fix it. Its
obligation is to name it, which the pre-launch notice does.

**Alternatives considered and rejected:**

| Alternative                                                         | Why not                                                                                                                                                                                                                                                                                                                                                                                                |
| ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Watch `dialog_save_path` in `cura.cfg` and pick up what lands there | §19.1: it is **unmeasured** whether navigating the dialog even updates that key — typing an absolute path did not — so the mechanism may never fire. And it names a _directory_, so the app would be adopting the newest `.3mf` in a folder it does not own, which on this machine is the user's library. A feature that can silently upload an unrelated project to a server is worse than no feature |
| Watch a broader set of directories                                  | The same adoption hazard, with a wider blast radius                                                                                                                                                                                                                                                                                                                                                    |
| Drive Cura's save dialog                                            | This is CuraManager's UI-Automation hack. Parent §1.3 names it as one of two behaviours deliberately not carried over: Windows-only, dependent on the control tree, broken by most Cura releases                                                                                                                                                                                                       |
| Refuse to launch Cura in remote mode                                | Removes a use that works (view, slice, print) to prevent one that does not. The user is better served by being told                                                                                                                                                                                                                                                                                    |
| Treat Cura as export-only: download, launch, delete                 | Indistinguishable to the user from the above, minus the notice, plus a deleted file that row 20 says would come back anyway                                                                                                                                                                                                                                                                            |

## 8. Capabilities, API surface, and the seams

### 8.1 The capability flip

D sets `canLaunchSlicer` and `canConfigureSlicers` to `true` in **both** desktop shell columns —
`LOCAL_SHELL_CAPABILITIES` and `REMOTE_SHELL_CAPABILITIES` in `packages/desktop/src/capabilities.ts`
(D-11). The browser column is untouched: the Deno server keeps reporting both false from
`/api/capabilities`, and the union (`||`, shell-owned rows) is what makes the desktop app pointed
at that server able to launch a slicer anyway. That row is the one parent §2.4 wrote the union for.

**Correcting a comment in that file.** `LOCAL_SHELL_CAPABILITIES`' docblock currently says "When D
flips `canLaunchSlicer` here it lights up in **both** modes with no other change". That is wrong:
remote mode unions `REMOTE_SHELL_CAPABILITIES` (`remote.ts:305`), and local mode returns
`LOCAL_SHELL_CAPABILITIES` (`shell.ts:170`), so flipping one leaves the other false. D flips both
and fixes the comment. The existing test file already anticipated D correctly — its "a backend
cannot veto a capability the shell has" case builds its own column with the three flags true — so
only the two whole-object assertions (`capabilities.test.ts`, the `LOCAL_` and `REMOTE_` deep
equals) change.

### 8.2 The seam: `SHELL_CLIENT`, not `API_CLIENT`

Slicer operations reach the main process through `SHELL_CLIENT`
(`packages/web/src/app/features/desktop/shell-client.token.ts`), not `API_CLIENT` (D-9).

Its docblock already explains why, and the reason applies here unchanged: `API_CLIENT` is whatever
transport the _library_ is on, and in remote mode that is `HttpApiClient`. Slicer launching is a
shell concern that must work in both modes, so it needs the one transport that always reaches the
main process. `/settings/slicers` and the launch controls inject `SHELL_CLIENT`.

The methods still go **on the `ApiClient` interface**, refused by `HttpApiClient` exactly as
`library.pick` and `library.connect` are (an `AppError('Forbidden', …)`). That is what gets them
the guarantees the interface already has: the dispatch table is a mapped type over `ApiClient`'s
paths, so a method added to the interface and not implemented in the desktop shell **fails
`deno task typecheck`**, and the table's key-set test fails too.

One structural consequence, easy to get wrong: **every slicer entry is a `shellCall`, not a
`libraryCall`.** In remote mode `deps.session` is null — there is no local library — and
`libraryCall` refuses a null session by design. The slicer host resolves files itself: through
`resolveFilePath` in local mode, through the remote proxy in remote mode.

And the security seam: **`slicers.open` takes a `fileId`, never a path.** The renderer is the
untrusted side of the IPC boundary (C plan, constraint 4) and must never name a filesystem
location; the main process resolves the id through core's `safeJoin` or through the server. The
only path the renderer can cause to be executed is one the user picked in a native dialog (4.5).

### 8.3 The interface additions

```ts
slicers: {
  /** The stored configuration: installs, bindings, default. No subprocess. */
  get(): Promise<SlicerConfigDto>

  /** Runs detection, merges the result into the stored configuration, returns it. */
  scan(): Promise<SlicerConfigDto>

  /** Native executable picker. Null when the user cancels — not an error (cf. `library.pick`). */
  addManual(slicerId: SlicerId): Promise<SlicerConfigDto | null>

  remove(installId: string): Promise<SlicerConfigDto>
  bind(slicerId: SlicerId, installId: string | null): Promise<SlicerConfigDto>
  setDefault(slicerId: SlicerId | null): Promise<SlicerConfigDto>

  /**
   * Launch. `mode: 'as-is'` is 6.1, `mode: 'new-project'` is 6.2.
   * `slicerId` overrides the file's own / the default.
   */
  open(
    fileId: string,
    opts: { mode: 'as-is' | 'new-project'; slicerId?: SlicerId },
  ): Promise<SlicerLaunchDto>

  /** Live sessions plus unreconciled ones left by previous runs (6.3). */
  sessions(): Promise<SlicerSessionDto[]>

  /** Answer one: import what came back, or discard the session. */
  resolveSession(launchId: string, action: 'import' | 'discard'): Promise<FileDto | null>
}
```

```ts
SlicerInstallDto {
  id: string
  slicerId: SlicerId
  label: string
  version: string | null          // null for a manual entry with no readable version
  path: string
  origin: 'registry' | 'msix' | 'manual'
  state: 'ok' | 'missing'         // pathHint failed to resolve, and re-resolution found nothing
}

SlicerConfigDto {
  installs: SlicerInstallDto[]
  bindings: Partial<Record<SlicerId, string>>
  defaultSlicerId: SlicerId | null
  detectionSupported: boolean     // false off Windows (4.6) — the UI offers manual entry only
}

SlicerLaunchDto {
  launchId: string
  slicerId: SlicerId
  installLabel: string
  stripped: boolean
  /** What the app will say instead of "opened" (6.4), already resolved for this pairing. */
  notices: string[]
  /** Present where the spawn is observable; row 3 says it is on Windows, and 10.4 says not everywhere. */
  pid: number | null
}

SlicerSessionDto {
  launchId: string
  projectId: string; fileId: string; fileName: string
  slicerId: SlicerId
  startedAt: number
  processAlive: boolean
  /** 'unchanged' | 'changed' | 'settling' | 'unreadable' — see 7.2 and 7.3. */
  fileState: string
  /** Set when `fileState === 'changed'` and the classification differs from the source (7.4). */
  returnedAs?: SlicerId | null
}
```

### 8.4 `/settings/slicers` and the routes

Parent §6.3 lists `/settings/slicers` as electron-only. It is added to `routes.electron.ts` — which
today carries `desktop/connect` and a placeholder — under `./features/desktop/slicers/`, with
`authGuard`, matching `/settings`. In local mode `requiresAuth` is false and the guard passes on
its first arm; in remote mode an unauthenticated window has no business anywhere but `/login`.

The existing `/settings` page (a single card of three selects, in `features/settings/`, shared by
both builds) gains a link to it, rendered only when `canConfigureSlicers` is true. Two details an
implementer would otherwise get wrong:

- The link is a `routerLink` **string** and nothing more. `features/settings/` is shared code and
  must not import anything from `features/desktop/` — parent §2.5's rule, and the one CI's bundle
  greps enforce.
- The target route does not exist in the web build at all, so a rendered link there would fall
  through to the `**` redirect. It is never rendered, because the capability that gates it is false
  in the browser column. This is the capability model doing its job in place of a build-time
  condition, which is the whole point of parent §2.4.

The page shows: detected and manual installs grouped by product with their versions and paths; the
binding for each `SlicerId` where there is a choice; the default slicer; a rescan button; manual
add and remove; and the unfinished-session list from 6.3. On a platform where
`detectionSupported` is false it shows manual entry and says detection is Windows-only.

## 9. Testing

### 9.1 What the seams buy

`spawn` is injected into the launcher, the way `fetch` is injected into `remote.ts`, and the
detection subprocess is injected as "a function that returns the JSON document". The launcher, the
session lifecycle, the sweep rules and the reconcile decision are then all testable under plain
`node --test` with no slicer, no Electron and no Windows.

### 9.2 What must be asserted, and one thing that cannot be

- **The strip registry**, in core, under both runtimes: a stripped file classifies as `model`, and
  **never** as rule-4 `slicer: null` — row 17 is the trap and this is the assertion that catches a
  half-strip. Plus: surviving entries are byte-identical, `_rels` relationships to removed parts are
  gone, an unsupported archive fails rather than producing a broken file.
- **Change detection**, fully: two archives with identical entry contents and different ZIP
  timestamps hash equal; two `Slic3r_PE.config`s differing only in the generated-on line hash
  equal; one changed byte hashes differently. This is where row 10 becomes a test rather than a
  memory.
- **Detection parsing**, over a checked-in fixture of the spike's own PowerShell JSON output —
  including both Cura rows and the MSIX row. The subprocess is a boundary; the parse is a value,
  and the value is what has the two-Cura and MSIX-Orca cases in it.
- **The no-installs path** (2.1): a fixture with nothing detected, asserted to produce a usable
  page and a refused launch with a real message. It is the path the spike could not exercise at
  all, so it is the one most likely to be wrong.
- **The server is untouched**: core's new modules are imported by no route, and the server's
  responses are unchanged. Assert it; the C plan's constraint 2 is a defect if violated regardless
  of what a task says.
- **What cannot be tested here:** whether stripping actually stops a slicer prompting. The repo
  contains no real slicer fixtures at all (row 27) — `packages/core/test/fixtures/` holds
  generators — and generated archives with the right entry names prove the rewriter works, not that
  Cura is satisfied. Rows 16 to 18 stay measured facts carried by this document, and the plan
  should not pretend a test covers them.

## 10. Open questions

Answered where the evidence allows, and marked unmeasured with the cost of settling it where it
does not.

1. **Does the five-entry Bambu-lineage strip set work in Orca and Bambu?** **Unmeasured.** Orca was
   measured with three of the five; Anycubic with all five. The set chosen (3.4) is a superset of
   both, and no stripped file was ever rejected, but that is an argument. _To settle:_ two launches,
   about two minutes each.
2. **Which single entry in that set is load-bearing?** **Unmeasured** (§23.1), and it does not
   block: D-2 forbids partial sets anyway, so knowing would only shrink the set, not change the
   design. _To settle:_ three launches at 45–60 s each.
3. **Does `show_drop_project_dialog = 0` make PrusaSlicer load a `.3mf` silently?** **Unmeasured**
   (§10.3, §19.2) — it requires changing the user's PrusaSlicer configuration. It does not change
   the design either way: the app never writes to a slicer's config (1.2). If the answer is yes,
   the most the app should do is mention the setting exists.
4. **macOS and Linux.** **Unmeasured, and expected to invert.** `open -a` returns no child pid, so
   row 3 — "the spawned pid is the app", which 6.3's second sweep and `SlicerLaunchDto.pid` both
   rest on — fails there. A document-open AppleEvent to a running app is the macOS default, so row
   4's "nothing hands off" inverts too. Flatpak's sandbox may be unable to read a launch directory
   outside its allowed paths, which would break §7 outright rather than complicate it. D ships
   Windows and reports `detectionSupported: false` elsewhere. _To settle:_ a machine of each, and a
   spike of the same shape as this one's Part 1.
5. **Is `DisplayIcon` reliably the main executable across other vendors' builds?** Five of five on
   one machine (§10.14). _Mitigated rather than settled_: 4.2 validates the basename against the
   registry row's expected executable, and 4.5's manual entry is the escape hatch.
6. **Per-user installs under `%LOCALAPPDATA%\Programs`.** The `HKCU` branch is implemented and
   **untested against a positive** (§10.11) — no such install exists on the measured machine.
7. **Orca via its AUMID** (`shell:AppsFolder\OrcaSlicer.OrcaSlicer_3qd7h69xpne0g!OrcaSlicer`).
   **Unexercised** (§10.9). Direct execution of the `WindowsApps` executable worked from a
   non-elevated process and accepted argv, so it is the primary route. The risk, named: whether a
   packaged app that expects package identity degrades when launched that way is unknown, and the
   fallback (`IApplicationActivationManager::ActivateForFile`) needs a native binding this project
   does not have. If it ever proves necessary, that is a dependency decision, not a detail.
8. **Should the returning file replace the original or be added?** **Answered: added, always, and
   only on the user's word** (6.5). Two reasons, both hard: `uploadFile` refuses a clashing name by
   design and D will not add an overwrite path to core; and a cross-slicer round trip is measurably
   lossy, so an overwrite can destroy the only copy of the original.
9. **Should detection run at startup?** **Answered: no** (4.2). It costs a PowerShell process, its
   result is only needed on a settings page or at a launch, and a stale `pathHint` is caught by a
   `stat` before every spawn anyway.
10. **Should the app offer to slice, export G-code, or read profiles headlessly?**
    **Answered: not in D.** `prusa-slicer-console.exe` is a genuinely capable headless tool (§7) and
    Anycubic has a full CLI, but Cura, Bambu and Orca offer nothing comparable, and parent §1.2 puts
    G-code out of scope for the product. Recorded because the capability is real and someone will
    find it.
11. **Should `classify.ts` adopt the `Application` metadata in `3D/3dmodel.model` as a second
    detection signal?** **Deferred, with the reason** (3.6): it is a stronger signal that survives
    stripping, and adopting it would reclassify files already indexed in every existing library —
    a change to the server's observable behaviour that deserves its own measurement rather than
    riding in on D.
12. **Cura's `dialog_save_path` as a way to find where the user saved.** **Rejected**, reasoning in
    7.5's table: unmeasured whether it even updates, and it names a directory the app does not own.
13. **Does slicing before saving change any of this?** **Unmeasured** (§19.3). Every save measured
    was of an unsliced project. Row 10 — the determinism result the whole of 7.3 rests on — has not
    been re-run against a project with G-code and per-plate slice data in it. _To settle:_ one save
    per slicer after an actual slice, and a re-run of the two-saves-of-identical-content diff.
