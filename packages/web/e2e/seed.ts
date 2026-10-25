import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import type { BrowserContext } from '@playwright/test'
import { binaryStl, cube, cylinder, obj, pyramid, stepStub, threeMf, type Mesh } from './fixtures'

/**
 * A real `spm-server` over a throwaway library, seeded with a few projects, for visual checks and
 * for the e2e suite built on top of it (web part 3).
 *
 *   const server = await startServer({ webRoot })      // cargo run -p spm-server, activated
 *   await seedLibrary(server)                           // projects, tags, files, a missing folder
 *   await applySession(context, server)                 // the browser is signed in as the admin
 *   ...
 *   await server.stop()                                 // kills the process tree, deletes the library
 *
 * Every listener binds 127.0.0.1 (`SPM_HOST`): any other address raises a firewall prompt on
 * Windows. The library lives in the OS temp directory and is removed by `stop()`.
 */

const REPO_ROOT = resolve(import.meta.dirname, '../../..')
/** Where `vite build` writes the bundle the server can serve. */
export const WEB_DIST = resolve(import.meta.dirname, '../dist')

export const ADMIN_USERNAME = 'admin'
export const ADMIN_PASSWORD = 'e2e test password'

export type StartOptions = {
  /** Serve this built bundle (`SPM_WEB_ROOT`). Defaults to `packages/web/dist` when it exists. */
  webRoot?: string
  /** Or proxy the page to a running Vite dev server (`SPM_DEV_UI_ORIGIN`). Wins over `webRoot`. */
  devUiOrigin?: string
  /** How often the preview queue runs. Small, so thumbnails appear within a test. */
  previewIntervalMs?: number
  /** Any other `SPM_*` variable to set. */
  env?: Record<string, string>
  /** How long to wait for the build and the first request. A cold `cargo run` compiles first. */
  startTimeoutMs?: number
}

export type ApiResult<T> = { status: number; body: T }

export type SeededServer = {
  /** `http://127.0.0.1:<port>`. */
  origin: string
  libraryDir: string
  username: string
  password: string
  /** The session cookie of the activated admin, for `applySession` and for `request`. */
  session: { name: string; value: string }
  /** A call to the REST API as the admin. Throws on a status of 400 or more. */
  request<T = unknown>(method: string, path: string, body?: unknown): Promise<T>
  /** POSTs raw bytes as a file upload into a project. */
  upload(projectId: string, name: string, bytes: Uint8Array): Promise<{ id: string }>
  /** Resolves once no file of any project is still `pending` (the preview queue has caught up). */
  waitForPreviews(timeoutMs?: number): Promise<void>
  /** Stops the server (the whole process tree) and deletes the library. Safe to call twice. */
  stop(): Promise<void>
}

async function freePort(): Promise<number> {
  return await new Promise((resolvePort, reject) => {
    const probe = createServer()
    probe.once('error', reject)
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address()
      probe.close(() => {
        if (address && typeof address === 'object') resolvePort(address.port)
        else reject(new Error('no port'))
      })
    })
  })
}

function killTree(child: ChildProcess): void {
  if (child.exitCode !== null || child.pid === undefined) return
  if (process.platform === 'win32') {
    // `cargo run` is the parent of the server: killing only cargo would leave the server running.
    spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' })
  } else {
    child.kill('SIGTERM')
  }
}

const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms))

/**
 * Starts `cargo run -p spm-server` on a free loopback port over a new temporary library, waits for
 * it to answer, and activates the bootstrap admin through the `/activate#<token>` path the server
 * prints on first run (`admin` / `ADMIN_PASSWORD`).
 */
