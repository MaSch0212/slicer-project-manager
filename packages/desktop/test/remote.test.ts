import assert from 'node:assert/strict'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { after, before, test } from 'node:test'
import { AppError } from '@spm/contract/errors.ts'
import { REMOTE_SHELL_CAPABILITIES } from '../src/capabilities.ts'
import { API_PATH_PREFIX, UPLOAD_LENGTH_HEADER } from '../src/protocol.ts'
import {
  isPlaintextToAnotherMachine,
  isRedirect,
  parseRemoteOrigin,
  RemoteHost,
} from '../src/remote.ts'
import { RENDERER_ORIGIN } from '../src/urls.ts'

/**
 * The reverse proxy that *is* remote mode, driven against a real HTTP server on a real socket.
 *
 * A real server and not a stub `fetch`, because most of what is worth asserting here is what
 * reaches the wire: the cookie the shell replays, the `content-length` it reconstructs, the
 * headers it refuses to forward. A stub would only prove that this file agrees with itself.
 *
 * The server is deliberately *not* the Deno one — that is `test/remote.spec.ts`'s job, through a
 * real window. This one echoes what it received, which is the only way to assert a negative.
 */

type Received = {
  url: string
  method: string
  headers: Record<string, string | undefined>
  body: string
}

let server: Server
let origin: string
/** Requests the redirect target received. It must stay at zero. */
let elsewhereHits = 0
const received: Received[] = []
/** What the next request will be answered with, so one server can play every case. */
let reply: (request: Received, response: ServerResponse) => void

