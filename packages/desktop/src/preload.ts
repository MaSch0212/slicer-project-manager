import { contextBridge } from 'electron'

/**
 * The renderer's only door into the main process.
 *
 * It is empty on purpose. Task 2 puts `invoke(path, args)` on it, backed by
 * `ipcMain.handle('spm:invoke', ...)`. The file exists now so the window is created with a real
 * preload path from the start: adding the bridge later is then a change to this file alone, and
 * not a change to `webPreferences`, where `sandbox: true` and `contextIsolation: true` are the
 * things holding constraint 3 up.
 *
 * Bundled as CommonJS, unlike main.ts. That is not an inconsistency: a sandboxed preload runs in
 * a restricted context that has no ESM loader at all, and an `import` statement here fails at
 * load with the bridge silently absent. main.ts must be ESM for the opposite reason — see
 * build.ts.
 */
contextBridge.exposeInMainWorld('spm', {})
