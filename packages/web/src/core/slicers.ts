import { createSignal } from 'solid-js'
import {
  DETECTION_FAILED,
  type SlicerConfigDto,
  type SlicerId,
  type SlicerInstallDto,
} from '../api/generated'
import { isApiError } from './api/error'
import { desktop, type DesktopClient } from './desktop'
import { SLICER_PRODUCTS } from './slicer-names'

/** One product's row on the page: what is installed for it, and what is bound. */
export type ProductRow = {
  id: SlicerId
  name: string
  installs: SlicerInstallDto[]
  /** The install this product launches, or null where nothing is bound. */
  boundId: string | null
  /** More than one install and nothing bound: the page asks rather than picking one. */
  mustChoose: boolean
}

/**
 * Which message the page shows, as a kind rather than a resolved string: the language switches at
 * runtime, and an error sits on screen while a user goes looking for the language setting.
 */
export type FailureKind =
  | 'forbidden'
  | 'conflict'
  | 'notFound'
  | 'pickedGone'
  | 'validation'
  | 'detection'
  | 'load'
  | 'generic'

/**
 * `error.code` is what the page switches on, and the two codes that need more than the code are
 * named here. `Internal` covers both "detection could not run" (a PowerShell that timed out, a
 * missing `powershell.exe`) and everything unforeseen, and only `details.reason` tells them apart.
 */
export function classify(error: unknown): FailureKind {
  if (!isApiError(error)) return 'generic'
  switch (error.code) {
    case 'Forbidden':
      return 'forbidden'
    case 'Conflict':
      // A configuration this build refuses to overwrite, and reset is the way out.
      return 'conflict'
    case 'NotFound':
      return 'notFound'
    case 'Validation':
      return 'validation'
    case 'Internal':
      return error.details['reason'] === DETECTION_FAILED ? 'detection' : 'generic'
    default:
      return 'generic'
  }
}

/** Every product, with what is installed for it and what is bound. */
export function productRows(config: SlicerConfigDto | null): ProductRow[] {
  return SLICER_PRODUCTS.map((product) => {
    const installs = (config?.installs ?? []).filter((install) => install.slicerId === product.id)
    const boundId = config?.bindings[product.id] ?? null
    return {
      id: product.id,
      name: product.name,
      installs,
      boundId,
      mustChoose: installs.length > 1 && boundId === null,
    }
  })
}

/**
 * Only products with a binding. A default naming a product with no install to launch is a setting
 * that would fail at the moment it mattered; the shell allows it, and the page does not offer it.
 */
export function defaultOptions(rows: readonly ProductRow[]): { value: SlicerId; label: string }[] {
  return rows
    .filter((row) => row.boundId !== null)
    .map((row) => ({ value: row.id, label: row.name }))
}

export type SlicersClient = DesktopClient['slicers']

/**
 * The slicer settings as state: the configuration (every mutating call answers with the **whole**
 * new one, so state is replaced rather than patched and there is no reconciliation to get wrong),
 * whether a call is in flight, and the one failure to show.
 *
 * **The busy gate is load-bearing and not only cosmetic**: `addManual` opens a native dialog and the
 * shell refuses a second one for a *different* product with a `Conflict`, the same code an
 * unwritable `slicers.json` uses. Every control is disabled while a call is in flight, and a call
 * that gets through anyway is dropped, so a `Conflict` reaching the page means the file.
 */
export function createSlicersSettings(client: SlicersClient = desktop.slicers) {
  const [config, setConfig] = createSignal<SlicerConfigDto | null>(null)
  const [busy, setBusy] = createSignal(false)
  const [failure, setFailure] = createSignal<FailureKind | null>(null)

  async function run(
    call: () => Promise<SlicerConfigDto | null>,
    overrides: { generic?: FailureKind; notFound?: FailureKind } = {},
  ): Promise<void> {
    if (busy()) return
    setBusy(true)
    setFailure(null)
    try {
      const next = await call()
      // `null` is the user cancelling the shell's executable dialog: an ordinary outcome, not a
      // failure. They were shown the dialog they said no to, and nothing changed.
      if (next !== null) setConfig(next)
    } catch (error) {
      // Two codes mean something operation-specific, and only those two are overridable. A failed
      // first load says the configuration could not be read rather than "something went wrong";
      // `addManual`'s `NotFound` is a file the user just picked rather than a stale row. Every
      // other code says the same thing whichever call raised it.
      const kind = classify(error)
      const override =
        kind === 'generic'
          ? overrides.generic
          : kind === 'notFound'
            ? overrides.notFound
            : undefined
      setFailure(override ?? kind)
      // The words the user sees are this app's own, in this app's language; the shell's message
      // and its details are the diagnosis, and this is where they land.
      console.error('slicers: a configuration call failed', error)
    } finally {
      setBusy(false)
    }
  }

  const current = () => config()?.bindings

  return {
    config,
    busy,
    failure,
    /** A `Conflict` is a configuration this build refuses to overwrite: offer the reset. */
    offerReset: () => failure() === 'conflict',
    load: () => run(() => client.get(), { generic: 'load' }),
    rescan: () => run(() => client.scan()),
    addManual: (slicerId: SlicerId) =>
      // `NotFound` means something different here from anywhere else on the page: the file the
      // user just chose is gone. Say that, and do not send them to a scan that cannot help.
      run(() => client.addManual(slicerId), { notFound: 'pickedGone' }),
    remove: (installId: string) => run(() => client.remove(installId)),
    /**
     * Binding to what is already bound is not a second round trip: the control re-emits its bound
     * value as it re-syncs after a replace.
     */
    async bind(slicerId: SlicerId, installId: string): Promise<void> {
      if (installId === current()?.[slicerId]) return
      await run(() => client.bind(slicerId, installId))
    },
    /**
     * Unbinds a product, the only way back from a binding the app made by itself: a product with
     * exactly one install is bound the moment it is detected, and `remove` does not undo that (the
     * install is still installed, so the next scan binds it again).
     */
    async unbind(slicerId: SlicerId): Promise<void> {
      if (current()?.[slicerId] === undefined) return
      await run(() => client.bind(slicerId, null))
    },
    async setDefault(slicerId: SlicerId | null): Promise<void> {
      if (slicerId === (config()?.defaultSlicerId ?? null)) return
      await run(() => client.setDefault(slicerId))
    },
    reset: () => run(() => client.resetConfig()),
  }
}

export type SlicersSettings = ReturnType<typeof createSlicersSettings>
