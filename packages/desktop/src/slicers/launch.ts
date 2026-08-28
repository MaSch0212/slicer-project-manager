import { randomUUID } from 'node:crypto'
import { copyFileSync, mkdirSync, rmSync } from 'node:fs'
import { basename, extname, join } from 'node:path'
import type {
  SlicerId,
  SlicerLaunchDto,
  SlicerLaunchMode,
  SlicerLaunchOptions,
} from '@spm/contract/dtos.ts'
import { AppError } from '@spm/contract/errors.ts'
import {
  classifyFile,
  entryHash,
  getProject,
  resolveFilePath,
  strip3mf,
  stripRefusalReason,
  type Classification,
} from '@spm/core'
import { writeJsonFile } from '../json-store.ts'
import type { DesktopSession } from '../library.ts'
import type { SlicersHost } from './host.ts'
import { SLICERS } from './registry.ts'

/**
 * Handing a file to a slicer, and saying only what the app actually knows about what happens next.
 *
 * **Nothing here imports `electron`.** `spawn` is injected the way `fetch` is injected into
 * `remote.ts` (D decision 9), the library session and the mode are read through closures, and so
 * the whole of this file — both launch paths, the refusals and the launch record — runs under
 * plain `node --test` with no slicer, no Electron and no Windows.
 *
 * ## The two paths, and why one of them writes nothing at all
 *
 * `as-is` (spec 6.1) launches the **real library path**, resolved through core's `resolveFilePath`
 * and so through `safeJoin`. No copy, no strip, no launch directory. It is safe because nothing
 * locks the file, opening modifies neither the file nor its folder, and no litter appears beside
 * it (spike §6); it is *useful* because four of five slicers save back in place, so the user's work
 * lands in the project folder and the next rescan indexes it with no further involvement from this
 * subsystem.
 *
 * **That in-place save is not a violation of constraint 8, and a reader may reasonably think it
 * is.** Constraint 8 forbids the app writing into the library as a *side effect* of launching.
 * Here the write is the user's entire intent — they asked to open their project and carry on
 * working in it — and it is made by the slicer, not by this process. This file writes into the
 * library on no path whatever.
 *
 * `new-project` (spec 6.2) starts a new slicer project from a file of any kind, usually in a slicer
 * other than the one that wrote it. It takes one of two branches:
 *
 * - **`.stl` and `.obj` are launched in place, with no copy.** Importing a mesh gives an untitled
 *   project in all five slicers and four of five propose `<basename>.3mf` *beside the model* on the
 *   first save (spike §13), which puts the new project straight into the project folder where the
 *   rescan will find it. Copying the mesh elsewhere would break exactly that.
 * - **Everything else goes through a launch directory** — a stripped copy where there is something
 *   to strip, a verbatim copy where there is not.
 *
 * **The first branch does not include a `.3mf`, and that is constraint 8.** `classify3mf` rule 5
 * makes any config-less `.3mf` a `model`, and `packages/core/src/previews/handlers.ts` counts 28
 * such files in the reference library. Launched in place, the slicer proposes `<basename>.3mf` —
 * which *is* the source file's own name — so it offers to write its project over the user's mesh,
 * behind a prompt that reads "overwrite my project?" and not "destroy the original mesh". A
 * `model`-kind `.3mf` is copied into a launch directory like everything else. This was a defect in
 * the first draft of the spec, which is why `test/slicers-launch.test.ts` asserts the exact path
 * that was spawned rather than trusting this paragraph.
 *
 * ## Never half-strip, and never fall back
 *
 * A strip that refuses refuses the whole launch (constraint 9). For Anycubic the tempting fallback
 * — launch the original instead — *is* the silent-discard case: a healthy process, an empty plate
 * and nothing saying why. The refusal names which of three problems it was, because they have
 * three different next moves, and it says that opening the file as-is is still available.
 */

