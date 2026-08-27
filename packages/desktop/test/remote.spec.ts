import { expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { spawn, type ChildProcess } from 'node:child_process'
import { createServer } from 'node:net'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Capabilities } from '@spm/contract/dtos.ts'
import { activateAccount, closeLibrary, ensureBootstrapAdmin, openLibrary, rescan } from '@spm/core'
import {
  confirmationCalls,
  confirmationsWereParented,
  launchShell,
  newUserDataDir,
  stubFolderPicker,
  stubRemoteConfirmation,
} from './fixtures.ts'

/**
 * Remote-server mode (spec 2.6), against **a real Deno server this file starts**, through a real
 * window.
 *
 * That is the whole point of it. `remote.test.ts` drives the proxy against an echo server and can
 * assert negatives a real server cannot be made to produce; this one proves the other half — that
 * the thing on the other end really is the app's own server, that the renderer really runs the
 * browser's `HttpApiClient` against it unchanged, and that spec 2.4's union is what the UI keys
 * off. Nothing here is stubbed except the folder dialog, which has no automation surface.
 */

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(here, '../../..')
const PASSWORD = 'desktop remote password'

/** A port nothing is listening on right now, so a stray dev server cannot collide with this. */
async function freePort(): Promise<number> {
  const probe = createServer()
  await new Promise<void>((done) => probe.listen(0, '127.0.0.1', done))
  const address = probe.address()
  if (!address || typeof address !== 'object') throw new Error('no port')
  const { port } = address
  await new Promise<void>((done) => probe.close(() => done()))
  return port
}

/**
 * A library with an activated admin and one project already indexed, prepared with `@spm/core`
 * directly and before the server starts.
 *
 * Through core rather than through the server's own API because what this spec is testing is the
 * desktop shell, not the server: a project that is already there is a fixture, and one created
 * over the wire would make the assertion below depend on the very path it is meant to prove.
 */
async function seedServerLibrary(project: string): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), 'spm-remote-lib-'))
  const lib = openLibrary(dir)
  try {
    const boot = await ensureBootstrapAdmin(lib)
    if (!boot) throw new Error('a fresh library must produce a bootstrap admin')
    const { user } = await activateAccount(lib, boot.token, PASSWORD, 'desktop remote spec')
    // The server's libraries are per-user; a project folder lives under the owner's own directory.
    mkdirSync(join(dir, user.username, project), { recursive: true })
    writeFileSync(join(dir, user.username, project, 'part.stl'), 'solid part\nendsolid part\n')
    const result = await rescan(lib, { userId: user.id, isAdmin: user.isAdmin })
    expect(result.adopted).toBe(1)
  } finally {
    closeLibrary(lib)
  }
  return dir
}

type RunningServer = { origin: string; stop: () => void }

async function startServer(libraryDir: string): Promise<RunningServer> {
  const port = await freePort()
  const origin = `http://127.0.0.1:${port}`
  const child: ChildProcess = spawn(
    process.platform === 'win32' ? 'deno.exe' : 'deno',
    // `--config` naming the root is load-bearing for the same reason `playwright.config.ts` in
    // packages/web spells it out: Deno stops at the first config above the entrypoint, and that
    // one does not carry the workspace import map.
    [
      'run',
      '-A',
      '--config',
      join(repoRoot, 'deno.json'),
      join(repoRoot, 'packages/server/main.ts'),
    ],
    {
      cwd: repoRoot,
      stdio: 'ignore',
      env: { ...process.env, SPM_LIBRARY_DIR: libraryDir, SPM_PORT: String(port) },
    },
  )
  const stop = (): void => void child.kill()
  const deadline = Date.now() + 60_000
  for (;;) {
    if (child.exitCode !== null) throw new Error(`the server exited with ${child.exitCode}`)
    try {
      const response = await fetch(`${origin}/api/capabilities`)
      if (response.ok) {
        await response.body?.cancel()
        return { origin, stop }
      }
    } catch {
      // Not listening yet.
    }
    if (Date.now() > deadline) {
      stop()
      throw new Error(`the server did not come up on ${origin}`)
    }
    await new Promise((wait) => setTimeout(wait, 200))
  }
}

async function signIn(page: Page): Promise<void> {
  await page.getByLabel('Username').fill('admin')
  await page.getByLabel('Password').fill(PASSWORD)
  await page.getByRole('button', { name: 'Sign in' }).click()
}