before(async () => {
  server = createServer((request: IncomingMessage, response: ServerResponse) => {
    const chunks: Buffer[] = []
    request.on('data', (chunk: Buffer) => chunks.push(chunk))
    request.on('end', () => {
      const entry: Received = {
        url: request.url ?? '',
        method: request.method ?? '',
        headers: request.headers as Record<string, string | undefined>,
        body: Buffer.concat(chunks).toString('utf8'),
      }
      received.push(entry)
      reply(entry, response)
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  assert.ok(address && typeof address === 'object')
  origin = `http://127.0.0.1:${address.port}`
})

after(() => server.close())

function json(response: ServerResponse, status: number, body: unknown, cookie?: string): void {
  const headers: Record<string, string> = { 'content-type': 'application/json' }
  if (cookie) headers['set-cookie'] = cookie
  response.writeHead(status, headers)
  response.end(JSON.stringify(body))
}

/** The renderer's request, as the protocol handler receives it: an `spm://app/api/...` URL. */
function ask(path: string, init?: RequestInit): Request {
  return new Request(`${RENDERER_ORIGIN}${API_PATH_PREFIX}${path}`, init)
}

function host(): RemoteHost {
  received.length = 0
  reply = (request, response) => json(response, 200, { echo: request.url })
  return new RemoteHost(origin)
}

/* -------------------------------------------------------------------------------------------
 * The URL the renderer supplies is untrusted input
 * ---------------------------------------------------------------------------------------- */

test('a server URL is reduced to an origin, or refused with a reason', () => {
  assert.equal(parseRemoteOrigin('https://print.example.com'), 'https://print.example.com')
  assert.equal(parseRemoteOrigin('  http://localhost:8000/  '), 'http://localhost:8000')
  assert.equal(parseRemoteOrigin('https://print.example.com:443'), 'https://print.example.com')

  const refused: [unknown, RegExp][] = [
    ['', /required/],
    ['   ', /required/],
    [null, /required/],
    [42, /required/],
    ['print.example.com', /not a URL/],
    ['file:///C:/Windows', /http or https/],
    ['data:text/html,<script>', /http or https/],
    ['javascript:alert(1)', /http or https/],
    ['spm://app', /http or https/],
    ['https://user:pw@example.com', /username or a password/],
    ['https://example.com?a=1', /query string or a fragment/],
    ['https://example.com#f', /query string or a fragment/],
    ['https://example.com/api', /not a path/],
  ]
  for (const [raw, message] of refused) {
    assert.throws(
      () => parseRemoteOrigin(raw),
      (error: unknown) =>
        error instanceof AppError && error.code === 'Validation' && message.test(error.message),
      `must refuse ${String(raw)}`,
    )
  }
})

test('plain http to another machine is warned about, and to this one is not', () => {
  assert.equal(isPlaintextToAnotherMachine('http://192.168.1.5:8000'), true)
  assert.equal(isPlaintextToAnotherMachine('http://print.example.com'), true)
  assert.equal(isPlaintextToAnotherMachine('https://print.example.com'), false)
  assert.equal(isPlaintextToAnotherMachine('http://localhost:8000'), false)
  assert.equal(isPlaintextToAnotherMachine('http://127.0.0.1:8000'), false)
})

/* -------------------------------------------------------------------------------------------
 * What crosses, in each direction
 * ---------------------------------------------------------------------------------------- */

test('a request reaches the server with its method, path, query and body', async () => {
  const remote = host()
  const response = await remote.proxy(
    ask('/projects?search=brack', {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: '{"name":"n"}',
    }),
  )

  assert.equal(response.status, 200)
  assert.equal(received.length, 1)
  assert.deepEqual(
    {
      url: received[0]!.url,
      method: received[0]!.method,
      type: received[0]!.headers['content-type'],
      body: received[0]!.body,
    },
    {
      url: '/api/projects?search=brack',
      method: 'POST',
      type: 'application/json',
      body: '{"name":"n"}',
    },
  )
})

test('only the three allowed request headers are forwarded', async () => {
  const remote = host()
  await remote.proxy(
    ask('/projects/p/files', {
      method: 'POST',
      headers: {
        'content-type': 'application/octet-stream',
        accept: '*/*',
        'x-spm-file-name': 'part%20one.stl',
        // Not on the allow-list. Chromium strips `cookie` from a renderer `fetch` before this is
        // ever reached (measured), which is exactly why the allow-list is here rather than a
        // `cookie` delete: the rule must not depend on Chromium's list.
        'x-forwarded-for': '10.0.0.1',
        authorization: 'Bearer stolen',
      },
      body: 'bytes',
    }),
  )
  const headers = received[0]!.headers
  assert.equal(headers['content-type'], 'application/octet-stream')
  assert.equal(headers['x-spm-file-name'], 'part%20one.stl')
  assert.equal(headers['x-forwarded-for'], undefined)
  assert.equal(headers['authorization'], undefined)
})

test('a status and body the server answers with come back unchanged', async () => {
  const remote = host()
  reply = (_request, response) =>
    json(response, 401, { error: { code: 'Unauthorized', message: 'sign in' } })

  const response = await remote.proxy(ask('/account'))

  assert.equal(response.status, 401)
  // The envelope matters, not just the status: it is what `HttpApiClient.toError` rebuilds an
  // `AppError` with the right `code` from (constraint 5).
  assert.deepEqual(await response.json(), { error: { code: 'Unauthorized', message: 'sign in' } })
})

test('a server that cannot be reached is a 502 carrying the app error envelope', async () => {
  // A port nothing is listening on, so the failure is a real connection refusal.
  const remote = new RemoteHost('http://127.0.0.1:1')
  const response = await remote.proxy(ask('/capabilities'))

  assert.equal(response.status, 502)
  const body = (await response.json()) as { error: { code: string; message: string } }
  assert.equal(body.error.code, 'Internal')
  // Naming the server is the point: `request failed with status 502` tells a user nothing about
  // which machine is not answering.
  assert.match(body.error.message, /could not reach http:\/\/127\.0\.0\.1:1/)
})

test('nothing outside /api can be asked for through the proxy', async () => {
  const remote = host()
  for (const url of [
    `${RENDERER_ORIGIN}/index.html`,
    `${RENDERER_ORIGIN}/apifoo`,
    `${RENDERER_ORIGIN}/api`,
  ]) {
    const response = await remote.proxy(new Request(url))
    assert.equal(response.status, 404, url)
  }
  assert.equal(received.length, 0, 'and no request left the machine')
})

test('a method HttpApiClient never uses is refused before anything leaves', async () => {
  const remote = host()
  const response = await remote.proxy(ask('/projects', { method: 'OPTIONS' }))
  assert.equal(response.status, 405)
  assert.equal(received.length, 0)
})

/**
 * The confinement the whole design rests on, and the one hop that used to escape it.
 *
 * `remote.ts` says every response the renderer sees comes from the configured origin on a path
 * under `/api`. Chromium's canonicalisation and the prefix check cover the request; **redirects
 * covered nothing at all** until review found it. Measured with undici's default (`follow`),
 * against a configured server answering `302 Location:
 * http://127.0.0.1:<other>/_cluster/health`:
 *
 * ```
 * redirect=(default) -> status 200 | response.url http://127.0.0.1:50924/_cluster/health
 *                     | location null | body "{\"secret\":\"internal service body\", ...}"
 * redirect=manual    -> status 302 | response.url http://127.0.0.1:50925/api/projects
 *                     | location "http://127.0.0.1:50924/_cluster/health" | body ""
 * ```
 *
 * So the default handed the renderer another host's body, on another path, with a success status
 * and the redirect invisible — a general read primitive wearing the configured server's identity.
 * These tests use a second HTTP server as the redirect target, and assert it was never asked for
 * anything: that is the assertion `redirect: 'manual'` exists to keep true.
 */
test('a redirect is refused, named, and never followed', async () => {
  const elsewhere = createServer((_request, response) => {
    elsewhereHits += 1
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end(JSON.stringify({ secret: 'internal service body' }))
  })
  await new Promise<void>((done) => elsewhere.listen(0, '127.0.0.1', done))
  const address = elsewhere.address()
  assert.ok(address && typeof address === 'object')
  const target = `http://127.0.0.1:${address.port}/_cluster/health`

  try {
    for (const status of [301, 302, 303, 307, 308]) {
      elsewhereHits = 0
      const remote = host()
      reply = (_request, response) => {
        response.writeHead(status, { location: target })
        response.end()
      }

      const response = await remote.proxy(ask('/projects'))

      assert.equal(response.status, 502, String(status))
      const body = (await response.json()) as { error: { code: string; message: string } }
      assert.equal(body.error.code, 'Internal', String(status))
      // Named, because the one legitimate way to meet this is a proxy sending http to https, and
      // then the fix is for the user to type the address the message quotes.
      assert.match(body.error.message, /redirected to http:\/\/127\.0\.0\.1/, String(status))
      assert.equal(elsewhereHits, 0, `nothing was fetched from the redirect target (${status})`)
      // Nor is the redirect handed to the renderer to follow: its own `fetch` follows them, so a
      // forwarded `Location` would be the same escape one layer out, stopped only by a CSP this
      // module does not own. Asserted here rather than in a test of its own — the sibling this
      // replaces pointed at `example.invalid`, where undici fails DNS and `#send`'s catch returns
      // a 502 with no `location` whether or not the option is in force, so it could not fail.
      assert.equal(response.headers.get('location'), null, String(status))
    }
  } finally {
    elsewhere.close()
  }
})

/**
 * 304 shares the 3xx band and is not a redirect: it carries no `Location`, and refusing it would
 * turn an ordinary conditional response into a confusing 502.
 *
 * Nothing in this repo sends `If-None-Match` today — grepped, not assumed — so this guards a
 * future conditional GET rather than a live bug. `isRedirect` is asserted directly as well,
 * because the band is easier to get wrong in one place than to notice in another.
 */
test('a 304 is passed through, because it is not a redirect', async () => {
  const remote = host()
  reply = (_request, response) => {
    response.writeHead(304)
    response.end()
  }
  const response = await remote.proxy(ask('/projects'))
  assert.equal(response.status, 304)

  for (const status of [300, 301, 302, 303, 307, 308])
    assert.equal(isRedirect(status), true, String(status))
  for (const status of [200, 204, 304, 400, 404, 500])
    assert.equal(isRedirect(status), false, String(status))
})

/* -------------------------------------------------------------------------------------------
 * The session
 * ---------------------------------------------------------------------------------------- */

test('the session is carried by the shell, replayed on later requests, and never handed back', async () => {
  const remote = host()
  assert.equal(remote.hasSession(), false)

  reply = (_request, response) =>
    json(
      response,
      200,
      { id: 'u1' },
      'spm_session=TOKEN; Path=/; HttpOnly; SameSite=Lax; Max-Age=3600',
    )
  const login = await remote.proxy(ask('/auth/login', { method: 'POST', body: '{}' }))

  // The renderer must never see the token: it has no use for one (the shell attaches it) and a
  // renderer that could read it could exfiltrate it — the property `HttpOnly` gives a browser tab.
  assert.equal(login.headers.get('set-cookie'), null)
  assert.equal(remote.hasSession(), true)

  reply = (_request, response) => json(response, 200, [])
  await remote.proxy(ask('/projects'))
  assert.equal(received[1]!.headers['cookie'], 'spm_session=TOKEN')
})

test('a logout clears the session, by either of the two spellings the server uses', async () => {
  for (const clearing of [
    'spm_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0',
    'spm_session=; Path=/',
    'spm_session=x; Max-Age=0',
  ]) {
    const remote = host()
    reply = (_request, response) => json(response, 200, {}, 'spm_session=TOKEN; Max-Age=3600')
    await remote.proxy(ask('/auth/login', { method: 'POST', body: '{}' }))
    assert.equal(remote.hasSession(), true, clearing)

    reply = (_request, response) => json(response, 200, {}, clearing)
    await remote.proxy(ask('/auth/logout', { method: 'POST' }))
    assert.equal(remote.hasSession(), false, clearing)

    reply = (_request, response) => json(response, 200, [])
    await remote.proxy(ask('/projects'))
    assert.equal(received.at(-1)!.headers['cookie'], undefined, clearing)
  }
})

/**
 * The restart behaviour, decided rather than inherited — see the note on `RemoteHost`.
 *
 * There is nothing to assert about a *file*, because there is no file: the whole of the session
 * is the map inside this object, and a new process has a new one. What is assertable is that
 * closing the host — which is what a mode change and `will-quit` both do — really drops it, and
 * that a fresh host over the same origin starts with nothing.
 */
test('the session dies with the host, and a new one starts logged out', async () => {
  const remote = host()
  reply = (_request, response) => json(response, 200, {}, 'spm_session=TOKEN; Max-Age=3600')
  await remote.proxy(ask('/auth/login', { method: 'POST', body: '{}' }))
  assert.equal(remote.hasSession(), true)

  remote.close()
  assert.equal(remote.hasSession(), false)

  const relaunched = new RemoteHost(origin)
  assert.equal(relaunched.hasSession(), false)
  reply = (_request, response) => json(response, 200, [])
  await relaunched.proxy(ask('/projects'))
  assert.equal(received.at(-1)!.headers['cookie'], undefined)
})

/**
 * Closing a host cancels what it still has on the wire, not just what it might send next.
 *
 * `#closed` only ever stopped the *next* call. A request issued a moment before a mode switch was
 * still out there, and its response would have been handed to a renderer that is about to be
 * replaced. It is also the only bound this proxy puts on a server that accepts a request and
 * never answers — the reason this test's server deliberately never answers.
 */
test('closing a host cancels the request it still has in flight', async () => {
  const remote = host()
  let release = (): void => {}
  reply = (_request, response) => {
    // Accepted and never answered, until this test says so.
    release = (): void => {
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end('{}')
    }
  }

  const inFlight = remote.proxy(ask('/projects'))
  // The request has to have left before closing means anything.
  await new Promise((settle) => setTimeout(settle, 50))
  assert.equal(received.length, 1, 'the server really did receive it')

  remote.close()
  const response = await inFlight

  // It comes back as the app's own envelope rather than hanging or throwing an `AbortError` at
  // the protocol handler, which would reach the renderer as a bare `Failed to fetch`.
  assert.equal(response.status, 502)
  const body = (await response.json()) as { error: { code: string } }
  assert.equal(body.error.code, 'Internal')
  release()
})

test('a closed host refuses rather than reaching the server it has been let go of', async () => {
  const remote = host()
  remote.close()
  const response = await remote.proxy(ask('/projects'))
  assert.equal(response.status, 503)
  assert.equal(received.length, 0)
})

/* -------------------------------------------------------------------------------------------
 * Uploads, and the length Chromium takes away
 * ---------------------------------------------------------------------------------------- */

test('a declared upload length becomes a real content-length upstream', async () => {
  const remote = host()
  const body = 'x'.repeat(64)
  await remote.proxy(
    ask('/projects/p/files', {
      method: 'POST',
      headers: { [UPLOAD_LENGTH_HEADER]: String(body.length), 'x-spm-file-name': 'a.stl' },
      body,
    }),
  )
  // Without this the server refuses the upload with 411 before it writes a byte (spec 5.6),
  // because Chromium strips `content-length` from a renderer fetch and does not put the body's
  // length on the Request the protocol handler sees.
  assert.equal(received[0]!.headers['content-length'], '64')
  assert.equal(received[0]!.headers['transfer-encoding'], undefined)
  assert.equal(received[0]!.body.length, 64)
  // The shell's own header does not travel on: the server knows nothing about it.
  assert.equal(received[0]!.headers[UPLOAD_LENGTH_HEADER], undefined)
})

test('a body with no declared length is streamed, and the server sees no length', async () => {
  const remote = host()
  await remote.proxy(ask('/projects/p/files', { method: 'POST', body: 'x'.repeat(64) }))
  assert.equal(received[0]!.headers['content-length'], undefined)
  assert.equal(received[0]!.headers['transfer-encoding'], 'chunked')
})

test('a declared length that is not a plain integer is ignored, not forwarded', async () => {
  // `' 64 '` is deliberately not in this list. Measured: `Headers` trims a header value, so it
  // arrives as `64` and is a perfectly good length — there is no spelling of "64 with spaces"
  // for this to refuse, and asserting one would be asserting a rule that does not exist.
  for (const bad of ['-1', '1.5', '1e3', '0x40', 'abc', '', '+1']) {
    const remote = host()
    await remote.proxy(
      ask('/projects/p/files', {
        method: 'POST',
        headers: { [UPLOAD_LENGTH_HEADER]: bad },
        body: 'x',
      }),
    )
    assert.equal(received.length, 1, bad)
    assert.equal(received[0]!.headers['content-length'], undefined, bad)
  }
})

/**
 * The renderer is the only party that can lie about this, and only about its own upload.
 *
 * Measured rather than argued: undici refuses to send a body whose length disagrees with the
 * `content-length` it was given, so a wrong number is a failed upload and never a truncated file
 * on the server. The shell does not re-count the bytes, and this is why it does not have to.
 */
test('a declared length that disagrees with the body fails the request, not the server', async () => {
  const remote = host()
  const response = await remote.proxy(
    ask('/projects/p/files', {
      method: 'POST',
      headers: { [UPLOAD_LENGTH_HEADER]: '999' },
      body: 'x'.repeat(8),
    }),
  )
  assert.equal(response.status, 502)
  assert.equal(received.length, 0, 'nothing reached the server')
})

/* -------------------------------------------------------------------------------------------
 * The union, on the way past
 * ---------------------------------------------------------------------------------------- */

test('capabilities come back as the union of the shell column and the server one', async () => {
  const remote = host()
  reply = (_request, response) =>
    json(response, 200, {
      requiresAuth: true,
      canManageUsers: true,
      canPickLocalFolder: false,
      canLaunchSlicer: false,
      canConfigureSlicers: false,
      canBrowseModelSites: false,
    })

  const throughProxy = await remote.proxy(ask('/capabilities'))
  const direct = await remote.capabilities()

  const expected = {
    requiresAuth: true,
    canManageUsers: true,
    canPickLocalFolder: false,
    canLaunchSlicer: false,
    canConfigureSlicers: false,
    canBrowseModelSites: false,
  }
  assert.deepEqual(await throughProxy.json(), expected)
  // The IPC route and the proxied HTTP route must not be able to disagree.
  assert.deepEqual(direct, expected)
})

test('a shell flag the server does not have survives the union', async () => {
  const remote = host()
  reply = (_request, response) =>
    json(response, 200, { ...REMOTE_SHELL_CAPABILITIES, requiresAuth: true, canManageUsers: true })

  const merged = (await (await remote.proxy(ask('/capabilities'))).json()) as Record<
    string,
    unknown
  >
  // Today all three shell-owned flags are false in both columns, so what this pins is the pair
  // the backend owns; `capabilities.test.ts` drives the columns spec D will produce.
  assert.equal(merged['requiresAuth'], true)
  assert.equal(merged['canManageUsers'], true)
  assert.equal(merged['canPickLocalFolder'], false)
})

test('a capabilities answer that is not one is passed through rather than unioned', async () => {
  const remote = host()
  reply = (_request, response) => json(response, 200, { hello: 'i am a proxy error page' })
  const response = await remote.proxy(ask('/capabilities'))
  assert.deepEqual(await response.json(), { hello: 'i am a proxy error page' })

  await assert.rejects(
    () => remote.capabilities(),
    (error: unknown) => error instanceof AppError && error.code === 'Internal',
  )
})

test('only a 200 GET on the capabilities path is unioned', async () => {
  const remote = host()
  reply = (_request, response) => json(response, 500, { requiresAuth: false })
  assert.deepEqual(await (await remote.proxy(ask('/capabilities'))).json(), { requiresAuth: false })

  reply = (_request, response) => json(response, 200, { requiresAuth: false })
  const posted = await remote.proxy(ask('/capabilities', { method: 'POST', body: '{}' }))
  assert.deepEqual(await posted.json(), { requiresAuth: false })
})