export async function startServer(options: StartOptions = {}): Promise<SeededServer> {
  const libraryDir = mkdtempSync(join(tmpdir(), 'spm-seed-'))
  const port = await freePort()
  const origin = `http://127.0.0.1:${port}`
  const webRoot = options.webRoot ?? (existsSync(WEB_DIST) ? WEB_DIST : undefined)

  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
    SPM_HOST: '127.0.0.1',
    SPM_PORT: String(port),
    SPM_LIBRARY_DIR: libraryDir,
    SPM_PREVIEW_INTERVAL_MS: String(options.previewIntervalMs ?? 300),
    SPM_LOG_LEVEL: 'error',
    ...options.env,
  }
  delete env['SPM_DEV_UI_ORIGIN']
  delete env['SPM_WEB_ROOT']
  if (options.devUiOrigin) env['SPM_DEV_UI_ORIGIN'] = options.devUiOrigin
  else if (webRoot) env['SPM_WEB_ROOT'] = webRoot

  const child = spawn('cargo', ['run', '--quiet', '-p', 'spm-server'], {
    cwd: REPO_ROOT,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  })
  let output = ''
  let activation: string | undefined
  const onData = (chunk: Buffer) => {
    output += chunk.toString()
    activation ??= /\/activate#(\S+)/.exec(output)?.[1]
  }
  child.stdout!.on('data', onData)
  child.stderr!.on('data', onData)

  let stopped = false
  const stop = async () => {
    if (stopped) return
    stopped = true
    killTree(child)
    // The library files can be held for a moment after the process dies.
    for (let attempt = 0; attempt < 10; attempt++) {
      try {
        rmSync(libraryDir, { recursive: true, force: true })
        return
      } catch {
        await sleep(200)
      }
    }
  }

  try {
    const deadline = Date.now() + (options.startTimeoutMs ?? 300_000)
    for (;;) {
      if (child.exitCode !== null) {
        throw new Error(`spm-server exited with ${child.exitCode} before it was ready:\n${output}`)
      }
      if (Date.now() > deadline) throw new Error(`spm-server did not start in time:\n${output}`)
      try {
        const response = await fetch(`${origin}/api/capabilities`)
        if (response.ok && activation) break
      } catch {
        // not listening yet
      }
      await sleep(250)
    }

    const response = await fetch(`${origin}/api/auth/activation/${activation}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ password: ADMIN_PASSWORD, confirm: ADMIN_PASSWORD }),
    })
    if (!response.ok)
      throw new Error(`activation failed: ${response.status} ${await response.text()}`)
    const cookie = (response.headers.getSetCookie()[0] ?? '').split(';')[0] ?? ''
    const [name, ...rest] = cookie.split('=')
    if (!name) throw new Error('activation set no session cookie')
    const session = { name, value: rest.join('=') }
    const cookieHeader = `${session.name}=${session.value}`

    async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
      const result = await fetch(`${origin}${path}`, {
        method,
        headers: {
          cookie: cookieHeader,
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      })
      if (result.status === 204) return undefined as T
      const text = await result.text()
      if (!result.ok) throw new Error(`${method} ${path} -> ${result.status}: ${text}`)
      return JSON.parse(text) as T
    }

    const server: SeededServer = {
      origin,
      libraryDir,
      username: ADMIN_USERNAME,
      password: ADMIN_PASSWORD,
      session,
      request,
      async upload(projectId, name, bytes) {
        const result = await fetch(`${origin}/api/projects/${projectId}/files`, {
          method: 'POST',
          headers: { cookie: cookieHeader, 'x-spm-file-name': encodeURIComponent(name) },
          body: bytes as unknown as BodyInit,
        })
        const text = await result.text()
        if (!result.ok) throw new Error(`upload ${name} -> ${result.status}: ${text}`)
        return JSON.parse(text) as { id: string }
      },
      async waitForPreviews(timeoutMs = 60_000) {
        const deadline = Date.now() + timeoutMs
        for (;;) {
          const projects = await request<{ id: string }[]>(
            'GET',
            '/api/projects?includeArchived=true',
          )
          const pending: string[] = []
          for (const project of projects) {
            const detail = await request<{
              name: string
              state: string
              files: { name: string; kind: string; previewState: string }[]
            }>('GET', `/api/projects/${project.id}`)
            // A project whose folder is gone never gets its previews made; do not wait for them.
            if (detail.state === 'missing') continue
            for (const file of detail.files) {
              // A file of kind `other` is never previewed: the server reports it pending forever.
              if (file.previewState === 'pending' && file.kind !== 'other') {
                pending.push(`${detail.name}/${file.name}`)
              }
            }
          }
          if (pending.length === 0) return
          if (Date.now() > deadline) {
            throw new Error(`previews still pending: ${pending.join(', ')}`)
          }
          await sleep(300)
        }
      },
      stop,
    }
    return server
  } catch (error) {
    await stop()
    throw error
  }
}

export type SeedFile = { name: string; bytes: Uint8Array }
export type SeedProject = {
  name: string
  tags?: string[]
  website?: string
  notes?: string
  archived?: boolean
  files?: SeedFile[]
  /** After seeding, remove the project's folder from disk and rescan, so it reads as missing. */
  missing?: boolean
}

const stl = (name: string, mesh: Mesh): SeedFile => ({ name, bytes: binaryStl(mesh) })

/** The default library: enough variety to see tags, archived, missing, STEP and every file kind. */
export const DEFAULT_PLAN: readonly SeedProject[] = [
  {
    name: 'Benchy',
    tags: ['boats', 'calibration'],
    website: 'https://www.printables.com/model/3161-3d-benchy',
    notes:
      'The classic torture test.\nPrinted at 0.2 mm with PETG; the chimney is the tricky part.',
    files: [
      stl('benchy.stl', cylinder(10, 28)),
      { name: 'benchy-sliced.3mf', bytes: threeMf(cube(18)) },
      { name: 'print-notes.txt', bytes: new TextEncoder().encode('0.2 mm, 20% gyroid\n') },
    ],
  },
  {
    name: 'Calibration Cube',
    tags: ['calibration'],
    files: [stl('cube.stl', cube(20)), { name: 'cube.obj', bytes: obj(cube(20)) }],
  },
  {
    name: 'Phone Stand',
    tags: ['gadgets', 'desk'],
    files: [{ name: 'stand.3mf', bytes: threeMf(pyramid(30, 40)) }],
  },
  { name: 'Cable Clip', tags: ['gadgets'], files: [stl('clip.stl', cube(8))] },
  {
    name: 'Filament Spool Holder with a Rather Long Name That Has to Be Cut Off',
    tags: ['printer-parts', 'gadgets', 'desk', 'storage', 'long-term'],
    files: [stl('holder.stl', cylinder(14, 12)), stl('holder-v2.stl', cylinder(16, 12))],
  },
  {
    name: 'Retired Bracket',
    tags: ['printer-parts'],
    archived: true,
    files: [stl('bracket.stl', pyramid(20, 10))],
  },
  {
    name: 'Hinge',
    tags: ['mechanical'],
    files: [{ name: 'hinge.step', bytes: stepStub() }, stl('hinge-pin.stl', cylinder(3, 20))],
  },
  { name: 'Empty Project' },
  { name: 'Lost Folder', tags: ['gadgets'], files: [stl('lost.stl', cube(10))], missing: true },
]

export type SeededProject = { id: string; name: string; fileIds: Record<string, string> }

/**
 * Creates the projects of `plan` through the API (so 3MF stripping and classification run exactly
 * as for a user), uploads their files, and waits for the thumbnails. Returns each project by name.
 */
export async function seedLibrary(
  server: SeededServer,
  plan: readonly SeedProject[] = DEFAULT_PLAN,
): Promise<Record<string, SeededProject>> {
  const seeded: Record<string, SeededProject> = {}
  let needsRescan = false
  for (const entry of plan) {
    const created = await server.request<{ id: string }>('POST', '/api/projects', {
      name: entry.name,
      ...(entry.website ? { website: entry.website } : {}),
      ...(entry.notes ? { notes: entry.notes } : {}),
      ...(entry.tags?.length ? { tags: entry.tags } : {}),
    })
    const fileIds: Record<string, string> = {}
    for (const file of entry.files ?? []) {
      fileIds[file.name] = (await server.upload(created.id, file.name, file.bytes)).id
    }
    if (entry.archived) {
      await server.request('PATCH', `/api/projects/${created.id}`, { isArchived: true })
    }
    if (entry.missing) {
      rmSync(join(server.libraryDir, server.username, entry.name), { recursive: true, force: true })
      needsRescan = true
    }
    seeded[entry.name] = { id: created.id, name: entry.name, fileIds }
  }
  if (needsRescan) await server.request('POST', '/api/projects/rescan')
  await server.waitForPreviews()
  return seeded
}

/**
 * Many small projects, for paging (more than one page of 48): `Bulk 001`, `Bulk 002`, ... Created
 * with no files, so it takes a second, not a minute.
 */
export async function seedBulkProjects(server: SeededServer, count: number): Promise<string[]> {
  const ids: string[] = []
  for (let index = 1; index <= count; index++) {
    const created = await server.request<{ id: string }>('POST', '/api/projects', {
      name: `Bulk ${String(index).padStart(3, '0')}`,
      tags: index % 5 === 0 ? ['bulk', 'fifth'] : ['bulk'],
    })
    ids.push(created.id)
  }
  return ids
}

/** Signs a Playwright browser context in as the seeded admin without spending a login attempt. */
export async function applySession(context: BrowserContext, server: SeededServer): Promise<void> {
  await context.addCookies([
    { name: server.session.name, value: server.session.value, url: server.origin },
  ])
}
