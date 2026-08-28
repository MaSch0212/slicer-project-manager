import { randomUUID } from 'node:crypto'
import { copyFileSync, mkdirSync, renameSync, rmSync, statSync } from 'node:fs'
import { basename, extname, join, resolve } from 'node:path'
import type {
  SlicerId,
  SlicerLaunchDto,
  SlicerLaunchMode,
  SlicerLaunchOptions,
} from '@spm/contract/dtos.ts'
import { AppError } from '@spm/contract/errors.ts'
import { fileNameSchema } from '@spm/contract/schemas.ts'
import {
  classifyFile,
  entryDigests,
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
import { remoteDownload, remoteProject, requireRemote, type RemoteProxy } from './remote-files.ts'

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
 * ## And remote mode, where there are no in-place paths at all
 *
 * In remote mode the library's bytes are on another machine, so there is no local path to launch
 * and **every** launch goes through a launch directory — `.stl` and `.obj` included. Path A
 * becomes the same loop as path B with a longer first step: create the directory, download the
 * source into it *main-process side* through `RemoteHost.proxy`, classify the download, strip it
 * where there is something to strip, then launch. The two in-place arguments above both rest on
 * the file already sitting in the project folder, and neither survives the file not being on this
 * machine at all: nothing a slicer saves in remote mode can reach the library except through an
 * upload the user asks for, which is `slicers.resolveSession('import')` and `sessions.ts`.
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
 * and every change task 5 made to it is additive, which a version gate would not help with. A
 * reader that cannot understand a record can say so from the fields it finds. If a *breaking*
 * change to this shape ever arrives, that is the moment to add one, and the reader added with it
 * has to treat a record with no `version` as this shape.
 *
 * **The four optional fields are task 5's, and every one of them exists because a field of
 * `SlicerSessionDto` cannot be produced without it.** They are optional on *read* because a record
 * written before them is still a record this build understands — a session missing one shows less,
 * never something wrong:
 *
 * - `sweptAt` — the record outliving the file it describes, for 90 days, so a file recreated at
 *   the same path by the next Ctrl+S lands beside something that says which project it came from.
 * - `sourceSlicer` and `sourceSizeBytes` — what the file *was* when it was handed over. Four of
 *   five slicers save back over it, so after the first save nothing on disk can answer either, and
 *   `returnedAs` is by definition a comparison against the first of them.
 * - `launchedEntries` — `entryDigests` of the file as launched, which is the itemised form of
 *   `launchedHash`. It is what makes the reconcile's diff a diff against **what was launched**
 *   rather than against the library original: for a `new-project` launch those differ by the whole
 *   of the strip, and reporting the app's own strip as something a slicer did would be a lie the
 *   user would act on.
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
  /**
   * Which library this launch came out of: the resolved folder locally, the origin remotely.
   *
   * **A `projectId` alone does not identify anything.** Ids are per-library, the sessions
   * directory is per-*machine*, and `SlicerSessions` resolves the open library per call — so
   * without this a session launched from one folder is listed beside one launched from another,
   * and an import resolves its `projectId` against whatever happens to be open now and answers
   * `NotFound` with nothing saying why. See `libraryKeyOf`.
   */
  library?: string
  /** What the **source** classified as. `SlicerSessionDto.returnedAs` is measured against it. */
  sourceSlicer?: SlicerId | null
  /** The size of the copy as handed over, which an in-place save overwrites and so destroys. */
  sourceSizeBytes?: number
  /** `entryDigests` of the copy as handed over. See the module docblock. */
  launchedEntries?: Record<string, string>
  /**
   * When the app removed the file this record describes, and the moment the 90 days start.
   *
   * Only ever written by an *observed and settled* exit sweep, or by the user answering the
   * session. Its presence is what tells "this directory is a memory" from "this directory is an
   * unfinished session", and the record is kept precisely because the file can come back.
   */
  sweptAt?: number
}

