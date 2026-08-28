import { randomUUID } from 'node:crypto'
import type { SlicerConfigDto, SlicerId } from '@spm/contract/dtos.ts'
import { AppError, DETECTION_FAILED } from '@spm/contract/errors.ts'
import {
  emptyConfig,
  NODE_RESOLVE_FILE_CHECK,
  mergeDetected,
  readConfig,
  resolveInstallPath,
  SLICERS_FILE_NAME,
  toConfigDto,
  writeConfig,
  type SlicersConfig,
  type StoredInstall,
} from './config.ts'
import {
  detectInstalls,
  NODE_DETECT_IO,
  runPowerShellDetection,
  type DetectedInstall,
  type DetectIo,
  type RunDetection,
} from './detect.ts'
import { SLICERS } from './registry.ts'

/**
 * `details.reason` on the `Internal` a failed detection throws.
 *
 * It moved to `@spm/contract/errors.ts` in task 3 and is re-exported here so this module's own
 * callers and tests read unchanged. The move is the point: the settings page switches on this
 * value across the IPC boundary, and the alternative was two packages each spelling it by hand.
 */
export { DETECTION_FAILED }

/**
 * The one thing that owns `slicers.json`, and the only place its lifecycle lives.
 *
 * Everything the renderer can ask about slicer *configuration* arrives here through
 * `dispatch.ts`'s seven `shellCall` entries. It is a `shellCall` and not a `libraryCall` for a
 * reason that is easy to get wrong: in remote mode `deps.session` is null and `libraryCall`
 * refuses a null session by design, so a `libraryCall` slicer entry could not work at all — and
 * slicer configuration is a property of *this machine*, not of whichever library is open.
 *
 * **Constraint 4 — what the renderer may name.** Nothing here takes a filesystem path from the
 * renderer. `addManual` takes a `SlicerId` and nothing else; the path comes from a native dialog
 * this process owns, exactly as `library.pick` does. The worst a hostile renderer can do on these
 * channels is ask for the dialog (rate-limited to one at a time below), name an install id that
 * does not exist (`NotFound`), or reset a file in the app's own `userData`. It cannot name a
 * path, and so cannot choose what a later launch spawns.
 *
 * `electron` is not imported here — the dialog is injected, the way the folder picker is — so
 * `test/slicers-host.test.ts` drives the whole of it under plain `node --test`.
 */

/** Asks the user for an executable. Null when they cancel, which is not an error. */
export type ExecutablePicker = (slicerId: SlicerId) => Promise<string | null>

export type SlicersHostOptions = {
  /** `slicers.json` under `app.getPath('userData')`. */
  configFile: string
  /** The detection subprocess. Injected; see `RunDetection`. */
  run?: RunDetection
  /**
   * The filesystem question the **parse** asks, so a fixture needs no real executables.
   *
   * Deliberately *not* the same seam as `isRegularFile` below, and the distinction is worth
   * keeping: this one exists so a document describing another machine can be parsed on this one,
   * and it is a stub in almost every test. The other is this host's view of the real filesystem,
   * and stubbing it by accident would make a manual entry or a pre-launch check pass for a file
   * that is not there.
   */
  io?: DetectIo
  /**
   * Whether a path is a regular file that exists — the check `addManual` and `resolveInstall`
   * make, on the machine the app is running on. Injectable so both are swappable together;
   * defaulted to the real filesystem, which is what every caller outside a test uses.
   */
  isRegularFile?: (path: string) => boolean
  /**
   * The native file dialog. Defaulted to a cancel rather than to a stub, so a caller that forgets
   * to wire it cannot silently be more permissive than the real shell.
   */
  pickExecutable?: ExecutablePicker
  /** Defaulted to the real one; a test names a platform to drive the off-Windows branch. */
  platform?: string
  /** `Date.now`, injected so `addedAt` is assertable. */
  now?: () => number
}

