import { createSignal } from 'solid-js'
import type {
  FileDto,
  SlicerConfigDto,
  SlicerId,
  SlicerLaunchDto,
  SlicerLaunchMode,
} from '../api/generated'
import { isApiError } from './api/error'
import { curaHazard as sharedHazard, type CuraHazardStore } from './cura-hazard'
import { desktop, type DesktopClient } from './desktop'
import { t } from './i18n'
import { SLICER_PRODUCTS, slicerDisplayName } from './slicer-names'

/**
 * Which product a launch would use, as the page has to work it out **before** making the call.
 *
 * This is the same rule the shell applies, written twice on purpose: the Cura warning has to be
 * shown before the launch, and only the shell knows which slicer the launch will actually pick, so
 * either the page reproduces the rule or the warning arrives after the file has already been
 * handed over, which is not a warning. The page therefore offers no launch control until it has
 * loaded the same configuration the shell reads, and the answer the launch comes back with
 * (`SlicerLaunchDto.slicerId`) is still the authority for everything shown afterwards.
 */
export function resolveLaunchSlicer(
  mode: SlicerLaunchMode,
  fileSlicer: SlicerId | undefined,
  chosen: SlicerId | null,
  defaultSlicerId: SlicerId | null,
): SlicerId | null {
  if (chosen !== null) return chosen
  if (mode === 'as-is' && fileSlicer !== undefined) return fileSlicer
  return defaultSlicerId
}

/**
 * A launch the page is holding back until the user has answered the Cura warning. It carries the
 * picker's value **as it was when the warning was raised**, rather than letting the continue
 * button re-read it: the picker is live while the warning is up, so a user who changes it and then
 * presses "hand it to Cura anyway" would otherwise launch a product nobody warned them about.
 */
export type PendingLaunch = { file: FileDto; mode: SlicerLaunchMode; chosen: SlicerId | null }

/** What was handed over: "Handed X to Y", and never that anything opened. */
export type Handed = { launch: SlicerLaunchDto; fileName: string }

/** The words for "Handed {file} to {slicer} ({install})". */
export function handedMessage(handed: Handed): string {
  return t('projects.handedTo', {
    file: handed.fileName,
    slicer: `${slicerDisplayName(handed.launch.slicerId)} (${handed.launch.installLabel})`,
  })
}

/**
 * A refused launch shows the shell's own sentence rather than a generic apology: every refusal this
 * call can produce says something the user can act on (which of three problems stopped a strip and
 * that the other path is still open, which of two installs of a product they have to choose
 * between), and mapping those onto "something went wrong" would throw away the whole point of the
 * shell having phrased them.
 */
export function launchErrorMessage(error: unknown): string {
  return isApiError(error) && error.message !== '' ? error.message : t('errors.generic')
}

export type LaunchDeps = {
  client: DesktopClient['slicers']
  hazard: CuraHazardStore
}

/**
 * Handing a project's files to a slicer, as state: this machine's slicer configuration (loaded
 * only where a launch is possible), the optional per-launch product choice, the warning held for
 * Cura, the last launch, and the one error.
 *
 * `enabled` is `capabilities.canLaunchSlicer`. The configuration is loaded because the page needs
 * the same facts the shell reads: which products are bound, and the default.
 */
export function createSlicerLaunch(
  projectId: () => string,
  enabled: () => boolean,
  deps: Partial<LaunchDeps> = {},
) {
  const client = deps.client ?? desktop.slicers
  const hazard = deps.hazard ?? sharedHazard
  const [config, setConfig] = createSignal<SlicerConfigDto | null>(null)
  const [chosen, setChosen] = createSignal<SlicerId | null>(null)
  const [launched, setLaunched] = createSignal<Handed | null>(null)
  const [pending, setPending] = createSignal<PendingLaunch | null>(null)
  const [dontShowAgain, setDontShowAgain] = createSignal(false)
  const [error, setError] = createSignal<string | null>(null)
  const [busy, setBusy] = createSignal(false)

  /** Loads this machine's configuration. A failure leaves the launch controls out, quietly. */
  async function load(): Promise<void> {
    if (!enabled()) {
      setConfig(null)
      return
    }
    try {
      setConfig(await client.get())
    } catch (failure) {
      console.error('slicers: the configuration could not be loaded', failure)
      setConfig(null)
    }
  }

  /** Whether the controls are offered at all: a launch is possible and its facts are known. */
  const available = () => enabled() && config() !== null

  /** The products with an install bound to them; nothing else can be launched. */
  const options = () => {
    const bindings = config()?.bindings
    if (!bindings) return []
    return SLICER_PRODUCTS.filter((product) => bindings[product.id] !== undefined).map(
      (product) => ({ value: product.id, label: product.name }),
    )
  }

  async function launch(
    file: FileDto,
    mode: SlicerLaunchMode,
    pick: SlicerId | null,
  ): Promise<void> {
    setError(null)
    setLaunched(null)
    setBusy(true)
    try {
      const result = await client.open(file.id, projectId(), {
        mode,
        // Omitted rather than sent as null: "not stated" is what makes the shell apply its own
        // rule and say which it picked.
        ...(pick === null ? {} : { slicerId: pick }),
      })
      setLaunched({ launch: result, fileName: file.name })
    } catch (failure) {
      console.error('slicers: a launch was refused', failure)
      setError(launchErrorMessage(failure))
    } finally {
      setBusy(false)
    }
  }

  return {
    config,
    available,
    options,
    chosen,
    setChosen,
    launched,
    dismissLaunched: () => setLaunched(null),
    pending,
    dontShowAgain,
    setDontShowAgain,
    error,
    dismissError: () => setError(null),
    busy,
    load,
    /**
     * A launch the user asked for: held back once for Cura, and only once. The warning is a notice
     * with a way past it and not a gate (see `core/cura-hazard.ts`).
     */
    async request(file: FileDto, mode: SlicerLaunchMode): Promise<void> {
      const pick = chosen()
      const willUse = resolveLaunchSlicer(
        mode,
        file.slicer,
        pick,
        config()?.defaultSlicerId ?? null,
      )
      if (willUse === 'cura' && !hazard.acknowledged()) {
        setPending({ file, mode, chosen: pick })
        return
      }
      await launch(file, mode, pick)
    },
    /** Presses past the Cura warning. What is launched is what was warned about. */
    async continueCura(): Promise<void> {
      const held = pending()
      if (held === null) return
      if (dontShowAgain()) hazard.acknowledge()
      setPending(null)
      await launch(held.file, held.mode, held.chosen)
    },
    cancelCura: () => setPending(null),
  }
}

export type SlicerLaunch = ReturnType<typeof createSlicerLaunch>