/**
 * The part of a spawned child this subsystem uses, and all of it.
 *
 * `pid` is optional and `undefined` rather than `null` so a real `ChildProcess` satisfies it
 * unchanged — that is the shape `child_process.spawn` returns for a spawn that produced no pid,
 * and a seam a real value cannot be assigned to is a seam that only ever sees doubles.
 *
 * **`once` is task 5's, and it is the only observation the exit sweep is allowed to rest on.**
 * It is optional because it is the one thing here that is genuinely optional: a launch whose
 * child cannot be watched still launches, and its session is simply one nothing will ever sweep —
 * which is the same position every session left by a previous run of the app is in. Declared with
 * method syntax so `ChildProcess.once`, whose listener takes a code and a signal this file has no
 * use for, assigns to it.
 *
 * What it deliberately does **not** promise: that the slicer closed. With `single_instance` on,
 * the spawned process hands the file to an already-running instance and exits while the slicer
 * stays open — measured — so an exit is the start of a settle period and never a conclusion.
 */
export type SpawnedSlicer = {
  pid?: number | undefined
  once?(event: 'exit', listener: () => void): unknown
}

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
  /**
   * The remote server, resolved per call for the same reason `session` is: the user can connect,
   * disconnect and reconnect without anything here being rebuilt. Null in local mode, and a
   * remote-mode launch that finds it null refuses rather than falling back to a library that is
   * not there.
   */
  remote: () => RemoteProxy | null
  spawn: SpawnSlicer
  /**
   * Told about every launch that made a directory, so the watch can start before the user has
   * looked at anything.
   *
   * A callback rather than a `SlicerSessions` reference, and it is not squeamishness about
   * coupling: the watch is an *optimisation* (spec 7.2), so this file must go on working when
   * nothing is listening — which is exactly what an optional callback says and a constructor
   * argument would not.
   */
  onLaunched?: (launch: LaunchedSession) => void
  /** `Date.now`, injected so `startedAt` is assertable. */
  now?: () => number
  /** `randomUUID`, injected so a launch directory has a name a test can predict. */
  newLaunchId?: () => string
}

