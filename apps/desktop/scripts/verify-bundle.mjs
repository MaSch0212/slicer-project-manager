// The last step of `pnpm build:desktop`: checks the bundle `tauri build` just made.
//
// It is the built-artifact half of what the Electron build's `requiredArtifacts` checked (the
// source half is `src-tauri/tests/packaging.rs`): the installer exists and has a sane size, the
// executable is named for the app, the licence and notices were put beside the program and are the
// repository's own, and nothing of a browser engine travelled in the bundle (the point of Tauri:
// the operating system's WebView2 is used, never shipped).
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = fileURLToPath(new URL('.', import.meta.url))
const repoRoot = resolve(here, '..', '..', '..')
const release = join(repoRoot, 'target', 'release')
const nsisDir = join(release, 'bundle', 'nsis')
const productName = 'Slicer Project Manager'

const problems = []
const fail = (message) => problems.push(message)
const mib = (bytes) => (bytes / 1024 / 1024).toFixed(2)

const executable = join(release, `${productName}.exe`)
if (!existsSync(executable)) fail(`the executable is missing: ${executable}`)
else if (statSync(executable).size < 1024 * 1024) fail('the executable is implausibly small')

const installers = existsSync(nsisDir)
  ? readdirSync(nsisDir).filter((name) => name.endsWith('-setup.exe'))
  : []
if (installers.length !== 1) fail(`expected one NSIS installer in ${nsisDir}, found ${installers}`)
const installer = installers[0] ? join(nsisDir, installers[0]) : null
if (installer) {
  if (!installers[0].startsWith(productName))
    fail(`the installer is not named for the app: ${installers[0]}`)
  const size = statSync(installer).size
  if (size < 1024 * 1024) fail('the installer is implausibly small')
  // A Chromium would be 100 MB and more on its own.
  if (size > 60 * 1024 * 1024) fail(`the installer is ${mib(size)} MiB: something big was bundled`)
}

for (const [name, source] of [
  ['LICENSE', 'LICENSE'],
  ['THIRD-PARTY-NOTICES.md', 'THIRD-PARTY-NOTICES.md'],
]) {
  const shipped = join(release, 'third-party', name)
  if (!existsSync(shipped)) fail(`${shipped} was not put beside the program`)
  else if (!readFileSync(shipped).equals(readFileSync(join(repoRoot, source)))) {
    fail(`${shipped} is not the repository's ${source}`)
  }
}

// No browser engine in what ships: neither files next to the executable nor in the installer's name
// set. (The installer itself is compressed, so the size bound above is its guard.)
const engine = /chrom(e|ium)|libcef|electron|msedgewebview2|webview2loader\.dll/i
const shippedNames = [
  ...(existsSync(release) ? readdirSync(release).filter((name) => !name.endsWith('.d')) : []),
  ...(existsSync(nsisDir) ? readdirSync(nsisDir) : []),
]
for (const name of shippedNames) {
  if (engine.test(name)) fail(`a browser engine file is in the bundle: ${name}`)
}

if (problems.length > 0) {
  console.error(`verify-bundle: ${problems.length} problem(s)\n  ${problems.join('\n  ')}`)
  process.exit(1)
}
console.log(
  `verify-bundle: ok\n  installer: ${installer} (${mib(statSync(installer).size)} MiB)\n  executable: ${executable} (${mib(statSync(executable).size)} MiB)`,
)
