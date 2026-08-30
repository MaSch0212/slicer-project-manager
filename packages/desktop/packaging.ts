import { join } from 'node:path'

/**
 * The names `package-app.ts` gives what it writes, and the one platform where it stops.
 *
 * Separate from `package-app.ts` for the reason `src/icons.ts` is separate from `app.ts`:
 * `package-app.ts` is a top-level script that packages an application as a side effect of being
 * imported, so nothing in it can be reached by `node --test`. Two things live here for that reason
 * and no other, and both are things a test has to be able to read:
 *
 * - a three-branch platform decision where one branch is "refuse" — the shape that wants
 *   exhaustive cheap coverage rather than a name confirmed by looking at one operating system's
 *   output directory;
 * - `requiredArtifacts()`, the list of files that must exist in the packaged output, which was a
 *   private const in `package-app.ts` and therefore covered by nothing but a manual run.
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

/**
 * What must be in the packaged output afterwards, checked rather than assumed.
 *
 * A packaging script that exits 0 having written half a directory is worse than one that fails:
 * the failure it produces is a window that opens and is blank, or one that opens and cannot open
 * a library, both a long way from the step that caused them. Handing the copying to
 * `@electron/packager` does not retire this list — it widens what it is for, because the copy is
 * now done by a tool whose `ignore` and prune rules this repo does not control.
 *
 * `package-app.ts` stats every path this returns and throws on the first that is not a non-empty
 * file. The list is here rather than there because **that script cannot be imported** — it packages
 * an application as a side effect of being imported, which is this module's whole reason to exist —
 * so as long as the list lived in it, nothing could read it. And nothing else covered it either:
 * `deno task package:desktop` is run by **no CI job**, all eight of which are `ubuntu-latest` and
 * none of which packages, so every entry rested on one manual Windows run. `packaging.test.ts` now
 * asserts the names; the packaging run remains the only thing that says the build wrote the files.
 *
 * ## The migrations are respelled, and that is a standing cost
 *
 * The three migration entries below are literals, so **this list has to be edited with every
 * migration added to `packages/core`, for ever**. The failure of forgetting is the exact one the
 * list exists to catch: `runMigrations` reads a frozen list and `readFileSync` throws on the first
 * file that is not there, so a packaged application missing a migration starts fine and then fails
 * the moment a folder is picked.
 *
 * The durable fix is to derive these entries from that same frozen list — `MIGRATIONS` in
 * `packages/core/src/db/migrate.ts`, the one place a new migration has to be declared for the
 * application to run it at all. Then the two lists cannot disagree. (`build.ts` is not a third
 * place: `copyMigrations` reads the directory rather than naming files.) It is not done here for
 * two reasons: `MIGRATIONS` is a module-private `const` today, so it would have to be exported to
 * be read; and reading it would make this module import from `@spm/core` — a packaging script
 * pulling in the core package to learn three file names — which is a decision about the boundary
 * between the packages, and subsystem F packages what already exists rather than reshaping that.
 * **Do it the first time a fourth migration is added and this list is not**, rather than now: one
 * forgotten migration is what makes the export and the import worth their cost, and until then it
 * is a cost paid against a hypothetical.
 *
 * ## If `asar` is ever turned on, this list is not what keeps the LGPL argument true
 *
 * `package-app.ts` passes `asar: false`, and that is load-bearing: `dist/occt-import-js.wasm` being
 * an ordinary file on disk is how this application meets LGPL-2.1 §6b for the OCCT library it
 * ships, which `THIRD-PARTY-NOTICES.md` sets out. With `asar: true` the `.wasm` and the three files
 * under `dist/third-party/` would have to be named in packager's `asarUnpack` for that to stay
 * true.
 *
 * The entries below do **not** quietly survive that change, and nobody should expect them to.
 * Packager writes `resources/app.asar` plus `resources/app.asar.unpacked/` instead of
 * `resources/app`, and `package-app.ts` builds `appDir` as `join(outDir, 'resources', 'app')` — a
 * directory an asar build does not create — so every path here would fail until these entries were
 * rewritten too. That is the wanted behaviour rather than a gap: it means asar cannot be turned on
 * without reading this.
 */
export function requiredArtifacts(outDir: string, appDir: string, executable: string): string[] {
  return [
    // The executable, under the name `packagedExecutableName` chose. Packager's own rename is what
    // produces it, so this is the assertion that `executableName` still means what it means — a
    // packager release that changed how it sanitises that string would otherwise ship a
    // differently-named binary and say nothing.
    join(outDir, executable),
    join(appDir, 'package.json'),
    join(appDir, 'dist', 'main.js'),
    join(appDir, 'dist', 'preload.js'),
    join(appDir, 'dist', 'occt-import-js.wasm'),
    // Every migration, not a spot-check. See the docblock for what one missing file costs, what
    // respelling them here costs in return, and the derivation that would retire it.
    join(appDir, 'dist', 'migrations', '001_init.sql'),
    join(appDir, 'dist', 'migrations', '002_preview_claim.sql'),
    join(appDir, 'dist', 'migrations', '003_classifier_version.sql'),
    join(appDir, 'dist', 'renderer', 'index.html'),
    // The window icon, which is a different thing from the executable's own icon resource: this is
    // the file `BrowserWindow` reads at runtime. Staging brings these across — they are inside
    // `dist/` — so this is not what puts them here; it is what notices when they stop arriving. The
    // failure it replaces is silent by construction: `BrowserWindow`'s `icon` option does not throw
    // on a path that does not exist, it just shows Electron's default, and the developer who
    // packaged it sees the right icon because `windowIconPath()` also resolves in the repo layout.
    // Both spellings, because `windowIconPath()` picks between them by platform and the packaging
    // script runs on one platform at a time.
    join(appDir, 'dist', 'icons', 'icon.ico'),
    join(appDir, 'dist', 'icons', 'icon.png'),
    // Copied in with the renderer, and named here for the same reason: the home-screen icon and
    // the manifest are the only files in the renderer directory that nothing in the app *imports*,
    // so a build that stopped emitting them would break no bundle and no test that watched imports.
    join(appDir, 'dist', 'renderer', 'favicon.svg'),
    join(appDir, 'dist', 'renderer', 'manifest.webmanifest'),
    // The LGPL notice obligation, and the same class of file as the two above: nothing imports
    // these and nothing reads them at run time, so they are exactly what a packaging step can stop
    // producing in silence. `LICENSE.md` is `occt-import-js`'s own copy of LGPL-2.1 and
    // `license.occt.txt` is Open CASCADE's; upstream's third text is byte-identical to the first,
    // which `THIRD-PARTY-NOTICES.md` records with its digest.
    join(appDir, 'dist', 'third-party', 'THIRD-PARTY-NOTICES.md'),
    join(appDir, 'dist', 'third-party', 'LICENSE.md'),
    join(appDir, 'dist', 'third-party', 'license.occt.txt'),
    // And this application's own licence, which is an obligation in the other direction: MIT asks
    // that its notice travel in "all copies or substantial portions of the Software", and
    // `dist/main.js` is a copy. It is also what `THIRD-PARTY-NOTICES.md` names in its first
    // sentence, so without it that file points at something no packaged app has. Not under
    // `third-party/`, because `LICENSE.md` there is `occt-import-js`'s LGPL-2.1 and the two would
    // sit a dot-extension apart; `build.ts`'s `copyLicence` carries the rest of the reasoning.
    join(appDir, 'dist', 'LICENSE'),
  ]
}