/** What a launch that made a directory hands to the session lifecycle. */
export type LaunchedSession = {
  launchId: string
  directory: string
  /** The exact path handed to the slicer, inside `directory`. */
  path: string
  launchedHash: string
  child: SpawnedSlicer
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
 * The second half of Cura's round-trip limit — the half that is only true in remote mode.
 *
 * The first half is the same in both modes and is said *before* the launch, by the renderer:
 * Cura never saves in place, its Ctrl+S is always a Save-As into a sticky global directory, and
 * on the measured machine that directory is a real folder inside the user's own model library
 * (spike §13, §19). What remote mode adds is where that leaves the work: in a folder on this
 * computer, which the server this library lives on will never see. So the app says the file has
 * to be uploaded by hand, and launches anyway — Cura against a downloaded file is perfectly
 * useful for viewing, slicing and printing, and refusing would make the feature less useful than
 * not having it (spec 7.5).
 *
 * Keyed on `savesInPlace` rather than on the id, so it follows the measured property. Cura is the
 * only product with it false, and it is false for the reason this sentence describes.
 */
const NOTHING_COMES_BACK_FROM_CURA =
  'This slicer never saves back over the file it was given — its save is always a "save as" into ' +
  'a folder of its own on this computer. Nothing will come back here, so anything you want in ' +
  'this library has to be uploaded by hand afterwards.'

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
 *
 * `remote` adds exactly one row, and only one — see `NOTHING_COMES_BACK_FROM_CURA`. It is not a
 * fourth axis of the table: nothing else the app can honestly say about a launch depends on where
 * the library lives, because the file the slicer is handed is a real local file either way.
 */
export function notices(
  slicerId: SlicerId,
  source: LaunchedSource,
  stripped: boolean,
  remote = false,
): string[] {
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

  // Remote mode only. In local mode the same Save-As lands somewhere on this machine that the
  // next rescan may well index, so "nothing comes back" would be false there; the hazard that
  // *is* shared between the modes is stated before the launch instead, by the renderer.
  if (remote && !behaviour.savesInPlace) out.push(NOTHING_COMES_BACK_FROM_CURA)

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
  readonly #remote: () => RemoteProxy | null
  readonly #spawn: SpawnSlicer
  readonly #onLaunched: (launch: LaunchedSession) => void
  readonly #now: () => number
  readonly #newLaunchId: () => string

  constructor(options: SlicerLauncherOptions) {
    this.#sessionsDir = options.sessionsDir
    this.#slicers = options.slicers
    this.#session = options.session
    this.#isRemote = options.isRemote
    this.#remote = options.remote
    this.#spawn = options.spawn
    this.#onLaunched = options.onLaunched ?? ((): void => {})
    this.#now = options.now ?? Date.now
    this.#newLaunchId = options.newLaunchId ?? randomUUID
  }

  /**
   * Hands the file to a slicer, or refuses.
   *
   * The order of the steps is load-bearing, and it is the same order in both modes. Everything
   * that can refuse cheaply — the library or the server, the project, the file, the choice of
   * product, the install's path — runs **before** anything is written or downloaded, so a launch
   * that was never going to work leaves no directory behind and costs no bytes over the wire. The
   * copy or the download is next, then the strip, then the record, then the spawn; the record is
   * written before the spawn so a crash in between still leaves a directory that says what it is.
   */
  async open(
    fileId: string,
    projectId: string,
    opts: SlicerLaunchOptions,
  ): Promise<SlicerLaunchDto> {
    const remote = this.#isRemote()
    const source = remote
      ? await this.#remoteSource(fileId, projectId)
      : this.#localSource(fileId, projectId)

    const config = this.#slicers.get()
    const { slicerId, why } = chooseSlicer(opts, source.indexed.slicer, config.defaultSlicerId)
    const installId = config.bindings[slicerId]
    if (installId === undefined) throw unboundInstall(slicerId, config.installs)
    const { install, path: executable } = await this.#slicers.resolveInstall(installId)

    const launchId = this.#newLaunchId()
    const library = libraryKeyOf(remote, this.#session(), this.#remote())
    const directory = join(this.#sessionsDir, launchId)
    const plan =
      source.absPath === null
        ? await this.#prepareRemote(opts.mode, source, fileId, directory)
        : this.#prepare(opts.mode, source.indexed, source.name, source.absPath, directory)

    let launchedHash = ''
    if (plan.directory !== null) {
      launchedHash = entryHash(plan.path)
      const record: SlicerLaunchRecord = {
        launchId,
        mode: opts.mode,
        projectId,
        fileId,
        slicerId,
        installId: install.id,
        fileName: basename(plan.path),
        launchedHash,
        startedAt: this.#now(),
        // Null only where neither a folder nor a server is open, which no launch can reach —
        // both source paths above have already refused by then. Written as `undefined` in that
        // impossible case rather than as a string that would be wrong.
        ...(library === null ? {} : { library }),
        sourceSlicer: plan.source.classification.slicer,
        sourceSizeBytes: statSync(plan.path).size,
        // The itemised form of `launchedHash`, and the only thing that can still answer "what did
        // the slicer change?" once the slicer has saved back over the file it was given.
        launchedEntries: Object.fromEntries(entryDigests(plan.path)),
      }
      writeJsonFile(join(plan.directory, LAUNCH_RECORD_NAME), record)
    }

    const child = this.#spawnOrClean(executable, slicerId, plan)
    if (plan.directory !== null) {
      this.#onLaunched({
        launchId,
        directory: plan.directory,
        path: plan.path,
        launchedHash,
        child,
      })
    }
    return {
      launchId,
      slicerId,
      installLabel: install.label,
      stripped: plan.stripped,
      notices: [
        ...(why === null ? [] : [why]),
        ...notices(slicerId, plan.source, plan.stripped, remote),
      ],
      pid: child.pid ?? null,
    }
  }

  /**
   * The file as the open library knows it.
   *
   * Ownership scoping is core's, not this file's: `getProject` joins against the owner and throws
   * `NotFound` for a project the caller does not own, which is what makes a `projectId` from the
   * untrusted side safe to accept. The file has to be *in* that project as well — the record and
   * the reconcile both name the pair, and a mismatched pair would send a returning file to the
   * wrong project.
   */
  #localSource(fileId: string, projectId: string): SourceFile {
    const session = this.#requireLocalLibrary()
    const detail = getProject(session.lib, session.ctx, projectId)
    const file = detail.files.find((candidate) => candidate.id === fileId)
    if (!file) throw new AppError('NotFound', 'that file is not in that project', { fileId })
    const { absPath, name } = resolveFilePath(session.lib, session.ctx, fileId)
    return { name, indexed: { kind: file.kind, slicer: file.slicer ?? null }, absPath }
  }

  /**
   * The same three facts, out of the server, and the same ownership check.
   *
   * **This is why remote mode fetches the project and not only the file.** Parent §4.3 exposes no
   * `GET /api/files/:id`, so there is nowhere else to learn a file's name, kind and slicer — and
   * the pair check falls out of it for free, which matters because in remote mode nothing else
   * would make one. A project the user does not own answers 404 and arrives as `NotFound`, exactly
   * as core's own scoping does above.
   *
   * The name is validated rather than trusted. It arrives from another machine and is about to
   * become a path this process writes to: `fileNameSchema` is the same schema the server accepts
   * uploads under, so a name it would refuse on the way in is one this refuses on the way out.
   */
  async #remoteSource(fileId: string, projectId: string): Promise<SourceFile> {
    const remote = requireRemote(this.#remote())
    const detail = await remoteProject(remote, projectId)
    const file = detail.files.find((candidate) => candidate.id === fileId)
    if (!file) throw new AppError('NotFound', 'that file is not in that project', { fileId })
    const parsed = fileNameSchema.safeParse(file.name)
    if (!parsed.success) {
      throw new AppError('Validation', 'the server named that file in a way this app cannot use', {
        fileId,
      })
    }
    return {
      name: parsed.data,
      indexed: { kind: file.kind, slicer: file.slicer ?? null },
      absPath: null,
    }
  }

  /**
   * Downloads the file into a launch directory and builds what the slicer is handed.
   *
   * **There is no in-place branch here, and that is the whole of remote mode.** Both of §6.2's
   * arguments for launching a `.stl` where it lies — the slicer proposing `<basename>.3mf` beside
   * the model, and the rescan picking it up — rest on the file being in the project folder, and in
   * remote mode the project folder is on another computer. So `as-is`, `.stl` and `.obj` all take
   * the same path as everything else.
   *
   * The download lands beside its final name rather than on it, and is renamed or stripped into
   * place. Two reasons: a strip reads its input and writes its output, so it cannot be its own
   * destination; and a download interrupted halfway would otherwise leave a truncated file under
   * the name the record is about to claim is complete.
   */
  async #prepareRemote(
    mode: SlicerLaunchMode,
    source: SourceFile,
    fileId: string,
    directory: string,
  ): Promise<LaunchPlan> {
    if (mode === 'as-is' && source.indexed.kind !== 'slicer_project') refuseNotAProject(source)
    const fileName = basename(source.name)
    refuseRecordName(fileName)

    const remote = requireRemote(this.#remote())
    const target = join(directory, fileName)
    const download = `${target}${DOWNLOAD_SUFFIX}`
    mkdirSync(directory, { recursive: true })
    try {
      await remoteDownload(remote, fileId, download)
    } catch (error) {
      // Nothing has been handed to anything and no record exists, so this directory can explain
      // nothing and no slicer can put anything back into it — which is what keeps removing it
      // compatible with constraint 10.
      rmSync(directory, { recursive: true, force: true })
      throw error
    }

    const extension = extname(fileName).toLowerCase()
    // `as-is` means the user's own project, unchanged — the mode exists to hand over exactly what
    // is in the library, and stripping it would be the opposite of that. `new-project` strips a
    // `.3mf` for the reasons §3.3 gives, and `strip3mf` writes a verbatim copy where there was
    // nothing to strip, so the one call covers both halves.
    if (mode === 'as-is' || extension !== '.3mf') {
      renameSync(download, target)
      const classification = classifyFile(target)
      return {
        path: target,
        directory,
        stripped: false,
        source: { classification, is3mf: extension === '.3mf' },
      }
    }
    try {
      const result = strip3mf(download, target)
      rmSync(download, { force: true })
      return {
        path: target,
        directory,
        stripped: result.stripped,
        source: { classification: result.classification, is3mf: true },
      }
    } catch (error) {
      rmSync(directory, { recursive: true, force: true })
      refuseStrip(error, source.name)
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
      if (indexed.kind !== 'slicer_project') refuseNotAProject({ indexed })
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
    const fileName = basename(name)
    refuseRecordName(fileName)
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
  #spawnOrClean(executable: string, slicerId: SlicerId, plan: LaunchPlan): SpawnedSlicer {
    try {
      return this.#spawn(executable, SLICERS[slicerId].argv(plan.path))
    } catch (error) {
      if (plan.directory !== null) rmSync(plan.directory, { recursive: true, force: true })
      throw new AppError('Internal', `could not start ${SLICERS[slicerId].displayName}`, {
        cause: String(error),
      })
    }
  }

  /** The library this launch needs, or the reason there is none. */
  #requireLocalLibrary(): DesktopSession {
    const session = this.#session()
    if (!session) throw new AppError('Conflict', 'no library folder is open')
    return session
  }
}

