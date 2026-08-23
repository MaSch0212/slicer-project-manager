import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  closeLibrary,
  createLogger,
  ensureBootstrapAdmin,
  openLibrary,
  type Library,
  type LogRecord,
} from '@spm/core'
import { makeHandler } from '../src/router.ts'
import { routes } from '../src/routes/index.ts'

/** A manually-advanced clock, so the rate-limit window-expiry test can move time forward
 *  without sleeping for a real minute. */
export type TestClock = {
  advance: (ms: number) => void
}

export type TestServer = {
  lib: Library
  dir: string
  fetch: (path: string, init?: RequestInit & { cookie?: string; ip?: string }) => Promise<Response>
  bootstrapToken: string
  limiter: TestClock
  /** Everything the server logged, at trace. Empty unless the test asked for logging. */
  logs: LogRecord[]
}

export async function withServer(
  run: (server: TestServer) => Promise<void>,
  opts: { logging?: boolean } = {},
): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'spm-server-'))
  const logs: LogRecord[] = []
  // Off by default: every other test in this suite would otherwise pay to build records
  // nothing reads, and a stray console write would drown the runner output.
  const logger = opts.logging
    ? createLogger({ level: 'trace', sink: (record) => logs.push(record) })
    : undefined
  const lib = openLibrary(dir, { logger })
  const boot = await ensureBootstrapAdmin(lib)

  let now = Date.now()
  const clock: TestClock = { advance: (ms) => (now += ms) }
  const handler = makeHandler(routes, { lib, now: () => now })

  const fetchFn: TestServer['fetch'] = (path, init = {}) => {
    const { cookie, ip, ...rest } = init
    const headers = new Headers(rest.headers)
    if (cookie) headers.set('cookie', cookie)
    // The user agent adds content-length from the body when a request actually crosses the
    // network; constructing a Request in-process does not, so a route that requires the
    // header (uploads, the archive import) would see every test as a 411 while real browser
    // traffic is fine. An explicit header always wins, so a test can still assert on a
    // deliberately wrong one.
    if (rest.body instanceof Blob && !headers.has('content-length')) {
      headers.set('content-length', String(rest.body.size))
    }
    const info: Deno.ServeHandlerInfo = {
      remoteAddr: { transport: 'tcp', hostname: ip ?? '127.0.0.1', port: 0 },
      // Real Deno.serve resolves this once the response finishes; nothing here awaits it.
      completed: Promise.resolve(),
    }
    return handler(new Request(`http://localhost${path}`, { ...rest, headers }), info)
  }

  try {
    await run({ lib, dir, fetch: fetchFn, bootstrapToken: boot!.token, limiter: clock, logs })
  } finally {
    closeLibrary(lib)
    rmSync(dir, { recursive: true, force: true })
  }
}

/** Activates the bootstrap admin and returns a usable session cookie header. */
export async function loginAsAdmin(server: TestServer): Promise<string> {
  const response = await server.fetch(`/api/auth/activation/${server.bootstrapToken}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ password: 'a good long password', confirm: 'a good long password' }),
  })
  if (!response.ok) throw new Error(`activation failed: ${response.status}`)
  const setCookie = response.headers.get('set-cookie')!
  return setCookie.split(';')[0]!
}