/** What the renderer's own client answers, which is what every affordance in the UI keys off. */
async function capabilitiesInRenderer(page: Page): Promise<Capabilities> {
  return (await page.evaluate(async () => {
    const response = await fetch('/api/capabilities')
    return (await response.json()) as unknown
  })) as Capabilities
}

let server: RunningServer
let libraryDir: string
const running: ElectronApplication[] = []

test.beforeAll(async () => {
  libraryDir = await seedServerLibrary('Server Widget')
  server = await startServer(libraryDir)
})

test.afterAll(() => server.stop())

test.afterEach(async () => {
  for (const app of running.splice(0)) await app.close().catch(() => {})
})

test('remote mode reaches a real server, and lists the projects that are on it', async () => {
  const app = await launchShell(newUserDataDir(), { remoteUrl: server.origin })
  running.push(app)
  const page = await app.firstWindow()
  await page.waitForLoadState('domcontentloaded')

  // The transport is the browser's `HttpApiClient`, not the IPC one — chosen by the renderer off
  // the switch the shell put on the window, and the only thing about Electron the renderer knows.
  expect(await page.evaluate(() => globalThis.spm.mode)).toBe('remote')

  // *One* window. Self-review found two here: connecting fired the shell's replace-the-window
  // callback before any window existed, and `main()` then made a second — with every assertion
  // in this file still green, because `firstWindow()` answered whichever came first.
  expect(app.windows()).toHaveLength(1)

  // `requiresAuth: true` arrived from the server's own `capabilities()`, through the union, and
  // the guard the browser build already had put the app on /login. Nothing desktop-specific
  // decided this.
  await expect.poll(() => page.url()).toBe('spm://app/login')

  await signIn(page)

  // The project was in the server's library before the app existed. Getting it on screen exercises
  // the whole chain: the renderer's fetch to `spm://app/api/projects`, the shell's proxy, the
  // session cookie the shell is holding, and the server's own routes.
  await expect(page.locator('.spm-projects .spm-project-title')).toHaveText(['Server Widget'], {
    timeout: 20_000,
  })
})

test('the capability set in remote mode is the union, and the UI keys off it', async () => {
  const app = await launchShell(newUserDataDir(), { remoteUrl: server.origin })
  running.push(app)
  const page = await app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  await expect.poll(() => page.url()).toBe('spm://app/login')

  // Spec 2.4's third column, read where the renderer reads it. The server's own
  // `/api/capabilities` says `requiresAuth: true, canManageUsers: true` and nothing else; the
  // shell's remote column contributes the rest and, decisively, keeps `canPickLocalFolder` false.
  expect(await capabilitiesInRenderer(page)).toEqual({
    requiresAuth: true,
    canManageUsers: true,
    canPickLocalFolder: false,
    canLaunchSlicer: false,
    canConfigureSlicers: false,
    canBrowseModelSites: false,
  })

  await signIn(page)
  await expect(page.locator('.spm-projects .spm-project-title')).toHaveText(['Server Widget'], {
    timeout: 20_000,
  })

  // The affordance, not the flag: the header control that local mode offers is absent here
  // because the capability says so, and no component asked which shell it was in.
  await expect(page.getByRole('button', { name: 'Change library folder' })).toHaveCount(0)
  // And the one the server contributes *is* there, which is the other half of the union: a
  // browser talking to this server would show it too, and a local-folder desktop app would not.
  await expect(page.getByRole('link', { name: 'Users' })).toHaveCount(1)
})

/**
 * The session question the brief asks to be answered rather than assumed: **a restart deliberately
 * does not keep the user logged in.**
 *
 * The session lives in the `RemoteHost`'s own map in main-process memory and is never written
 * anywhere, so a new process starts with nothing. The measurement that makes this a decision and
 * not a default is in `remote.ts`: `net.fetch` would have used Electron's own cookie jar, which
 * stored the session cookie as *persistent* under `userData` — a bearer credential for a remote
 * server, at rest, protected by nothing this app controls.
 *
 * Same `userData` across both launches, so the *mode* is what is being shown to survive while the
 * session is shown not to.
 */