/** The directory under `app.getPath('userData')` that holds one subdirectory per launch. */
export const SLICER_SESSIONS_DIR = 'slicer-sessions'

/** The record beside the launched copy. Task 5 reads these back. */
export const LAUNCH_RECORD_NAME = 'launch.json'

/**
 * `<userData>/slicer-sessions/<launchId>/launch.json`, written before the spawn.
 *
 * **Self-describing on purpose, and it outlives a crash.** Task 5's sweep and reconcile rules have
 * to work on a directory found at the next app start with nothing else to explain it: the app that
 * created it may have been killed, the slicer may still have the file open, and the only thing
 * that can say which project a returning `.3mf` belongs to is this file sitting next to it.
 *
 * `launchedHash` is `entryHash` of the file **as launched** — task 1's hash over decompressed ZIP
 * entries, never a whole-file hash and never mtime, both of which were measured failing on all four
 * in-place savers.
 *
 * **There is deliberately no `version` key, and `slicers.json` in this same subsystem has one.**
 * The asymmetry is a judgement, not an oversight: `slicers.json` is a document the app *rewrites*,
 * where a downgrade silently overwriting a newer build's configuration costs the user every binding
 * they made, so it refuses rather than guesses. A launch record is written once and only ever read,
 * and the change task 5 already has planned for it — a `sweptAt` timestamp — is additive, which a
 * version gate would not help with. A reader that cannot understand a record can say so from the
 * fields it finds. If a *breaking* change to this shape ever arrives, that is the moment to add one,
 * and the reader added with it has to treat a record with no `version` as this shape.
 *
 * Written only where there *is* a launch directory. The two in-place paths (`as-is`, and
 * `new-project` for a `.stl` or an `.obj`) create nothing and therefore record nothing: what a
 * slicer writes in those cases lands in the project folder, where the ordinary rescan finds it, and
 * there is no temp file whose lifetime anybody has to reason about.
 */
export type SlicerLaunchRecord = {
  launchId: string
  mode: SlicerLaunchMode
  projectId: string
  fileId: string
  slicerId: SlicerId
  installId: string
  /** The basename inside the launch directory — the source's basename, kept deliberately. */
  fileName: string
  launchedHash: string
  startedAt: number
}

/**
 * The part of a spawned child this file uses, and all of it.
 *
 * Narrow by design: everything else about `ChildProcess` — the exit event, the streams — belongs to
 * task 5's session lifecycle, and a seam that promised them here would be a seam whose test double
 * had to implement them. `pid` is optional and `undefined` rather than `null` so a real
 * `ChildProcess` satisfies it unchanged — that is the shape `child_process.spawn` returns for a
 * spawn that produced no pid, and a seam a real value cannot be assigned to is a seam that only
 * ever sees doubles.
 */
export type SpawnedSlicer = { pid?: number | undefined }

/** Injected (D decision 9). The real one lives in `app.ts`; every test passes a recorder. */
export type SpawnSlicer = (command: string, args: readonly string[]) => SpawnedSlicer

export type SlicerLauncherOptions = {
  /** `<userData>/slicer-sessions`. Created lazily, only by a launch that needs a directory. */
  sessionsDir: string
  /** Task 2's host, for `resolveInstall` and the configuration a launch reads. */
  slicers: SlicersHost
  /**
   * The library that is open **right now**, resolved per call rather than captured — the same
   * rule `dispatch.ts` and the protocol handler follow, and for the same reason: the user can
   * swap the folder without anything here being re-registered.
   */
  session: () => DesktopSession | null
  /** Whether the shell is pointed at a remote server, where there is no local path to launch. */
  isRemote: () => boolean
  spawn: SpawnSlicer
  /** `Date.now`, injected so `startedAt` is assertable. */
  now?: () => number
  /** `randomUUID`, injected so a launch directory has a name a test can predict. */
  newLaunchId?: () => string
}

