import assert from 'node:assert/strict'
import { createLogger, NOOP_LOGGER, type LogRecord } from '@spm/core'
import { bridgeSockets, makeDevProxy, resolveDevUiOrigin } from '../src/dev-proxy.ts'

const ORIGIN = 'http://localhost:4200'

type Call = { url: string; init: RequestInit }

function proxyWith(
  respond: (call: Call) => Promise<Response>,
  log = NOOP_LOGGER,
): { proxy: ReturnType<typeof makeDevProxy>; calls: Call[] } {
  const calls: Call[] = []
  const proxy = makeDevProxy(ORIGIN, {
    fetch: (input, init) => {
      const call = { url: String(input), init: init ?? {} }
      calls.push(call)
      return respond(call)
    },
    upgrade: () => {
      throw new Error('not a websocket test')
    },
    openUpstream: () => {
      throw new Error('not a websocket test')
    },
    log,
  })
  return { proxy, calls }
}

Deno.test('resolveDevUiOrigin accepts an http(s) URL and reduces it to a bare origin', () => {
  assert.equal(resolveDevUiOrigin('http://localhost:4200/some/path'), 'http://localhost:4200')
  assert.equal(resolveDevUiOrigin('https://ui.example.com'), 'https://ui.example.com')
})

Deno.test('resolveDevUiOrigin is off when unset, and refuses anything unusable', () => {
  assert.equal(resolveDevUiOrigin(undefined), null)
  assert.equal(resolveDevUiOrigin(''), null)
  // A typo must fail at startup rather than 502 on the first page load.
  assert.throws(() => resolveDevUiOrigin('localhost:4200'))
  assert.throws(() => resolveDevUiOrigin('ftp://localhost:4200'))
})

Deno.test('a request is forwarded to the dev server with its path, query and method', async () => {
  const { proxy, calls } = proxyWith(() => Promise.resolve(new Response('ok', { status: 200 })))
  const url = new URL('http://localhost:8000/main.js?v=2')
  const response = await proxy(new Request(url, { method: 'GET' }), url)

  assert.equal(response.status, 200)
  assert.equal(calls.length, 1)
  assert.equal(calls[0]!.url, 'http://localhost:4200/main.js?v=2')
  assert.equal(calls[0]!.init.method, 'GET')
})

Deno.test('hop-by-hop headers are stripped in both directions', async () => {
  const { proxy, calls } = proxyWith(() =>
    Promise.resolve(
      new Response('ok', {
        headers: {
          'content-type': 'text/javascript',
          connection: 'keep-alive',
          'transfer-encoding': 'chunked',
        },
      }),
    ),
  )
  const url = new URL('http://localhost:8000/main.js')
  const response = await proxy(
    new Request(url, {
      headers: { accept: 'text/javascript', connection: 'keep-alive', host: 'localhost:8000' },
    }),
    url,
  )

  const sent = new Headers(calls[0]!.init.headers)
  // `connection` makes Deno's fetch reject the request outright, and a forwarded `host`
  // would point the dev server at the proxy's own origin.
  assert.equal(sent.get('connection'), null)
  assert.equal(sent.get('host'), null)
  assert.equal(sent.get('accept'), 'text/javascript')

  assert.equal(response.headers.get('connection'), null)
  assert.equal(response.headers.get('transfer-encoding'), null)
  assert.equal(response.headers.get('content-type'), 'text/javascript')
})

Deno.test('an unreachable dev server answers 502 saying how to start it', async () => {
  const records: LogRecord[] = []
  const log = createLogger({ level: 'trace', sink: (record) => records.push(record) })
  const { proxy } = proxyWith(() => Promise.reject(new Error('ECONNREFUSED')), log)
  const url = new URL('http://localhost:8000/')

  const response = await proxy(new Request(url), url)
  const body = await response.text()

  assert.equal(response.status, 502)
  // The fix is a second terminal, not a code change, so the response has to say so.
  assert.ok(body.includes('deno task dev:ui'), body)
  assert.ok(body.includes(ORIGIN), body)
  assert.equal(records.find((r) => r.message.includes('could not reach'))?.level, 'warn')
})

Deno.test('a websocket upgrade echoes the requested subprotocol to both sides', async () => {
  let echoed: string | undefined = 'unset'
  let upstreamUrl = ''
  let upstreamProtocols: string[] = []
  const proxy = makeDevProxy(ORIGIN, {
    fetch: () => Promise.reject(new Error('should not fetch for an upgrade')),
    upgrade: (_req, protocol) => {
      echoed = protocol
      return { socket: fakeSocket(), response: new Response(null, { status: 101 }) }
    },
    openUpstream: (url, protocols) => {
      upstreamUrl = url
      upstreamProtocols = protocols
      return fakeSocket()
    },
    log: NOOP_LOGGER,
  })

  const url = new URL('http://localhost:8000/?token=abc')
  const response = await proxy(
    new Request(url, {
      headers: { upgrade: 'websocket', 'sec-websocket-protocol': 'vite-hmr' },
    }),
    url,
  )

  assert.equal(response.status, 101)
  // Omitting it from the 101 makes the browser fail the connection even though the
  // handshake looked fine server-side; omitting it upstream makes vite ignore the request.
  assert.equal(echoed, 'vite-hmr')
  assert.deepEqual(upstreamProtocols, ['vite-hmr'])
  assert.equal(upstreamUrl, 'ws://localhost:4200/?token=abc')
})

type FakeSocket = WebSocket & { sent: unknown[]; readyState: number }

function fakeSocket(readyState = WebSocket.OPEN): FakeSocket {
  const socket = {
    readyState,
    sent: [] as unknown[],
    send(data: unknown) {
      this.sent.push(data)
    },
    close() {
      this.readyState = WebSocket.CLOSED
    },
    onmessage: null,
    onopen: null,
    onclose: null,
    onerror: null,
  }
  return socket as unknown as FakeSocket
}

Deno.test('messages sent before the upstream opens are queued, then flushed in order', () => {
  const client = fakeSocket()
  const upstream = fakeSocket(WebSocket.CONNECTING)
  bridgeSockets(client, upstream)

  // Vite's HMR client talks immediately; sending on a CONNECTING socket would throw.
  client.onmessage?.({ data: 'first' } as MessageEvent)
  client.onmessage?.({ data: 'second' } as MessageEvent)
  assert.deepEqual(upstream.sent, [])

  upstream.readyState = WebSocket.OPEN
  upstream.onopen?.(new Event('open'))
  assert.deepEqual(upstream.sent, ['first', 'second'])

  // And after opening, traffic passes straight through in both directions.
  client.onmessage?.({ data: 'third' } as MessageEvent)
  assert.deepEqual(upstream.sent, ['first', 'second', 'third'])
  upstream.onmessage?.({ data: 'reply' } as MessageEvent)
  assert.deepEqual(client.sent, ['reply'])
})

Deno.test('either side closing tears down the other', () => {
  const client = fakeSocket()
  const upstream = fakeSocket()
  bridgeSockets(client, upstream)

  client.onclose?.(new CloseEvent('close'))
  assert.equal(upstream.readyState, WebSocket.CLOSED)

  const client2 = fakeSocket()
  const upstream2 = fakeSocket()
  bridgeSockets(client2, upstream2)
  // A dev-server restart must not leave the browser holding a socket that will never speak.
  upstream2.onclose?.(new CloseEvent('close'))
  assert.equal(client2.readyState, WebSocket.CLOSED)
})
