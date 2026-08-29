/**
 * The names `package-app.ts` gives what it writes, and the one platform where it stops.
 *
 * Separate from `package-app.ts` for the reason `src/icons.ts` is separate from `app.ts`:
 * `package-app.ts` is a top-level script that packages an application as a side effect of being
 * imported, so nothing in it can be reached by `node --test`. What is left here is a three-branch
 * platform decision where one branch is "refuse" — the shape that wants exhaustive cheap coverage
 * rather than a name confirmed by looking at one operating system's output directory.
 */

/** `app.setName` decides the userData directory; this only names the folder and the executable. */
export const APP_SLUG = 'slicer-project-manager'

/**
 * The product name, spelled here as well as at `APP_NAME` in `src/app.ts`, not imported from it.
 *
 * `app.ts` imports `electron` at module scope, so reading one string out of it would mean loading
 * the Electron runtime inside a packaging script that otherwise needs nothing but `node:fs`. The
 * duplication is deliberate and bounded to these two files; if the app is ever renamed, both
 * change. **Unmeasured:** nothing mechanically enforces that they agree — a source-text assertion
 * across two files was considered and rejected as more false failures than caught drift.
 */
export const APP_NAME = 'Slicer Project Manager'

/**
 * What the packaged executable is called, per platform.
 *
 * - **`win32` — `Slicer Project Manager.exe`.** Explorer, the taskbar's pinned entry and the
 *   Alt-Tab switcher label an application with its file name, so on Windows the file name is
 *   user-facing text and `electron.exe` is a defect rather than a cosmetic detail. The spaces cost
 *   nothing there; nothing types this path by hand.
 * - **everything else — `slicer-project-manager`.** Linux, where the same string is typed at a
 *   shell and goes in a `.desktop` entry's `Exec=`, both of which need a space quoted or escaped
 *   every time. Nothing on Linux shows the executable's file name to a user: the name and icon a
 *   Linux desktop displays come from a `.desktop` entry that an installer places, and installers
 *   are deferred with reasons in the plan's Scope. So the slug wins, and it is the slug the output
 *   directory is already named with.
 *
 * This is `package-app.ts`'s `executableName`, and `@electron/packager` turns it into the file:
 * `WindowsApp.newElectronName` appends `.exe`, `LinuxApp.newElectronName` does not. The `.exe`
 * above is therefore what the packaged file is *called*, which is what `package-app.ts` needs to
 * assert afterwards — the string handed to packager drops it.
 *
 * ## macOS throws, over one missing file
 *
 * Since `package-app.ts` calls `@electron/packager`, the mechanics of a macOS build are no longer
 * the gap: packager renames `Electron.app`, renames `Contents/MacOS/Electron`, and writes the
 * `Info.plist` keys. What is still missing is the icon, and it is missing in the quiet way.
 *
 * Packager does not convert icons; it picks the platform's format by extension. Its
 * `normalizeIconExtension` swaps `.ico` for `.icns`, checks whether that file exists, and if it
 * does not, emits a **warning** and carries on — producing a finished, launchable `.app` wearing
 * Electron's logo. `deno task icons` writes `.ico` and `.png` and nothing in this repo converts to
 * `.icns`, so that warning is what a macOS run would hit today.
 *
 * A packaging step whose failure mode is a warning and a wrong icon is the thing `package-app.ts`
 * argues against in its own words, so this refuses instead, from the constant that script computes
 * first — before anything is written. It is a narrow gap now and the message says so, rather than
 * implying the whole platform is unimplemented.
 */
export function packagedExecutableName(platform: string): string {
  if (platform === 'darwin') {
    throw new Error(
      'macOS packaging is not implemented, and the gap is one file. @electron/packager handles ' +
        'the .app bundle rename, the Contents/MacOS/ executable rename and the Info.plist keys, ' +
        'but it does not convert icons — it looks for icons/icon.icns beside the .ico, and when ' +
        "that is absent it warns and ships a bundle wearing Electron's logo rather than failing. " +
        '`deno task icons` writes .ico and .png only. Teach tools/generate-icons.ts to emit an ' +
        '.icns (and tools/icons.test.ts to check it), then delete this branch.',
    )
  }
  return platform === 'win32' ? `${APP_NAME}.exe` : APP_SLUG
}
