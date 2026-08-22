import assert from 'node:assert/strict'
import { loginAsAdmin, withServer } from './harness.ts'

const badLogin = { username: 'admin', password: 'the wrong password entirely' }

function login(
  server: { fetch: (p: string, i?: RequestInit & { ip?: string }) => Promise<Response> },
  ip: string,
) {
  return server.fetch('/api/auth/login', {
    method: 'POST',
    ip,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(badLogin),
  })
}

Deno.test('login is rate limited per ip and reports when to retry', async () => {
  await withServer(async (server) => {
    // The rule is 10 per 60s, so the first ten are refused on the merits (401).
    for (let attempt = 0; attempt < 10; attempt++) {
      assert.equal((await login(server, '10.0.0.1')).status, 401)
    }
    const limited = await login(server, '10.0.0.1')
    assert.equal(limited.status, 429)
    assert.equal((await limited.json()).error.code, 'TooManyRequests')
    // A client needs to know how long to wait, not just that it was refused.
    assert.match(limited.headers.get('retry-after')!, /^\d+$/)
  })
})

Deno.test('one ip hitting the limit does not lock out another', async () => {
  await withServer(async (server) => {
    for (let attempt = 0; attempt < 11; attempt++) await login(server, '10.0.0.1')
    assert.equal((await login(server, '10.0.0.1')).status, 429)
    // A shared-limiter bug would show up here and nowhere else.
    assert.equal((await login(server, '10.0.0.2')).status, 401)
  })
})

Deno.test(
  'the limiter counts attempts, not successes, and a good password still gets in',
  async () => {
    await withServer(async (server) => {
      // The bootstrap admin starts 'pending' with no password at all, so a "good password"
      // login can only succeed once the account is activated (see harness.ts loginAsAdmin,
      // which sets it to 'a good long password').
      await loginAsAdmin(server)
      for (let attempt = 0; attempt < 9; attempt++) await login(server, '10.0.0.3')
      const ok = await server.fetch('/api/auth/login', {
        method: 'POST',
        ip: '10.0.0.3',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ username: 'admin', password: 'a good long password' }),
      })
      assert.equal(ok.status, 200)
    })
  },
)

Deno.test('an unlimited route is not affected by an exhausted auth budget', async () => {
  await withServer(async (server) => {
    for (let attempt = 0; attempt < 11; attempt++) await login(server, '10.0.0.4')
    // capabilities carries no rateLimit rule, so it must stay reachable.
    assert.equal((await server.fetch('/api/capabilities', { ip: '10.0.0.4' })).status, 200)
  })
})

Deno.test('the window expires so a locked-out client recovers', async () => {
  await withServer(async (server) => {
    for (let attempt = 0; attempt < 11; attempt++) await login(server, '10.0.0.5')
    assert.equal((await login(server, '10.0.0.5')).status, 429)
    // Advance past the window without sleeping for a real minute.
    server.limiter.advance(61_000)
    assert.equal((await login(server, '10.0.0.5')).status, 401)
  })
})

Deno.test('activation is rate limited too, since it also takes a token guess', async () => {
  await withServer(async (server) => {
    const attempt = () =>
      server.fetch('/api/auth/activation/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', {
        method: 'POST',
        ip: '10.0.0.6',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ password: 'a good long password', confirm: 'a good long password' }),
      })
    for (let i = 0; i < 10; i++) await attempt()
    assert.equal((await attempt()).status, 429)
  })
})