test('a restart keeps the server but deliberately not the session', async () => {
  const userDataDir = newUserDataDir()

  // Connected the way a user does — through the connect page — because that is the path that
  // *remembers*. `SPM_REMOTE_URL` deliberately does not, being an override for one launch.
  const first = await launchShell(userDataDir, { fakeMode: 'remote' })
  running.push(first)
  const connectPage = await first.firstWindow()
  await connectPage.waitForLoadState('domcontentloaded')
  await expect.poll(() => connectPage.url(), { timeout: 20_000 }).toBe('spm://app/desktop/connect')
  await stubRemoteConfirmation(first, true)
  await connectPage.getByLabel('Server address').fill(server.origin)
  const afterConnect = first.waitForEvent('window')
  await connectPage.getByRole('button', { name: 'Connect', exact: true }).click()

  const firstPage = await afterConnect
  await firstPage.waitForLoadState('domcontentloaded')
  await signIn(firstPage)
  await expect(firstPage.locator('.spm-projects .spm-project-title')).toHaveText(
    ['Server Widget'],
    { timeout: 20_000 },
  )
  await first.close()
  running.length = 0

  // Written down: the mode and the origin, so the next launch needs no question.
  const state = JSON.parse(readFileSync(join(userDataDir, 'state.json'), 'utf8')) as {
    mode?: string
    remoteUrl?: string
  }
  expect(state.mode).toBe('remote')
  expect(state.remoteUrl).toBe(server.origin)

  // Nothing that looks like a token, anywhere in what was written.
  expect(readFileSync(join(userDataDir, 'state.json'), 'utf8')).not.toContain('spm_session')

  // No environment override at all: what reconnects this launch is `state.json` alone.
  const second = await launchShell(userDataDir)
  running.push(second)
  const secondPage = await second.firstWindow()
  await secondPage.waitForLoadState('domcontentloaded')

  // Still the same server, and still asking who you are.
  expect(await secondPage.evaluate(() => globalThis.spm.mode)).toBe('remote')
  await expect.poll(() => secondPage.url()).toBe('spm://app/login')
  await expect(secondPage.getByLabel('Password')).toHaveCount(1)
})

/**
 * The failure the plan names by itself: a stale `HttpApiClient` after switching to local.
 *
 * Driven through the production path a user has — the application menu, which is the only way
 * back to a folder in remote mode, because `canPickLocalFolder` is false there and the header
 * control is correctly absent.
 */
test('switching to a local folder leaves nothing of the server behind', async () => {
  const app = await launchShell(newUserDataDir(), {
    remoteUrl: server.origin,
    fakeMode: 'local',
  })
  running.push(app)
  const page = await app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  await signIn(page)
  await expect(page.locator('.spm-projects .spm-project-title')).toHaveText(['Server Widget'], {
    timeout: 20_000,
  })

  const localFolder = mkdtempSync(join(tmpdir(), 'spm-remote-local-'))
  mkdirSync(join(localFolder, 'Local Widget'), { recursive: true })
  writeFileSync(join(localFolder, 'Local Widget', 'part.stl'), 'solid part\nendsolid part\n')
  await stubFolderPicker(app, localFolder)

  // The menu item, clicked the way Electron invokes it. `SPM_FAKE_MODE=local` answers the mode
  // question it raises; the folder dialog it goes on to is the stub above.
  const replaced = app.waitForEvent('window')
  await app.evaluate(({ Menu }) => {
    const item = Menu.getApplicationMenu()?.getMenuItemById('spm-choose-library')
    if (!item?.click) throw new Error('the Library menu item is missing')
    item.click()
  })

  // The window is *replaced*, not reloaded: the transport changed, and `additionalArguments` is
  // fixed for the life of a webContents, so a reload would rebuild the renderer with the previous
  // transport — which is the stale client itself.
  const local = await replaced
  await local.waitForLoadState('domcontentloaded')
  expect(await local.evaluate(() => globalThis.spm.mode)).toBe('local')

  await expect(local.locator('.spm-projects .spm-project-title')).toHaveText(['Local Widget'], {
    timeout: 20_000,
  })

  // No login screen, because the capability set is the local column again.
  expect(local.url()).toBe('spm://app/projects')
  await expect(local.getByRole('button', { name: 'Change library folder' })).toHaveCount(1)

  // And the server is gone from the shell as well as from the renderer: the `/api` branch of the
  // protocol handler finds no remote host, so it refuses rather than proxying out of a server the
  // user has left. A stale `RemoteHost` here would answer 200 with the server's projects.
  const status = await local.evaluate(async () => (await fetch('/api/capabilities')).status)
  expect(status).toBe(404)
})

