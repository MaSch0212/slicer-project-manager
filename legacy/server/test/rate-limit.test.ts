import assert from 'node:assert/strict'
import { EVICTION_BATCH, MAX_TRACKED_KEYS, makeRateLimiter } from '../src/rate-limit.ts'
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

Deno.test(
  'exhausting the login budget for an ip leaves the activation route reachable for it',
  async () => {
    await withServer(async (server) => {
      for (let attempt = 0; attempt < 11; attempt++) await login(server, '10.0.0.7')
      assert.equal((await login(server, '10.0.0.7')).status, 429)
      // Same IP, but a different route pattern, so it must be a different budget. The
      // limiter key visibly includes method+path today; nothing exercised a regression that
      // collapsed both routes onto one shared bucket keyed on IP alone.
      const activation = await server.fetch(
        '/api/auth/activation/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        {
          method: 'POST',
          ip: '10.0.0.7',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            password: 'a good long password',
            confirm: 'a good long password',
          }),
        },
      )
      assert.notEqual(activation.status, 429)
    })
  },
)

Deno.test('the tracked-key count stays bounded under a flood of distinct keys', () => {
  // Unit-level: exercises makeRateLimiter directly rather than through the HTTP harness,
  // since driving 3x the cap through real login/activation handlers would be far slower
  // (and would pay real PBKDF2 costs). `size()` on RateLimiter is test-facing observability
  // added for exactly this purpose — see rate-limit.ts.
  let clock = 0
  const limiter = makeRateLimiter(() => clock)
  const rule = { limit: 10, windowMs: 60_000 }

  // Roughly 3x the cap, all inside a single window (nothing here is prunable by the
  // sweep), simulating an attacker rotating source addresses.
  const n = (MAX_TRACKED_KEYS + EVICTION_BATCH) * 3
  for (let i = 0; i < n; i++) {
    clock += 1
    limiter.check(`10.0.0.${i}|POST /api/auth/login`, rule)
  }

  // Under the old (pre-fix) strategy this would equal n: a size-gated sweep never deletes
  // a bucket that's still inside its own window, so a flood of never-repeated keys grew the
  // map without bound. The hysteresis eviction here bounds it at MAX_TRACKED_KEYS +
  // EVICTION_BATCH rather than exactly MAX_TRACKED_KEYS — see rate-limit.ts's comment on
  // EVICTION_BATCH for why a strict per-insert cap was rejected (it reintroduces the same
  // non-linear slowdown via Map churn that this whole fix exists to close).
  assert.ok(
    limiter.size() <= MAX_TRACKED_KEYS + EVICTION_BATCH,
    `expected size() <= ${MAX_TRACKED_KEYS + EVICTION_BATCH}, got ${limiter.size()}`,
  )
})