/**
 * The three facts a launch needs about its source, from whichever side of the wire holds them.
 *
 * `absPath` is the discriminator, and it is `null` in remote mode because there genuinely is no
 * local path: the bytes are on another machine until something downloads them. A boolean `remote`
 * flag beside a path that is sometimes meaningless would be the same information with a second
 * way to get it wrong.
 */
type SourceFile = {
  name: string
  /** What the index says the file is. Never a fresh read: the user chose from what they saw. */
  indexed: Classification
  absPath: string | null
}

/**
 * What a partial download is called while it is still partial.
 *
 * It is removed before the launch, so it never reaches the "anything else in this directory is
 * reported, not adopted" rule — but if a crash does leave one behind, the suffix is what makes it
 * legible as an interrupted download rather than as something a slicer put there.
 */
const DOWNLOAD_SUFFIX = '.spm-download'

/**
 * Which library a launch belongs to, as one comparable string.
 *
 * `local:<resolved folder>` or `remote:<origin>`. The prefix is not decoration: without it a
 * server called `C:\\models` and a folder of that name would compare equal, which is silly but
 * free to rule out, and it makes a record legible to a person reading `launch.json` by hand.
 *
 * **Compared with `sameLibrary`, never with `===`.** Windows paths are case-insensitive, so the
 * same folder reached through the picker twice can be spelled two ways, and a session that
 * compared unequal to its own library would be hidden from the only page that can answer it.
 *
 * `null` when nothing is open. Callers treat that as "cannot tell" rather than as "foreign":
 * refusing to list a session because the app has not finished starting would be the wrong kind of
 * caution on a list whose whole job is to surface things.
 */
