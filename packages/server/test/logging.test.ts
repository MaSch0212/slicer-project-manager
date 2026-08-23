import assert from 'node:assert/strict'
import type { LogRecord } from '@spm/core'
import { errorResponse } from '../src/errors.ts'
import { createLogger } from '@spm/core'
import { makeHandler } from '../src/router.ts'
import { loginAsAdmin, withServer } from './harness.ts'

function requests(logs: LogRecord[]): LogRecord[] {
  return logs.filter(
    (record) => record.message === 'request' || record.message === 'request failed',
  )
}

Deno.test(
  'every API request is logged once at info with method, path, status and duration',
  async () => {
    await withServer(
      async (server) => {
        server.logs.length = 0
        const response = await server.fetch('/api/capabilities')
        assert.equal(response.status, 200)

        const logged = requests(server.logs)
        assert.equal(logged.length, 1, 'expected exactly one request line')
        const record = logged[0]!
        assert.equal(record.level, 'info')
        assert.equal(record.message, 'request')
        assert.equal(record.fields.method, 'GET')
        assert.equal(record.fields.path, '/api/capabilities')
        assert.equal(record.fields.status, 200)
        assert.equal(typeof record.fields.ms, 'number')
        // Anonymous: the field is omitted rather than logged as an empty string.
        assert.ok(!('userId' in record.fields), 'an anonymous request carried a userId')
      },
      { logging: true },
    )
  },
)

Deno.test('an authenticated request carries the resolved userId', async () => {
  await withServer(
    async (server) => {
      const cookie = await loginAsAdmin(server)
      server.logs.length = 0
      const response = await server.fetch('/api/projects', { cookie })
      assert.equal(response.status, 200)

      const record = requests(server.logs)[0]!
      assert.equal(record.fields.path, '/api/projects')
      assert.equal(typeof record.fields.userId, 'string')
      assert.ok((record.fields.userId as string).length > 0)
    },
    { logging: true },
  )
})

Deno.test('a 4xx is still info; it is routine, not a server fault', async () => {
  await withServer(
    async (server) => {
      server.logs.length = 0
      const response = await server.fetch('/api/projects')
      assert.equal(response.status, 401)

      const record = requests(server.logs)[0]!
      assert.equal(record.level, 'info')
      assert.equal(record.fields.status, 401)
    },
    { logging: true },
  )
})

Deno.test(
  'static requests log at debug so a page load does not flood the default level',
  async () => {
    await withServer(
      async (server) => {
        server.logs.length = 0
        await server.fetch('/some/asset.js')

        const record = server.logs.find((entry) => entry.message === 'static')
        assert.equal(record?.level, 'debug')
        assert.equal(record?.fields.path, '/some/asset.js')
        // And nothing at info, which is the whole point of putting it a level down.
        assert.deepEqual(
          server.logs.filter((entry) => entry.level === 'info'),
          [],
        )
      },
      { logging: true },
    )
  },
)

Deno.test('logging stays off unless the harness asks for it', async () => {
  await withServer(async (server) => {
    await server.fetch('/api/capabilities')
    assert.deepEqual(server.logs, [])
  })
})

Deno.test(
  'errorResponse logs an unexpected throw at error, with its stack, and leaks neither',
  async () => {
    const records: LogRecord[] = []
    const log = createLogger({ level: 'trace', sink: (record) => records.push(record) })
    const response = errorResponse(new Error('a secret internal detail'), log)

    assert.equal(response.status, 500)
    const body = await response.text()
    assert.ok(!body.includes('a secret internal detail'), 'the internal message reached the client')
    assert.ok(!body.includes('errorResponse'), 'a stack frame reached the client')

    const record = records.find((entry) => entry.message === 'unhandled error')
    assert.equal(record?.level, 'error')
    assert.ok(String(record?.fields.err).includes('a secret internal detail'))
    assert.ok(String(record?.fields.stack).includes('logging.test.ts'), 'no usable stack was kept')
  },
)

Deno.test('a 5xx request line is logged at error, not info', async () => {
  await withServer(
    async (server) => {
      // A route that throws a non-AppError is the only way to reach a 500; none of the real
      // routes can be made to do it on demand, so this builds a handler with one that does.
      const records: LogRecord[] = []
      const log = createLogger({ level: 'trace', sink: (record) => records.push(record) })
      const handler = makeHandler(
        [
          {
            method: 'GET',
            path: '/api/boom',
            auth: 'public',
            handler: () => {
              throw new Error('kaboom')
            },
          },
        ],
        { lib: server.lib, log },
      )

      const response = await handler(new Request('http://localhost/api/boom'))
      assert.equal(response.status, 500)

      const line = records.find((entry) => entry.message === 'request failed')
      assert.ok(line, 'a 500 was logged as an ordinary request')
      assert.equal(line.level, 'error')
      assert.equal(line.fields.status, 500)
      assert.equal(line.fields.path, '/api/boom')
      // And the throw itself is logged separately, so the stack is not lost.
      assert.equal(records.find((entry) => entry.message === 'unhandled error')?.level, 'error')
    },
    { logging: true },
  )
})