/**
 * An upload, in remote mode, end to end — the one piece of machinery this mode needed that the
 * browser arm does not.
 *
 * `content-length` is a forbidden header name, so Chromium strips the one `HttpApiClient` sets and
 * — measured on Electron 44.0.0 — does not put the body's own length on the `Request` the
 * protocol handler receives either. The server refuses a body with no length with 411 before it
 * writes a byte (spec 5.6), so without the length the renderer declares in a header of the
 * shell's own, every upload in this mode fails. `remote.test.ts` asserts each half; this is the
 * one place both halves and the real server are in the same sentence.
 */
test('an upload in remote mode reaches the server, length and all', async () => {
  const app = await launchShell(newUserDataDir(), { remoteUrl: server.origin })
  running.push(app)
  const page = await app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  await signIn(page)
  await expect(page.locator('.spm-projects .spm-project-title')).toHaveText(['Server Widget'], {
    timeout: 20_000,
  })

  const source = join(mkdtempSync(join(tmpdir(), 'spm-remote-upload-')), 'uploaded.stl')
  const contents = `solid uploaded${' '.repeat(2000)}\nendsolid uploaded\n`
  writeFileSync(source, contents)

  await page.locator('.spm-project-link').first().click()
  await expect(page.locator('h1')).toHaveText('Server Widget')
  await page.locator('input[type="file"]').setInputFiles(source)

  await expect(page.locator('.spm-file', { hasText: 'uploaded.stl' })).toBeVisible({
    timeout: 20_000,
  })
  // On the server's own disk, whole. A 411 would have left the row absent and an error message
  // in its place; a truncated body would have left a file of the wrong size.
  expect(readFileSync(join(libraryDir, 'admin', 'Server Widget', 'uploaded.stl'), 'utf8')).toBe(
    contents,
  )
  await expect(page.locator('jig-message[color="error"]')).toHaveCount(0)
})

test('the mode question is what first run asks, before any folder dialog', async () => {
  const app = await launchShell(newUserDataDir(), { fakeMode: 'remote' })
  running.push(app)
  const page = await app.firstWindow()
  await page.waitForLoadState('domcontentloaded')

  // Answering "a server" sends the window to the desktop-only connect page, which is the only
  // part of the mode question that is not a native dialog — a message box cannot hold a text
  // field. The page is reached with the IPC transport, which is the one that can answer
  // `library.connect`.
  await expect.poll(() => page.url(), { timeout: 20_000 }).toBe('spm://app/desktop/connect')
  await expect(page.getByRole('heading', { name: 'Where is your library?' })).toBeVisible()

  await stubRemoteConfirmation(app, true)
  await page.getByLabel('Server address').fill(server.origin)
  const replaced = app.waitForEvent('window')
  await page.getByRole('button', { name: 'Connect', exact: true }).click()

  const connected = await replaced
  await connected.waitForLoadState('domcontentloaded')
  expect(await connected.evaluate(() => globalThis.spm.mode)).toBe('remote')
  await expect.poll(() => connected.url()).toBe('spm://app/login')

  // The user was asked first, and the question named the origin.
  const asked = await confirmationCalls(app)
  expect(asked).toHaveLength(1)
  expect(String(asked[0]!['message'])).toContain(server.origin)
})

/**
 * Ruling C-20, through the whole boundary: the renderer may ask, and only the user may answer.
 *
 * Driven with the bare bridge rather than through the connect page, because the page is not the
 * threat — a compromised renderer that never renders that page can make this call, and the gate
 * has to be in front of the *channel*.
 */
test('a server the renderer names is not connected to until the user confirms it', async () => {
  const app = await launchShell(newUserDataDir(), { fakeMode: 'cancel' })
  running.push(app)
  const page = await app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  await stubRemoteConfirmation(app, false)

  const refused = await page.evaluate(
    (origin) => globalThis.spm.invoke('library.connect', [origin]),
    server.origin,
  )

  // Null, not an error: a refusal is not a failure. And nothing was pointed anywhere — with no
  // remote host, the `/api` branch of the protocol handler 404s.
  expect(refused).toEqual({ ok: true, value: null })
  expect(await page.evaluate(async () => (await fetch('/api/capabilities')).status)).toBe(404)

  const asked = await confirmationCalls(app)
  expect(asked).toHaveLength(1)
  expect(String(asked[0]!['message'])).toContain(server.origin)
  // Raised **on the window that asked**, which is what makes it window-modal: measured on
  // Electron 44.0.0, a parented message box leaves `win.isEnabled()` false while it is up and a
  // parentless one leaves it true. This is the one dialog in the shell raised by untrusted code,
  // so tying it to the page that provoked it is the difference between a question about
  // something and a box floating on its own.
  expect(await confirmationsWereParented(app)).toEqual([true])

  // And the same call, confirmed, does connect — so what the test above measured is the answer
  // and not some other reason the connection did not happen.
  await stubRemoteConfirmation(app, true)
  const replaced = app.waitForEvent('window')
  await page.evaluate((origin) => globalThis.spm.invoke('library.connect', [origin]), server.origin)
  const connected = await replaced
  await connected.waitForLoadState('domcontentloaded')
  expect(await connected.evaluate(() => globalThis.spm.mode)).toBe('remote')
})