/**
 * What the notices function is told about the file, beyond its classification.
 *
 * **`is3mf` is here because the classification cannot carry it, and one measured row needs it.**
 * PrusaSlicer's four-way "Load project file" modal is a function of the `.3mf` *extension* and not
 * of the file's content: the spike drove it down to a three-entry archive holding no configuration
 * of any kind and the modal still appeared (§20). A config-less `.3mf` and an `.stl` both classify
 * `{ kind: 'model', slicer: null }`, so a pure `Classification` would have to either warn about a
 * modal that an `.stl` never draws or stay silent about one that a `model`-kind `.3mf` always does.
 * Neither is honest, so the extension fact travels with the classification.
 */
export type LaunchedSource = {
  /** Of the **source**, which is what chose the strip set. Not of the copy that was handed over. */
  classification: Classification
  is3mf: boolean
}

/* -------------------------------------------------------------------------------------------
 * What the app may honestly say
 * ---------------------------------------------------------------------------------------- */

const PROMPT_BEFORE_LOADING =
  'It will ask what to do with the file before opening it, and nothing loads until you answer.'
const INVALID_CONFIG_GEOMETRY_ONLY = 'It will say the config is invalid and load geometry only.'
const MAY_DISCARD_SILENTLY = 'It may discard the file without telling you.'
const VERSION_WARNING_AND_REWRITE = 'It will warn about the version and may rewrite print settings.'
const GEOMETRY_DATA_ONLY = 'It will show one informational notice, "loading geometry data only".'
const SLOW_TO_SHOW_A_WINDOW =
  'A slicer can take up to a minute to show a window (measured 2 s to 35 s).'
const WIZARD_OR_UPDATE_PROMPT =
  'It may open a configuration wizard or an update prompt in front of your model.'

/**
 * The two products whose `Metadata/slice_info.config` header Anycubic's version check reads and
 * rejects — `X-BBL-Client-Version`, which both Bambu and Orca stamp (§16).
 *
 * **Anycubic is Bambu-lineage too and is deliberately not in here.** The spec's table says "a
 * Bambu-lineage project", but the measured cause of the silent discard is a version comparison
 * against a *foreign* writer's header, and warning that Anycubic may throw away the project
 * Anycubic itself wrote would be a false alarm on the commonest launch there is. That exclusion is
 * this set, and not a second `authored !== slicerId` clause below: with `discardsForeignProjects`
 * true for Anycubic alone, such a clause could never be false and a mutation removing it came back
 * green. `test/slicers-launch.test.ts` asserts the excluded case against this set instead.
 */
const BAMBU_LINEAGE: ReadonlySet<SlicerId> = new Set<SlicerId>(['bambu', 'orca'])

/**
 * What the app knows will happen, from the triple *(slicer launched, what the source was, whether
 * the copy was stripped)*.
 *
 * **A function of the triple, and not a lookup keyed by slicer** (spec 6.4). Two of the rows below
 * cannot be produced by a slicer-keyed table at all: Bambu's modal depends on whether the source
 * was Bambu's *own* project and on whether the app stripped it, and Anycubic's silent discard
 * depends on the source being Bambu-lineage and on the copy **not** having been stripped. A table
 * keyed by `SlicerId` would either lose both or state them unconditionally.
 *
 * Three of the four slicer-specific rows are driven by the registry's measured `behaviour` flags
 * rather than by an id comparison, so the sentences follow the product's measured property. Orca's
 * pair is driven by its id, because it is not one property: an unstripped foreign project draws a
 * version warning *and* a settings rewrite, a stripped one draws a single informational notice, and
 * inventing a `behaviour` flag for that would mean asserting its value for the other four products,
 * which nothing measured.
 *
 * The predicate everywhere is "a project this slicer did not author", not "another lineage". The
 * spec's table says "another lineage slicer", but the measurement it cites is Orca opening a
 * **Bambu** project (§16) — the same lineage — and it drew both modals. Where the prose and the
 * measurement disagree, the measurement wins.
 *
 * The last two rows apply to every launch: a slicer took between 2 s and 35 s to show a window on
 * the measured machine (§5), and PrusaSlicer's configuration wizard and Bambu's update prompt both
 * appeared in front of a model that had in fact loaded (§7).
 */
