import { contextBridge, ipcRenderer, webUtils } from 'electron'
import { BRIDGE_KEY, INVOKE_CHANNEL, type IpcResult, type SpmBridge } from './protocol.ts'
import { sanitiseArgs } from './sanitise-args.ts'

/**
 * The renderer's only door into the main process.
 *
 * Two functions, one channel (decision 3 of the plan). The channel name never reaches the
 * renderer: `IpcApiClient` in `packages/web` knows only that `window.spm` exists, so the
 * transport can change without the Angular app noticing.
 *
 * `invoke` resolves with a tagged result and does not reject on a failed call — see the
 * measurement in `protocol.ts` for why an error is a value here rather than a throw. It can still
 * reject if the channel itself is gone (no handler registered, main process gone); `IpcApiClient`
 * turns that into an `AppError` too.
 *
 * Bundled as CommonJS, unlike main.ts. That is not an inconsistency: a sandboxed preload runs in
 * a restricted context that has no ESM loader at all, and an `import` statement here fails at
 * load with the bridge silently absent. main.ts must be ESM for the opposite reason — see
 * build.ts. `protocol.ts` and `sanitise-args.ts` are imported rather than inlined, and both are
 * free of runtime imports so bundling them into the preload pulls in nothing else.
 *
 * **This file holds no state.** That is a property and not an accident: the first version handed
 * the main world an opaque token from a preload-side map of picked paths, and that map turned out
 * to be unbounded and never to expire — 20 000 entries minted from the renderer in 12 ms, the
 * first still redeemable afterwards, all measured. There is nothing here now for a renderer to
 * accumulate: `canStreamFromDisk` answers a boolean and forgets, and the path is resolved inside
 * the `invoke` that uses it.
 */

/**
 * The path behind a picked `File`, or `''` for anything else.
 *
 * Measured in Electron 44.0.0, `sandbox: true`, `contextIsolation: true`: `getPathForFile`
 * returns the absolute path for a `File` that came from an `<input type="file">`, the empty
 * string for a `Blob` or a script-constructed `File`, and **throws** for anything that is not a
 * `Blob` at all — including a duck-typed `{ name, size, type, path }`. The throw is caught here
 * rather than left to the caller: a preload that raises into the main world on a hostile argument
 * makes every caller's error handling load-bearing for this one's safety.
 */
function pathOf(file: unknown): string {
  try {
    return webUtils.getPathForFile(file as File) || ''
  } catch {
    return ''
  }
}

const bridge: SpmBridge = {
  canStreamFromDisk: (file: unknown): boolean => pathOf(file) !== '',
  invoke: (path: string, args: unknown[]): Promise<IpcResult> =>
    ipcRenderer.invoke(INVOKE_CHANNEL, {
      path,
      args: sanitiseArgs(args, pathOf),
    }) as Promise<IpcResult>,
}

contextBridge.exposeInMainWorld(BRIDGE_KEY, bridge)
