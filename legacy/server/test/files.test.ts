import assert from 'node:assert/strict'
import { rmSync, writeFileSync } from 'node:fs'
import { EMBEDDED_HANDLER, MESH_HANDLER, runPreviewQueue } from '@spm/core'
import { loginAsAdmin, withServer, type TestServer } from './harness.ts'
import { curaProject } from '../../core/test/fixtures/make-3mf.ts'
import { binaryStl, cubeMesh } from '../../core/test/fixtures/make-mesh.ts'
import { makePng } from '../../core/test/fixtures/make-png.ts'
import { readPngSize } from '../../core/src/previews/png.ts'
import { join } from 'node:path'

async function newProject(server: TestServer, cookie: string, name = 'Benchy') {
  return (
    await server.fetch('/api/projects', {
      method: 'POST',
      cookie,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name }),
    })
  ).json()
}

function upload(
  server: TestServer,
  cookie: string,
  projectId: string,
  name: string,
  content: string,
  headers: Record<string, string> = {},
): Promise<Response> {
  const bytes = new TextEncoder().encode(content)
  return server.fetch(`/api/projects/${projectId}/files`, {
    method: 'POST',
    cookie,
    headers: {
      'x-spm-file-name': encodeURIComponent(name),
      'content-length': String(bytes.byteLength),
      ...headers,
    },
    body: bytes,
  })
}

Deno.test('upload indexes the file and returns a decorated DTO', async () => {
  await withServer(async (server) => {
    const cookie = await loginAsAdmin(server)
    const project = await newProject(server, cookie)

    const response = await upload(server, cookie, project.id, 'benchy.stl', 'solid benchy')
    assert.equal(response.status, 200)
    const file = await response.json()
    assert.equal(file.name, 'benchy.stl')
    assert.equal(file.kind, 'model')
    assert.equal(file.previewState, 'pending')
    assert.equal(file.rawUrl, `/api/files/${file.id}/raw`)
    assert.equal(file.thumbUrl, undefined)
  })
})

Deno.test('upload without a name header or length is refused', async () => {
  await withServer(async (server) => {
    const cookie = await loginAsAdmin(server)
    const project = await newProject(server, cookie)

    const noName = await server.fetch(`/api/projects/${project.id}/files`, {
      method: 'POST',
      cookie,
      headers: { 'content-length': '5' },
      body: new TextEncoder().encode('solid'),
    })
    assert.equal(noName.status, 400)

    const noLength = await server.fetch(`/api/projects/${project.id}/files`, {
      method: 'POST',
      cookie,
      headers: { 'x-spm-file-name': 'a.stl' },
      body: new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('solid'))
          controller.close()
        },
      }),
    })
    assert.equal(noLength.status, 411)
  })
})

Deno.test('a traversal attempt in the name header is refused', async () => {
  await withServer(async (server) => {
    const cookie = await loginAsAdmin(server)
    const project = await newProject(server, cookie)
    const response = await upload(server, cookie, project.id, '../escape.stl', 'solid')
    assert.equal(response.status, 400)
  })
})

Deno.test('a malformed percent-escape in the name header is a 400, not a 500', async () => {
  await withServer(async (server) => {
    const cookie = await loginAsAdmin(server)
    const project = await newProject(server, cookie)
    const bytes = new TextEncoder().encode('solid')
    const response = await server.fetch(`/api/projects/${project.id}/files`, {
      method: 'POST',
      cookie,
      headers: { 'x-spm-file-name': '%', 'content-length': String(bytes.byteLength) },
      body: bytes,
    })
    assert.equal(response.status, 400)
  })
})

Deno.test('exceeding the quota is a 413 carrying the numbers', async () => {
  await withServer(async (server) => {
    const cookie = await loginAsAdmin(server)
    const me = await (await server.fetch('/api/account', { cookie })).json()
    await server.fetch(`/api/users/${me.id}`, {
      method: 'PATCH',
      cookie,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ quotaBytes: 10 }),
    })
    const project = await newProject(server, cookie)

    const response = await upload(server, cookie, project.id, 'big.stl', 'x'.repeat(50))
    assert.equal(response.status, 413)
    const body = await response.json()
    assert.equal(body.error.code, 'QuotaExceeded')
    assert.deepEqual(body.error.details, { usageBytes: 0, quotaBytes: 10, incomingBytes: 50 })
  })
})

