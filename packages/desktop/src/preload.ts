import { contextBridge, ipcRenderer, webUtils } from 'electron'
import {
  BRIDGE_KEY,
  FILE_REF_KEY,
  INVOKE_CHANNEL,
  type IpcResult,
  type SpmBridge,
} from './protocol.ts'

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
 * build.ts. `protocol.ts` is imported rather than having its strings spelled again here, and it
 * is deliberately free of runtime imports so that bundling it into the preload pulls in nothing
 * else.
 */

/**
 * Tokens this preload has minted, and the paths behind them. Private to the isolated world: the
 * main world holds only the opaque token, so it cannot name a file the user did not pick.
 *
 * Entries are removed as they are spent, and a token is minted immediately before the `invoke`
 * that consumes it (see `IpcApiClient.readBody`), so this holds at most one live entry per
 * in-flight upload. A counter rather than a random id — the map is unreachable from the main
 * world, so unguessability buys nothing.
 */
const pickedPaths = new Map<string, string>()
let nextRef = 0

function fileRef(file: unknown): string | null {
  // Returns '' for a Blob or a script-constructed File, which is the whole discriminator.
  const localPath = webUtils.getPathForFile(file as File)
  if (!localPath) return null
  const token = `ref-${++nextRef}`
  pickedPaths.set(token, localPath)
  return token
}

/**
 * Swaps a minted token for the real path, and refuses a path the main world tried to supply.
 *
 * The second half is the security-relevant one. Without it a compromised renderer could send
 * `{ localPath: 'C:/Users/…/.ssh/id_rsa' }` and have the main process read a file the user never
 * chose (constraint 4). An unknown token is not turned into anything either: the object goes on
 * without either key and the main process's `uploadBodySchema` rejects it as `Validation`.
 */
function resolveArg(arg: unknown): unknown {
  if (arg === null || typeof arg !== 'object') return arg
  const record = arg as Record<string, unknown>
  const token = record[FILE_REF_KEY]
  if (typeof token === 'string') {
    const localPath = pickedPaths.get(token)
    pickedPaths.delete(token)
    return localPath === undefined ? {} : { localPath }
  }
  if (Object.hasOwn(record, 'localPath')) {
    const stripped = { ...record }
    delete stripped['localPath']
    return stripped
  }
  return arg
}

const bridge: SpmBridge = {
  fileRef,
  invoke: (path: string, args: unknown[]): Promise<IpcResult> =>
    ipcRenderer.invoke(INVOKE_CHANNEL, {
      path,
      // Array.isArray rather than trusting the caller: a non-array reaches the main process as
      // it is and is refused there, which is where the argument-shape check belongs.
      args: Array.isArray(args) ? args.map(resolveArg) : args,
    }) as Promise<IpcResult>,
}

contextBridge.exposeInMainWorld(BRIDGE_KEY, bridge)
