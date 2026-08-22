import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { closeLibrary, ensureBootstrapAdmin, openLibrary, type Library } from '@spm/core'
import { makeHandler } from '../src/router.ts'
import { routes } from '../src/routes/index.ts'

export type TestServer = {
  lib: Library
  dir: string
  fetch: (path: string, init?: RequestInit & { cookie?: string }) => Promise<Response>
  bootstrapToken: string
}

export async function withServer(run: (server: TestServer) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'spm-server-'))
  const lib = openLibrary(dir)
  const boot = await ensureBootstrapAdmin(lib)
  const handler = makeHandler(routes, { lib })

  const fetchFn: TestServer['fetch'] = (path, init = {}) => {
    const headers = new Headers(init.headers)
    if (init.cookie) headers.set('cookie', init.cookie)
    return handler(new Request(`http://localhost${path}`, { ...init, headers }))
  }

  try {
    await run({ lib, dir, fetch: fetchFn, bootstrapToken: boot!.token })
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