/**
 * The sequence review walked, end to end: remote mode → menu → "connect to a server" → "choose a
 * folder". Every step of it left the renderer running `HttpApiClient` against a proxy that had
 * stopped answering, and no test covered it.
 */
test('leaving a live server for the connect page rebuilds the renderer on the way', async () => {
  const app = await launchShell(newUserDataDir(), {
    remoteUrl: server.origin,
    fakeMode: 'remote',
  })
  running.push(app)
  const page = await app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  expect(await page.evaluate(() => globalThis.spm.mode)).toBe('remote')

  // Library → Choose library… → "Connect to a server…" (answered by SPM_FAKE_MODE).
  const onConnectPage = app.waitForEvent('window')
  await app.evaluate(({ Menu }) => {
    const item = Menu.getApplicationMenu()?.getMenuItemById('spm-choose-library')
    if (!item?.click) throw new Error('the Library menu item is missing')
    item.click()
  })

  const connect = await onConnectPage
  await connect.waitForLoadState('domcontentloaded')
  await expect.poll(() => connect.url(), { timeout: 20_000 }).toBe('spm://app/desktop/connect')
  // The window was replaced, not navigated: a navigated one would still carry
  // `--spm-mode=remote` and rebuild `HttpApiClient` against a proxy with no server behind it.
  expect(await connect.evaluate(() => globalThis.spm.mode)).toBe('local')
  expect(await connect.evaluate(async () => (await fetch('/api/capabilities')).status)).toBe(404)

  // And the page's own folder button — the one its comment exists for — really opens a library.
  const localFolder = mkdtempSync(join(tmpdir(), 'spm-connect-local-'))
  mkdirSync(join(localFolder, 'From Connect Page'), { recursive: true })
  writeFileSync(join(localFolder, 'From Connect Page', 'part.stl'), 'solid p\nendsolid p\n')
  await stubFolderPicker(app, localFolder)
  await connect.getByRole('button', { name: 'Choose a folder…' }).click()

  await expect.poll(() => connect.url(), { timeout: 20_000 }).toBe('spm://app/projects')
  await expect(connect.locator('.spm-projects .spm-project-title')).toHaveText(
    ['From Connect Page'],
    { timeout: 20_000 },
  )
  expect(await connect.evaluate(() => globalThis.spm.mode)).toBe('local')
})

test('a server address the shell will not accept is reported, and nothing changes', async () => {
  const app = await launchShell(newUserDataDir(), { fakeMode: 'remote' })
  running.push(app)
  const page = await app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  await expect.poll(() => page.url(), { timeout: 20_000 }).toBe('spm://app/desktop/connect')

  // Validated in the main process, because the URL is untrusted input from the renderer.
  await page.getByLabel('Server address').fill('file:///C:/Windows')
  await page.getByRole('button', { name: 'Connect', exact: true }).click()

  await expect(page.getByRole('alert')).toContainText('not a server address')
  expect(page.url()).toBe('spm://app/desktop/connect')
})

test('the application menu carries the way back, and the developer tools', async () => {
  const app = await launchShell(newUserDataDir(), { remoteUrl: server.origin })
  running.push(app)
  await app.firstWindow()

  const menu = await app.evaluate(({ Menu }) =>
    (Menu.getApplicationMenu()?.items ?? []).map((item) => ({
      label: item.label,
      submenu: (item.submenu?.items ?? []).map((child) => child.label),
    })),
  )

  const library = menu.find((item) => item.label === 'Library')
  expect(library?.submenu).toContain('Choose library…')
  // `dev:desktop` means "with devtools available", and this is where they are. A custom menu that
  // dropped `role: 'toggleDevTools'` would take away what Electron's default menu supplies.
  const view = menu.find((item) => item.label === 'View')
  expect(view?.submenu.some((label) => /developer tools/i.test(label))).toBe(true)
})
