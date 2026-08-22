import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { closeLibrary, ensureBootstrapAdmin, openLibrary, type Library } from '@spm/core'
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
}

export async function withServer(run: (server: TestServer) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'spm-server-'))
  const lib = openLibrary(dir)
  const boot = await ensureBootstrapAdmin(lib)

  let now = Date.now()
  const clock: TestClock = { advance: (ms) => (now += ms) }
  const handler = makeHandler(routes, { lib, now: () => now })

  const fetchFn: TestServer['fetch'] = (path, init = {}) => {
    const { cookie, ip, ...rest } = init
    const headers = new Headers(rest.headers)
    if (cookie) headers.set('cookie', cookie)
    const info: Deno.ServeHandlerInfo = {
      remoteAddr: { transport: 'tcp', hostname: ip ?? '127.0.0.1', port: 0 },
      // Real Deno.serve resolves this once the response finishes; nothing here awaits it.
      completed: Promise.resolve(),
    }
    return handler(new Request(`http://localhost${path}`, { ...rest, headers }), info)
  }

  try {
    await run({ lib, dir, fetch: fetchFn, bootstrapToken: boot!.token, limiter: clock })
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
