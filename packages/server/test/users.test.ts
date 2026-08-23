import assert from 'node:assert/strict'
import { activationUrl, normalizePublicOrigin } from '../src/routes/users.ts'
import { loginAsAdmin, withServer, type TestServer } from './harness.ts'

async function createUser(
  server: TestServer,
  cookie: string,
  body: Record<string, unknown>,
): Promise<Response> {
  return server.fetch('/api/users', {
    method: 'POST',
    cookie,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}

/** Activates a freshly created user from their activation URL and returns their cookie. */
async function activate(server: TestServer, activationUrl: string): Promise<string> {
  const token = activationUrl.split('#')[1]!
  const response = await server.fetch(`/api/auth/activation/${token}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ password: 'another long password', confirm: 'another long password' }),
  })
  assert.equal(response.status, 200)
  return response.headers.get('set-cookie')!.split(';')[0]!
}

Deno.test(
  'creating a user returns an activation url carrying the token in the fragment',
  async () => {
    await withServer(async (server) => {
      const cookie = await loginAsAdmin(server)
      const response = await createUser(server, cookie, { username: 'anna', displayName: 'Anna' })
      assert.equal(response.status, 200)

      const body = await response.json()
      assert.equal(body.user.username, 'anna')
      assert.equal(body.user.status, 'pending')
      assert.match(body.activationUrl, /^http:\/\/localhost\/activate#[A-Za-z0-9_-]{43}$/)
      // A query string would land in access logs and Referer headers (spec 5.3).
      assert.doesNotMatch(body.activationUrl, /\?/)
    })
  },
)

Deno.test('a non-admin is refused every users route', async () => {
  await withServer(async (server) => {
    const adminCookie = await loginAsAdmin(server)
    const created = await (
      await createUser(server, adminCookie, { username: 'anna', displayName: 'Anna' })
    ).json()
    const annaCookie = await activate(server, created.activationUrl)

    assert.equal((await server.fetch('/api/users', { cookie: annaCookie })).status, 403)
    assert.equal(
      (await createUser(server, annaCookie, { username: 'xx', displayName: 'X' })).status,
      403,
    )
    assert.equal(
      (
        await server.fetch(`/api/users/${created.user.id}`, {
          method: 'DELETE',
          cookie: annaCookie,
        })
      ).status,
      403,
    )
  })
})

Deno.test('an invite can be re-issued and the quota updated', async () => {
  await withServer(async (server) => {
    const cookie = await loginAsAdmin(server)
    const created = await (
      await createUser(server, cookie, { username: 'anna', displayName: 'Anna' })
    ).json()

    const reissued = await server.fetch(`/api/users/${created.user.id}/invite`, {
      method: 'POST',
      cookie,
    })
    assert.equal(reissued.status, 200)
    assert.notEqual((await reissued.json()).activationUrl, created.activationUrl)

    const patched = await server.fetch(`/api/users/${created.user.id}`, {
      method: 'PATCH',
      cookie,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ quotaBytes: 1_000_000 }),
    })
    assert.equal((await patched.json()).quotaBytes, 1_000_000)
  })
})

Deno.test('removing the last active admin is a 409', async () => {
  await withServer(async (server) => {
    const cookie = await loginAsAdmin(server)
    const me = await (await server.fetch('/api/account', { cookie })).json()

    const response = await server.fetch(`/api/users/${me.id}`, { method: 'DELETE', cookie })
    assert.equal(response.status, 409)
    assert.equal((await response.json()).error.code, 'LastActiveAdmin')
  })
})

Deno.test('account patch and password change work on the caller', async () => {
  await withServer(async (server) => {
    const cookie = await loginAsAdmin(server)

    const patched = await server.fetch('/api/account', {
      method: 'PATCH',
      cookie,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ displayName: 'Marc S' }),
    })
    assert.equal((await patched.json()).displayName, 'Marc S')

    const changed = await server.fetch('/api/account/password', {
      method: 'POST',
      cookie,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ current: 'a good long password', next: 'an even longer password' }),
    })
    assert.equal(changed.status, 204)

    const relogin = await server.fetch('/api/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'admin', password: 'an even longer password' }),
    })
    assert.equal(relogin.status, 200)
  })
})

Deno.test('settings round-trip through the api', async () => {
  await withServer(async (server) => {
    const cookie = await loginAsAdmin(server)

    const defaults = await (await server.fetch('/api/account/settings', { cookie })).json()
    assert.equal(defaults.language, 'en')
    assert.equal(defaults.theme, 'system')

    const put = await server.fetch('/api/account/settings', {
      method: 'PUT',
      cookie,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ language: 'de', viewMode: 'list' }),
    })
    const saved = await put.json()
    assert.equal(saved.language, 'de')
    assert.equal(saved.viewMode, 'list')
    assert.equal(
      (await (await server.fetch('/api/account/settings', { cookie })).json()).language,
      'de',
    )
  })
})

Deno.test('an unknown setting key is rejected rather than stored', async () => {
  await withServer(async (server) => {
    const cookie = await loginAsAdmin(server)
    const response = await server.fetch('/api/account/settings', {
      method: 'PUT',
      cookie,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ language: 'klingon' }),
    })
    assert.equal(response.status, 400)
  })
})

// Final review, minor 6: activation links were built from `url.origin`, and Deno derives the
// scheme from its own listener. Behind a TLS-terminating proxy that is plain `http://`, so
// the link the admin hands over is `http://…` — which, being insecure, also drops the
// `Secure` session cookie set on activation: the user activates but is not signed in.
// X-Forwarded-Proto is deliberately NOT trusted (client-settable, exactly why the rate
// limiter keys on the TCP peer address only), so this is an explicit opt-in instead.
Deno.test('activation links use SPM_PUBLIC_ORIGIN when it is configured', () => {
  const url = new URL('http://10.0.0.4:8000/api/users')

  assert.equal(activationUrl(url, 'tok'), 'http://10.0.0.4:8000/activate#tok')
  assert.equal(
    activationUrl(url, 'tok', 'https://print.example.com'),
    'https://print.example.com/activate#tok',
  )
})

Deno.test('a configured public origin is normalised down to a bare origin', () => {
  // A trailing slash or a stray path would otherwise produce '…//activate#tok'.
  assert.equal(normalizePublicOrigin('https://print.example.com/'), 'https://print.example.com')
  assert.equal(
    normalizePublicOrigin('https://print.example.com/spm?x=1#y'),
    'https://print.example.com',
  )
  assert.equal(
    normalizePublicOrigin('https://print.example.com:8443'),
    'https://print.example.com:8443',
  )
})

Deno.test('a public origin that is not an http(s) URL is refused, not silently ignored', () => {
  // Loud at startup beats quietly emitting http:// links nobody notices until activation
  // fails.
  assert.throws(() => normalizePublicOrigin('print.example.com'), /SPM_PUBLIC_ORIGIN/)
  assert.throws(() => normalizePublicOrigin('ftp://print.example.com'), /SPM_PUBLIC_ORIGIN/)
  assert.throws(() => normalizePublicOrigin('not a url at all'), /SPM_PUBLIC_ORIGIN/)
})
