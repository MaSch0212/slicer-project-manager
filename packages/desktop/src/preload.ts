import { contextBridge, ipcRenderer } from 'electron'
import { BRIDGE_KEY, INVOKE_CHANNEL, type IpcResult, type SpmBridge } from './protocol.ts'

/**
 * The renderer's only door into the main process.
 *
 * One function, one channel (decision 3 of the plan). The channel name never reaches the
 * renderer: `IpcApiClient` in `packages/web` knows only that `window.spm.invoke(path, args)`
 * exists, so the transport can change without the Angular app noticing.
 *
 * `invoke` resolves with a tagged result and does not reject on a failed call — see the
 * measurement in `protocol.ts` for why an error is a value here rather than a throw. It can still
 * reject if the channel itself is gone (no handler registered, main process gone); `IpcApiClient`
 * turns that into an `AppError` too.
 *
 * Bundled as CommonJS, unlike main.ts. That is not an inconsistency: a sandboxed preload runs in
 * a restricted context that has no ESM loader at all, and an `import` statement here fails at
 * load with the bridge silently absent. main.ts must be ESM for the opposite reason — see
 * build.ts. `protocol.ts` is imported rather than having its two strings spelled again here, and
 * it is deliberately free of runtime imports so that bundling it into the preload pulls in
 * nothing else.
 */
const bridge: SpmBridge = {
  invoke: (path: string, args: unknown[]): Promise<IpcResult> =>
    ipcRenderer.invoke(INVOKE_CHANNEL, { path, args }) as Promise<IpcResult>,
}

contextBridge.exposeInMainWorld(BRIDGE_KEY, bridge)