export function notices(slicerId: SlicerId, source: LaunchedSource, stripped: boolean): string[] {
  const { behaviour } = SLICERS[slicerId]
  const authored = source.classification.slicer
  const out: string[] = []

  // PrusaSlicer, any `.3mf`, stripped or not. Extension-driven and content-blind: measured down to
  // a three-entry archive with no configuration in it (§20). Stripping cannot remove it.
  if (behaviour.alwaysPromptsOn3mf && source.is3mf) out.push(PROMPT_BEFORE_LOADING)

  // Bambu, any `.3mf` it did not itself write — including one of its own that this app stripped,
  // because the modal fires on the *absence* of its own `Metadata/project_settings.config` and a
  // stripped Bambu project has none. **That exact pairing was inferred, not run**: §20 stripped a
  // Cura project and established the rule, and the rule is what this line applies.
  if (behaviour.promptsWithoutOwnConfig && source.is3mf && (stripped || authored !== slicerId)) {
    out.push(INVALID_CONFIG_GEOMETRY_ONLY)
  }

  // Anycubic, an unstripped Bambu-lineage project. This is the silent-discard case: process up,
  // window open, plate empty, nothing but a log line (§3, §20). Stripping is what fixes it, which
  // is why the notice is gone once the copy has been stripped. `authored !== null` is the compiler's
  // narrowing and not a rule of its own; which lineages count is `BAMBU_LINEAGE`.
  if (behaviour.discardsForeignProjects && !stripped && authored !== null) {
    if (BAMBU_LINEAGE.has(authored)) out.push(MAY_DISCARD_SILENTLY)
  }

  // Orca, a project it did not author. Unstripped it warns about the version and rewrites print
  // settings (§16, measured against a Bambu project); stripped, both of those go and one
  // informational "loading geometry data only" remains (§20).
  if (slicerId === 'orca' && authored !== null && authored !== slicerId) {
    out.push(stripped ? GEOMETRY_DATA_ONLY : VERSION_WARNING_AND_REWRITE)
  }

  out.push(SLOW_TO_SHOW_A_WINDOW, WIZARD_OR_UPDATE_PROMPT)
  return out
}

/* -------------------------------------------------------------------------------------------
 * The launcher
 * ---------------------------------------------------------------------------------------- */

/** What a strip refusal is called in a sentence, per `StripRefusalReason`. */
const REFUSAL_WORDING = {
  encrypted: 'it is an encrypted archive',
  unreadable: 'it could not be read as a 3MF archive',
  'configuration-left-behind': 'stripping it left slicer configuration behind',
} as const

/** What is spawned, and what had to be built to spawn it. */
type LaunchPlan = {
  /** The exact path handed to the slicer. */
  path: string
  /** The launch directory, or null for the two paths that copy nothing. */
  directory: string | null
  stripped: boolean
  source: LaunchedSource
}

export class SlicerLauncher {
  readonly #sessionsDir: string
  readonly #slicers: SlicersHost
  readonly #session: () => DesktopSession | null
  readonly #isRemote: () => boolean
  readonly #spawn: SpawnSlicer
  readonly #now: () => number
  readonly #newLaunchId: () => string

  constructor(options: SlicerLauncherOptions) {
    this.#sessionsDir = options.sessionsDir
    this.#slicers = options.slicers
    this.#session = options.session
    this.#isRemote = options.isRemote
    this.#spawn = options.spawn
    this.#now = options.now ?? Date.now
    this.#newLaunchId = options.newLaunchId ?? randomUUID
  }