export class SlicersHost {
  readonly #configFile: string
  readonly #run: RunDetection
  readonly #io: DetectIo
  readonly #isRegularFile: (path: string) => boolean
  readonly #pickExecutable: ExecutablePicker
  readonly #platform: string
  readonly #now: () => number
  /**
   * The executable dialog that is already open, so a loop cannot stack native dialogs.
   *
   * The same guard `ShellHost.connectRemote` has, and for the same reason: this is raised by an
   * IPC call the *renderer* makes, `ipc.ts` does not serialize calls, and dialog fatigue is
   * precisely the failure a confirmation exists to resist.
   */
  #picking: Promise<SlicerConfigDto | null> | null = null
  /** Which slicer `#picking` is asking about, so a second caller is answered about its own. */
  #pickingFor: SlicerId | null = null

  constructor(options: SlicersHostOptions) {
    this.#configFile = options.configFile
    this.#run = options.run ?? runPowerShellDetection
    this.#io = options.io ?? NODE_DETECT_IO
    this.#isRegularFile = options.isRegularFile ?? NODE_RESOLVE_FILE_CHECK
    this.#pickExecutable = options.pickExecutable ?? ((): Promise<null> => Promise.resolve(null))
    this.#platform = options.platform ?? process.platform
    this.#now = options.now ?? Date.now
  }

  /** Whether detection can run at all. False off Windows; manual entry is then the only way in. */
  detectionSupported(): boolean {
    return this.#platform === 'win32'
  }