export function libraryKeyOf(
  isRemote: boolean,
  session: DesktopSession | null,
  remote: { readonly origin: string } | null,
): string | null {
  if (isRemote) return remote === null ? null : `remote:${remote.origin}`
  return session === null ? null : `local:${resolve(session.lib.dir)}`
}

/**
 * Whether two library keys name the same library, or whether either is simply unknown.
 *
 * Unknown compares *equal* on purpose, and it is the whole of the backward-compatibility story: a
 * record written before this field existed has no library, and hiding every one of those from the
 * session list would be this change deleting the user's memory of unfinished work to fix a
 * labelling problem.
 */
export function sameLibrary(a: string | null | undefined, b: string | null | undefined): boolean {
  if (a === null || a === undefined || b === null || b === undefined) return true
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b
}

/** `as-is` needs a slicer project. Shared, because both modes refuse it with the same sentence. */
function refuseNotAProject(source: { indexed: Classification }): never {
  throw new AppError(
    'Validation',
    'only a slicer project can be opened as it is; start a new slicer project from this file instead',
    { kind: source.indexed.kind },
  )
}

/**
 * The one basename a launch directory's file may not have.
 *
 * `launch.json` is written into that directory a moment later, so a source of that name would be
 * overwritten by its own record — and in an order that is worse than it sounds: `launchedHash` is
 * taken from the user's bytes, the record then replaces them, and the slicer is handed the record.
 * Nothing in the library is lost, but the sweep would inherit a directory whose only file is a
 * record whose `launchedHash` cannot match it, which is precisely the shape the reconcile reads as
 * "this came back changed". Refused rather than renamed: the basename is load-bearing on this
 * path — four of five slicers propose it on the first save — so the honest answer is that this one
 * file cannot take it.
 */
function refuseRecordName(fileName: string): void {
  if (fileName.toLowerCase() !== LAUNCH_RECORD_NAME) return
  throw new AppError(
    'Validation',
    `a file called ${LAUNCH_RECORD_NAME} cannot be prepared for a new project, because the app writes a record of that name beside the copy it hands over`,
    { fileName },
  )
}

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