  /**
   * Hands the file to a slicer, or refuses.
   *
   * The order of the steps is load-bearing. Everything that can refuse cheaply — the library, the
   * project, the file, the choice of product, the install's path — runs **before** anything is
   * written, so a launch that was never going to work leaves no directory behind. The strip is
   * next, then the record, then the spawn; the record is written before the spawn so a crash in
   * between still leaves a directory that says what it is.
   */
  async open(
    fileId: string,
    projectId: string,
    opts: SlicerLaunchOptions,
  ): Promise<SlicerLaunchDto> {
    const session = this.#requireLocalLibrary()

    // Ownership scoping is core's, not this file's: `getProject` joins against the owner and
    // throws `NotFound` for a project the caller does not own, which is what makes a `projectId`
    // from the untrusted side safe to accept. The file has to be *in* that project as well — the
    // record and task 5's reconcile both name the pair, and a mismatched pair would send a
    // returning file to the wrong project.
    const detail = getProject(session.lib, session.ctx, projectId)
    const file = detail.files.find((candidate) => candidate.id === fileId)
    if (!file) throw new AppError('NotFound', 'that file is not in that project', { fileId })
    const { absPath, name } = resolveFilePath(session.lib, session.ctx, fileId)

    const config = this.#slicers.get()
    const { slicerId, why } = chooseSlicer(opts, file.slicer ?? null, config.defaultSlicerId)
    const installId = config.bindings[slicerId]
    if (installId === undefined) throw unboundInstall(slicerId, config.installs)
    const { install, path: executable } = await this.#slicers.resolveInstall(installId)

    const launchId = this.#newLaunchId()
    const plan = this.#prepare(
      opts.mode,
      { kind: file.kind, slicer: file.slicer ?? null },
      name,
      absPath,
      join(this.#sessionsDir, launchId),
    )

    if (plan.directory !== null) {
      const record: SlicerLaunchRecord = {
        launchId,
        mode: opts.mode,
        projectId,
        fileId,
        slicerId,
        installId: install.id,
        fileName: basename(plan.path),
        launchedHash: entryHash(plan.path),
        startedAt: this.#now(),
      }
      writeJsonFile(join(plan.directory, LAUNCH_RECORD_NAME), record)
    }

    const pid = this.#spawnOrClean(executable, slicerId, plan)
    return {
      launchId,
      slicerId,
      installLabel: install.label,
      stripped: plan.stripped,
      notices: [...(why === null ? [] : [why]), ...notices(slicerId, plan.source, plan.stripped)],
      pid,
    }
  }

