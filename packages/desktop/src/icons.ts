/**
 * Which icon file each platform's window wants, in a module with no imports.
 *
 * Separate from `app.ts` for the same reason `urls.ts` is: `app.ts` imports `electron`, so nothing
 * in it can be reached by a plain `node --test`, and this is a three-case decision where one of
 * the cases is "none" — exactly the shape that wants exhaustive cheap coverage rather than a
 * guess confirmed by opening the app on one operating system.
 *
 * The three cases, and why each is what it is:
 *
 * - **`win32` — `icon.ico`.** Windows picks a different frame for different chrome: 16 for the
 *   title bar, 32 for the taskbar at 100% scaling and more as that grows, 256 for Alt-Tab and
 *   Explorer's large views. A PNG is accepted and leaves Windows rescaling one bitmap for all of
 *   them, which is a blurry title bar and nothing that fails.
 * - **`darwin` — nothing.** `BrowserWindow`'s `icon` option is ignored on macOS; the dock icon
 *   comes from the application bundle's `.icns`, which `package-app.ts` does not build (it fails
 *   loudly on macOS and says why). Returning a path here would be a value that looks like it does
 *   something and does not, so this returns null and `createMainWindow` passes `undefined`.
 * - **everything else — `icon.png`.** Linux, where the option takes an image rather than an icon
 *   container and the window manager scales it. 512 is the source artwork's own size, so nothing
 *   is upscaled.
 *
 * Both filenames are written by `deno task icons` into `packages/desktop/icons/` and copied next
 * to the main bundle by `build.ts`. This function names them; `windowIconPath` in `app.ts` is what
 * resolves them, and the resolution is the part that has to be right in two different layouts.
 */
export function windowIconFile(platform: string): string | null {
  if (platform === 'darwin') return null
  return platform === 'win32' ? 'icon.ico' : 'icon.png'
}
