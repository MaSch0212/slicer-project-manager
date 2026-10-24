import assert from 'node:assert/strict'
import { loginAsAdmin, withServer } from './harness.ts'

Deno.test('capabilities is public and describes the server build', async () => {
  await withServer(async (server) => {
    const response = await server.fetch('/api/capabilities')
    assert.equal(response.status, 200)
    assert.deepEqual(await response.json(), {
      requiresAuth: true,
      canManageUsers: true,
      canPickLocalFolder: false,
      canLaunchSlicer: false,
      canConfigureSlicers: false,
      canBrowseModelSites: false,
    })
  })
})

Deno.test('an unknown api route is a 404 with the error envelope', async () => {
  await withServer(async (server) => {
    const response = await server.fetch('/api/nope')
    assert.equal(response.status, 404)
    const body = await response.json()
    assert.equal(body.error.code, 'NotFound')
  })
})

Deno.test('a session route without a cookie is a 401', async () => {
  await withServer(async (server) => {
    const response = await server.fetch('/api/account')
    assert.equal(response.status, 401)
    assert.equal((await response.json()).error.code, 'Unauthorized')
  })
})

Deno.test('a malformed percent-escape in the session cookie is a 401, not a 500', async () => {
  await withServer(async (server) => {
    const response = await server.fetch('/api/account', { cookie: 'spm_session=%' })
    assert.equal(response.status, 401)
    assert.equal((await response.json()).error.code, 'Unauthorized')
  })
})

Deno.test('the activation token can be checked before a password is typed', async () => {
  await withServer(async (server) => {
    const ok = await server.fetch(`/api/auth/activation/${server.bootstrapToken}`)
    assert.deepEqual(await ok.json(), { valid: true, username: 'admin' })

    const bad = await server.fetch('/api/auth/activation/not-a-real-token')
    assert.equal(bad.status, 200)
    assert.deepEqual(await bad.json(), { valid: false })
  })
})

Deno.test('activation sets an HttpOnly session cookie and returns the user', async () => {
  await withServer(async (server) => {
    const response = await server.fetch(`/api/auth/activation/${server.bootstrapToken}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ password: 'a good long password', confirm: 'a good long password' }),
    })
    assert.equal(response.status, 200)
    const cookie = response.headers.get('set-cookie')!
    assert.match(cookie, /^spm_session=/)
    assert.match(cookie, /HttpOnly/)
    assert.match(cookie, /SameSite=Lax/)
    // No Secure flag over http://localhost, or a dev browser would drop the cookie.
    assert.doesNotMatch(cookie, /Secure/)

    const user = await response.json()
    assert.equal(user.username, 'admin')
    assert.equal(user.status, 'active')
    assert.equal(user.isAdmin, true)
  })
})

Deno.test('a validation failure reports the offending field', async () => {
  await withServer(async (server) => {
    const response = await server.fetch(`/api/auth/activation/${server.bootstrapToken}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ password: 'short', confirm: 'short' }),
    })
    assert.equal(response.status, 400)
    const body = await response.json()
    assert.equal(body.error.code, 'Validation')
    assert.ok(Array.isArray(body.error.details.issues))
  })
})

Deno.test('login works after activation and rejects a wrong password', async () => {
  await withServer(async (server) => {
    await loginAsAdmin(server)

    const ok = await server.fetch('/api/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'admin', password: 'a good long password' }),
    })
    assert.equal(ok.status, 200)
    assert.ok(ok.headers.get('set-cookie'))

    const bad = await server.fetch('/api/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'admin', password: 'wrong password' }),
    })
    assert.equal(bad.status, 401)
  })
})

Deno.test('a session cookie authenticates and logout revokes it', async () => {
  await withServer(async (server) => {
    const cookie = await loginAsAdmin(server)

    const me = await server.fetch('/api/account', { cookie })
    assert.equal(me.status, 200)
    assert.equal((await me.json()).username, 'admin')

    const out = await server.fetch('/api/auth/logout', { method: 'POST', cookie })
    assert.equal(out.status, 204)
    assert.match(out.headers.get('set-cookie')!, /Max-Age=0/)

    const after = await server.fetch('/api/account', { cookie })
    assert.equal(after.status, 401)
  })
})

Deno.test('a wrong method on a known path is a 405', async () => {
  await withServer(async (server) => {
    const response = await server.fetch('/api/capabilities', { method: 'DELETE' })
    assert.equal(response.status, 405)
  })
})