  /**
   * Builds — or deliberately does not build — the file the slicer is handed.
   *
   * The `.3mf` branch is decided on the **extension**, not on the classification, and that is the
   * whole of constraint 8 in one line: a config-less `.3mf` classifies exactly as an `.stl` does,
   * so a classification-driven branch would launch it in place and offer the slicer's project
   * over the user's mesh.
   */
  #prepare(
    mode: SlicerLaunchMode,
    indexed: Classification,
    name: string,
    absPath: string,
    directory: string,
  ): LaunchPlan {
    const extension = extname(name).toLowerCase()
    if (mode === 'as-is') {
      // Opening a file "as it is" only means anything for a file that *is* a slicer project. For a
      // mesh it would launch the mesh in place, which is the branch the module docblock refuses to
      // take; for anything else there is nothing for a slicer to open. The other path takes both.
      if (indexed.kind !== 'slicer_project') {
        throw new AppError(
          'Validation',
          'only a slicer project can be opened as it is; start a new slicer project from this file instead',
          { kind: indexed.kind },
        )
      }
      // The classification the app already holds, rather than a second read of a file nothing on
      // this path is about to touch: `kind` and `slicer` are what `rescan` computed with
      // `classifyFile`, and they are what the user was looking at when they pressed the button.
      return {
        path: absPath,
        directory: null,
        stripped: false,
        source: { classification: indexed, is3mf: extension === '.3mf' },
      }
    }

    if (extension === '.stl' || extension === '.obj') {
      return {
        path: absPath,
        directory: null,
        stripped: false,
        source: { classification: classifyFile(absPath), is3mf: false },
      }
    }

    // `basename`, not `name` — the copy must land inside the launch directory whatever the row in
    // the database says. Kept otherwise verbatim, because the basename is what four of five
    // slicers propose on the first save and what Cura carries into its Save-As dialog.
    //
    // Which leaves exactly one basename the copy may not have. `launch.json` is written into this
    // same directory a moment later, so a source of that name would be overwritten by its own
    // record — and in an order that is worse than it sounds: `launchedHash` is taken from the
    // user's bytes, the record then replaces them, and the slicer is handed the record. Nothing in
    // the library is lost, but task 5 would inherit a directory whose only file is a record whose
    // `launchedHash` cannot match it, which is precisely the shape its reconcile reads as "this
    // came back changed". Refused here rather than renamed: the basename is load-bearing on this
    // path, so the honest answer is that this one file cannot take it.
    const fileName = basename(name)
    if (fileName.toLowerCase() === LAUNCH_RECORD_NAME) {
      throw new AppError(
        'Validation',
        `a file called ${LAUNCH_RECORD_NAME} cannot be prepared for a new project, because the app writes a record of that name beside the copy it hands over`,
        { fileName },
      )
    }
    mkdirSync(directory, { recursive: true })
    const copy = join(directory, fileName)
    if (extension !== '.3mf') {
      copyFileSync(absPath, copy)
      return {
        path: copy,
        directory,
        stripped: false,
        source: { classification: classifyFile(absPath), is3mf: false },
      }
    }
    try {
      // Always writes the output — a verbatim copy where there was nothing to strip — so this one
      // call covers both halves of "the stripped copy where there is something to strip, a
      // verbatim copy where there is not".
      const result = strip3mf(absPath, copy)
      return {
        path: copy,
        directory,
        stripped: result.stripped,
        source: { classification: result.classification, is3mf: true },
      }
    } catch (error) {
      // Nothing was handed to anything, so there is nothing this directory could ever explain and
      // nothing a slicer could put back into it. That is what makes removing it here compatible
      // with constraint 10, which is about directories a slicer has *seen*.
      rmSync(directory, { recursive: true, force: true })
      refuseStrip(error, name)
    }
  }

  /** The one call that starts a process. A failed spawn takes its launch directory with it. */
  #spawnOrClean(executable: string, slicerId: SlicerId, plan: LaunchPlan): number | null {
    try {
      return this.#spawn(executable, SLICERS[slicerId].argv(plan.path)).pid ?? null
    } catch (error) {
      if (plan.directory !== null) rmSync(plan.directory, { recursive: true, force: true })
      throw new AppError('Internal', `could not start ${SLICERS[slicerId].displayName}`, {
        cause: String(error),
      })
    }
  }

  /**
   * The library this launch needs, or the reason there is none.
   *
   * Remote mode is refused rather than silently treated as "no folder open": in remote mode there
   * *is* a library, the app simply does not hold its bytes, and spec 7 is a different sequence —
   * download into the launch directory first, then classify, strip and launch. Task 5 builds it.
   * `details.reason` is what distinguishes the two for a UI, and is the line task 5 deletes.
   */
  #requireLocalLibrary(): DesktopSession {
    if (this.#isRemote()) {
      throw new AppError('Conflict', 'launching a slicer from a remote library is not built yet', {
        reason: REMOTE_LAUNCH_UNSUPPORTED,
      })
    }
    const session = this.#session()
    if (!session) throw new AppError('Conflict', 'no library folder is open')
    return session
  }
}

/** `details.reason` on the `Conflict` a remote-mode launch throws. Task 5 removes both. */
export const REMOTE_LAUNCH_UNSUPPORTED = 'remote-launch-unsupported'