  /** What is configured right now. Reads the file every time — it is small and hand-editable. */
  get(): SlicerConfigDto {
    return toConfigDto(readConfig(this.#configFile).config, this.detectionSupported())
  }

  /**
   * Runs detection and merges what it found into what is already there.
   *
   * Off Windows this is a read: there is no mechanism to run, and inventing one — a `which`, a
   * glob over `/opt` — would be designing macOS and Linux detection by accident. `detectInstalls`
   * is not called, and the answer is the existing configuration unchanged.
   */
  async scan(): Promise<SlicerConfigDto> {
    if (!this.detectionSupported()) return this.get()
    const { config, writable } = this.#load()
    const detected = await this.#detect()
    return this.#save(mergeDetected(config, detected, this.#now()), writable)
  }

  /**
   * One detection run, with its failures given an identity the renderer can act on.
   *
   * A timed-out PowerShell, a `powershell.exe` that is not where it should be and a `maxBuffer`
   * overflow all arrive here as an `Error` from `child_process`. Left alone, `ipc.ts` normalises
   * any non-`AppError` throw to `Internal` with its message — which preserves *that* the call
   * failed but tells a settings page nothing it can phrase, and would put a Node error string in
   * front of a user. `Internal` is still the code, because none of the others is honest about a
   * subprocess that did not run; what makes it usable is `details.reason`.
   *
   * The underlying message goes in `details.cause` rather than in `message`: the UI shows the
   * sentence, and the cause is for the log and for a bug report.
   */
  async #detect(): Promise<DetectedInstall[]> {
    try {
      return await detectInstalls(this.#run, this.#io)
    } catch (error) {
      const cause = error instanceof Error ? error.message : String(error)
      console.warn('desktop: slicer detection could not run', error)
      throw new AppError('Internal', 'could not look for slicers installed on this machine', {
        reason: DETECTION_FAILED,
        cause,
      })
    }
  }

  /**
   * Adds an install the user names in a native dialog.
   *
   * Its path is used **verbatim**: the user chose it, so the `exeName` check that guards a
   * `DisplayIcon` does not apply — that check exists because a vendor's icon field is not a
   * promise about which binary to run, and a person pointing at a portable build is. The
   * file-exists check still applies, because a path that is not there is not launchable.
   *
   * This is the answer to every gap in detection rather than a courtesy: per-user installs,
   * portable installs, a vendor whose `DisplayIcon` does not name the main executable, and any
   * sixth slicer someone wants to point at a `.3mf`.
   *
   * Resolves to `null` when the user cancels — not an error, exactly like `library.pick`.
   */
  addManual(slicerId: SlicerId): Promise<SlicerConfigDto | null> {
    // One dialog at a time, whatever the renderer asks for — the same guard, and the same
    // reasoning, as `ShellHost.connectRemote`: `ipc.ts` does not serialize calls, so a loop could
    // otherwise stack unbounded native dialogs, and dialog fatigue is precisely the failure a
    // native dialog exists to resist. A second caller asking about the *same* slicer gets the
    // in-flight answer; one asking about a different slicer is refused rather than handed the
    // answer to a question it did not ask.
    if (this.#picking) {
      if (this.#pickingFor === slicerId) return this.#picking
      return Promise.reject(new AppError('Conflict', 'a slicer executable is already being chosen'))
    }
    const picking = this.#addManual(slicerId).finally(() => {
      if (this.#picking === picking) {
        this.#picking = null
        this.#pickingFor = null
      }
    })
    this.#picking = picking
    this.#pickingFor = slicerId
    return picking
  }

  async #addManual(slicerId: SlicerId): Promise<SlicerConfigDto | null> {
    const path = await this.#pickExecutable(slicerId)
    if (path === null || path === '') return null
    if (!this.#isRegularFile(path)) {
      throw new AppError('NotFound', 'that file is not there any more')
    }
    const { config, writable } = this.#load()
    // One id, spelled twice: `origin.id` is the identity and `id` is the identity with its origin
    // spelled in front, which is what makes every install id say where it came from.
    const generated = randomUUID()
    const install: StoredInstall = {
      id: `manual:${generated}`,
      slicerId,
      label: `${SLICERS[slicerId].displayName} (added by hand)`,
      origin: { kind: 'manual', id: generated },
      // Never from the executable: Cura's and Orca's version resources are empty, so a version
      // read off the file would be absent for exactly the products that need it most.
      version: null,
      pathHint: path,
      addedAt: this.#now(),
    }
    const installs = [...config.installs, install]
    return this.#save(
      {
        ...config,
        installs,
        // The same rule a scan follows: bind what there is no choice about, re-point nothing.
        bindings:
          config.bindings[slicerId] === undefined &&
          installs.filter((row) => row.slicerId === slicerId && row.missing !== true).length === 1
            ? { ...config.bindings, [slicerId]: install.id }
            : config.bindings,
      },
      writable,
    )
  }

  /**
   * Forgets an install.
   *
   * A binding to it goes with it — a binding to an install that is not in the file is not a
   * binding, and leaving one would make `/settings/slicers` show a slicer as configured that
   * cannot launch. `defaultSlicerId` is *not* cleared: it names a product, and the user may bind
   * that product to something else in the next click.
   *
   * A detected install removed this way comes back on the next scan. That is deliberate rather
   * than overlooked: `remove` is how a *manual* entry is undone, and the honest answer for a
   * registry install is that it is still installed.
   */
  remove(installId: string): SlicerConfigDto {
    const { config, writable } = this.#load()
    if (!config.installs.some((install) => install.id === installId)) {
      throw new AppError('NotFound', 'no such slicer install')
    }
    const bindings = { ...config.bindings }
    for (const [slicerId, bound] of Object.entries(bindings)) {
      if (bound === installId) delete bindings[slicerId as SlicerId]
    }
    return this.#save(
      {
        ...config,
        installs: config.installs.filter((install) => install.id !== installId),
        bindings,
      },
      writable,
    )
  }

  /** Points a product at one of its installs. The one decision D asks the user to make. */
  bind(slicerId: SlicerId, installId: string): SlicerConfigDto {
    const { config, writable } = this.#load()
    const install = config.installs.find((candidate) => candidate.id === installId)
    if (!install) throw new AppError('NotFound', 'no such slicer install')
    if (install.slicerId !== slicerId) {
      throw new AppError('Validation', `that install is ${install.slicerId}, not ${slicerId}`)
    }
    return this.#save(
      { ...config, bindings: { ...config.bindings, [slicerId]: installId } },
      writable,
    )
  }

  /**
   * The product a file that names no slicer is opened with.
   *
   * Not gated on there being a binding for it. The default is a statement of preference and the
   * bindings are a statement of fact about this machine; a user who sets a default before binding
   * it, or whose bound install later goes missing, gets an honest refusal at launch rather than a
   * setting that would not stick.
   */
  setDefault(slicerId: SlicerId): SlicerConfigDto {
    const { config, writable } = this.#load()
    return this.#save({ ...config, defaultSlicerId: slicerId }, writable)
  }

  /**
   * Throws the file away and starts again.
   *
   * The only operation that writes over a file this build cannot read, and the only way out of
   * that state. It is a user action by construction — nothing calls it automatically — which is
   * what makes overwriting a newer build's configuration a choice rather than a downgrade
   * silently eating it.
   */
  resetConfig(): SlicerConfigDto {
    const fresh = emptyConfig()
    writeConfig(this.#configFile, fresh)
    return toConfigDto(fresh, this.detectionSupported())
  }

  /**
   * The path to spawn for an install, checked and re-resolved if need be. Tasks 4 and 5 call this.
   *
   * Throws rather than returning a null path: every caller is about to spawn, and there is no
   * useful thing to do with "no path" other than tell the user. `NotFound` with the install's
   * label so the message can name what is gone.
   */
  async resolveInstall(installId: string): Promise<{ install: StoredInstall; path: string }> {
    const { config, writable } = this.#load()
    const result = await resolveInstallPath(config, installId, {
      isRegularFile: this.#isRegularFile,
      reresolve: (install) => this.#reresolve(install),
    })
    if (result.changed && writable) writeConfig(this.#configFile, result.config)
    if (!result.ok) {
      throw new AppError(
        'NotFound',
        result.reason === 'unknown'
          ? 'no such slicer install'
          : 'that slicer is no longer installed where it was',
        { installId },
      )
    }
    const install = result.config.installs.find((candidate) => candidate.id === installId)
    return { install: install!, path: result.path }
  }

  /**
   * One detection run, looked up by origin key. Off Windows there is nothing to run.
   *
   * **A detection that fails is not an install that is gone**, and the difference is why this
   * lets `#detect`'s `AppError` out instead of answering `null`. `null` here means "the mechanism
   * ran and this install was not in what it found", which is what marks the install `missing` and
   * writes that to disk. A PowerShell that timed out has found nothing about anything, and
   * recording an install as gone on that basis would leave the user to un-break it by hand.
   * Rejecting instead leaves `slicers.json` exactly as it was — `resolveInstallPath` never gets
   * as far as building a new one.
   */
  async #reresolve(install: StoredInstall): Promise<string | null> {
    if (!this.detectionSupported()) return null
    const detected = await this.#detect()
    return detected.find((candidate) => candidate.id === install.id)?.path ?? null
  }

  #load(): { config: SlicersConfig; writable: boolean } {
    return readConfig(this.#configFile)
  }

  /**
   * Writes, unless the file on disk was written by a build this one cannot read.
   *
   * The refusal is an `AppError` the UI can switch on rather than a silent no-op: a settings page
   * that showed a binding it had not stored would be worse than one that says the file has to be
   * reset first.
   */
  #save(config: SlicersConfig, writable: boolean): SlicerConfigDto {
    if (!writable) {
      throw new AppError(
        'Conflict',
        `${SLICERS_FILE_NAME} was written by a newer version of this app; reset it to continue`,
      )
    }
    writeConfig(this.#configFile, config)
    return toConfigDto(config, this.detectionSupported())
  }
}