Deno.test('raw streams the bytes with a real content type', async () => {
  await withServer(async (server) => {
    const cookie = await loginAsAdmin(server)
    const project = await newProject(server, cookie)
    const file = await (
      await upload(server, cookie, project.id, 'benchy.stl', 'solid benchy')
    ).json()

    const response = await server.fetch(file.rawUrl, { cookie })
    assert.equal(response.status, 200)
    assert.equal(response.headers.get('content-type'), 'model/stl')
    assert.equal(response.headers.get('content-length'), '12')
    assert.equal(await response.text(), 'solid benchy')
  })
})

Deno.test('thumb is a 404 while pending and a png once ready', async () => {
  await withServer(async (server) => {
    const cookie = await loginAsAdmin(server)
    const project = await newProject(server, cookie)
    // Write a real Cura project into the project folder, then let the queue extract it.
    curaProject(join(server.dir, 'admin', 'Benchy', 'benchy.3mf'), makePng(300, 300))
    await server.fetch('/api/projects/rescan', { method: 'POST', cookie })

    const detail = await (await server.fetch(`/api/projects/${project.id}`, { cookie })).json()
    const pending = detail.files.find((f: { name: string }) => f.name === 'benchy.3mf')
    assert.equal(pending.previewState, 'pending')
    assert.equal((await server.fetch(`/api/files/${pending.id}/thumb`, { cookie })).status, 404)

    await runPreviewQueue(server.lib)
    const ready = (
      await (await server.fetch(`/api/projects/${project.id}`, { cookie })).json()
    ).files.find((f: { name: string }) => f.name === 'benchy.3mf')
    assert.equal(ready.previewState, 'ready')
    assert.equal(ready.thumbUrl, `/api/files/${ready.id}/thumb`)

    const thumb = await server.fetch(ready.thumbUrl, { cookie })
    assert.equal(thumb.status, 200)
    assert.equal(thumb.headers.get('content-type'), 'image/png')
  })
})

// The wiring main.ts does, end to end through the API: an STL carries no thumbnail of its own,
// so the only thing that can put one behind this route is MESH_HANDLER actually rendering it.
Deno.test('thumb serves the rasterized png for a plain stl model', async () => {
  await withServer(async (server) => {
    const cookie = await loginAsAdmin(server)
    const project = await newProject(server, cookie)
    writeFileSync(join(server.dir, 'admin', 'Benchy', 'cube.stl'), binaryStl(cubeMesh()))
    await server.fetch('/api/projects/rescan', { method: 'POST', cookie })

    await runPreviewQueue(server.lib, { handlers: [EMBEDDED_HANDLER, MESH_HANDLER] })
    const ready = (
      await (await server.fetch(`/api/projects/${project.id}`, { cookie })).json()
    ).files.find((f: { name: string }) => f.name === 'cube.stl')
    assert.equal(ready.previewState, 'ready')

    const thumb = await server.fetch(ready.thumbUrl, { cookie })
    assert.equal(thumb.status, 200)
    assert.equal(thumb.headers.get('content-type'), 'image/png')
    // The bytes the client receives, not just the row: a 256px png is what was rendered.
    const bytes = new Uint8Array(await thumb.arrayBuffer())
    assert.deepEqual(readPngSize(bytes), { width: 256, height: 256 })
  })
})

Deno.test('rename and delete work through the api', async () => {
  await withServer(async (server) => {
    const cookie = await loginAsAdmin(server)
    const project = await newProject(server, cookie)
    const file = await (await upload(server, cookie, project.id, 'a.stl', 'solid')).json()

    const renamed = await server.fetch(`/api/files/${file.id}`, {
      method: 'PATCH',
      cookie,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'b.stl' }),
    })
    assert.equal((await renamed.json()).name, 'b.stl')

    assert.equal(
      (await server.fetch(`/api/files/${file.id}`, { method: 'DELETE', cookie })).status,
      204,
    )
    assert.equal((await server.fetch(`/api/files/${file.id}/raw`, { cookie })).status, 404)
  })
})

// Ruling 34: a file row can outlive its bytes (rescan marks a file `missing` without deleting
// the row, and the bytes can vanish underneath the server at any time). Streaming its raw bytes
// must map that to a 404, not let Deno.errors.NotFound fall through as an unhandled 500.
Deno.test('raw is a 404, not a 500, when the bytes are gone from disk', async () => {
  await withServer(async (server) => {
    const cookie = await loginAsAdmin(server)
    const project = await newProject(server, cookie)
    const file = await (await upload(server, cookie, project.id, 'gone.stl', 'solid')).json()

    rmSync(join(server.dir, 'admin', 'Benchy', 'gone.stl'), { force: true })

    const response = await server.fetch(file.rawUrl, { cookie })
    assert.equal(response.status, 404)
  })
})