/**
 * Which product to launch, and whether the user should be told how it was decided.
 *
 * An explicit choice always wins. Failing that, `as-is` uses the slicer the file itself names —
 * that is the whole point of the path — and both modes fall back to the configured default.
 * `new-project` deliberately does *not* consult the file's own slicer: the target of that path is
 * usually not the product that wrote the file, and defaulting to it would make the commonest use
 * of the feature the one that needs a manual override.
 */
function chooseSlicer(
  opts: SlicerLaunchOptions,
  fileSlicer: SlicerId | null,
  defaultSlicerId: SlicerId | null,
): { slicerId: SlicerId; why: string | null } {
  if (opts.slicerId !== undefined) return { slicerId: opts.slicerId, why: null }
  if (opts.mode === 'as-is' && fileSlicer !== null) return { slicerId: fileSlicer, why: null }
  if (defaultSlicerId === null) {
    throw new AppError(
      'Conflict',
      opts.mode === 'as-is'
        ? 'this file does not say which slicer wrote it, and no default slicer is set'
        : 'no slicer was chosen, and no default slicer is set',
    )
  }
  const chosen = SLICERS[defaultSlicerId].displayName
  return {
    slicerId: defaultSlicerId,
    why:
      opts.mode === 'as-is'
        ? `This file does not say which slicer wrote it, so your default (${chosen}) was used.`
        : `No slicer was chosen, so your default (${chosen}) was used.`,
  }
}

/**
 * A product with no install bound to it.
 *
 * **It names the choice and does not make it.** A product with exactly one install is bound
 * automatically when it is detected, so reaching here with candidates means either that there are
 * none, or that the user has more than one and has not said which — and preferring the newer of two
 * Curas is precisely the guess `/settings/slicers` exists to stop the app making.
 */
function unboundInstall(
  slicerId: SlicerId,
  installs: readonly { slicerId: SlicerId; label: string; state: 'ok' | 'missing' }[],
): AppError {
  const product = SLICERS[slicerId].displayName
  const candidates = installs.filter(
    (install) => install.slicerId === slicerId && install.state !== 'missing',
  )
  if (candidates.length === 0) {
    return new AppError(
      'NotFound',
      `${product} is not set up on this machine; add it under Settings, Slicers`,
      { slicerId },
    )
  }
  const labels = candidates.map((install) => install.label).join(', ')
  if (candidates.length === 1) {
    // Not a choice, so not phrased as one — and not bound automatically either. Reaching here with
    // one usable install means the user unbound it, or a second install went missing after they
    // were asked to choose; writing a binding out of a launch would undo the first of those
    // silently, on a code path whose job is to start a process.
    return new AppError(
      'Conflict',
      `${product} is installed (${labels}) but not chosen for launching; pick it under Settings, Slicers`,
      { slicerId },
    )
  }
  return new AppError(
    'Conflict',
    `this machine has ${candidates.length} installs of ${product} (${labels}); choose which one to launch under Settings, Slicers`,
    { slicerId },
  )
}

/**
 * Turns a `strip3mf` refusal into the sentence the user gets, and throws it (constraint 9).
 *
 * It names which of the three problems it was, because they have three different next moves, and
 * it says that the other path is still open — which matters, because the tempting silent fallback
 * from here is to launch the original, and for Anycubic that fallback is the empty plate.
 */
function refuseStrip(error: unknown, name: string): never {
  const reason = stripRefusalReason(error)
  // Not a strip refusal at all — a filesystem failure, say. It travels unchanged rather than being
  // dressed up as one of three reasons it is not.
  if (reason === null) throw error
  throw new AppError(
    'Validation',
    `${name} could not be prepared for a new project because ${REFUSAL_WORDING[reason]}. Opening it as it is, without stripping, is still available.`,
    { reason },
  )
}
