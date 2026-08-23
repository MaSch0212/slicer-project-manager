import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { MAX_ARCHIVE_BYTES } from '../src/routes/import.ts'
import { loginAsAdmin, withServer } from './harness.ts'

/**
 * The smallest real zip that carries one project folder.
 *
 * Hand-built rather than pulled from core's test fixtures: those are Node-only helpers, and
 * this suite runs under Deno. Two stored (uncompressed) entries, a central directory and an
 * end-of-central-directory record — the exact shape `readZipEntries` parses.
 */
function makeZip(files: { name: string; body: string }[]): Blob {
  const encoder = new TextEncoder()
  const parts: Uint8Array[] = []
  const central: Uint8Array[] = []
  let offset = 0

  const u32 = (view: DataView, at: number, value: number) => view.setUint32(at, value, true)
  const u16 = (view: DataView, at: number, value: number) => view.setUint16(at, value, true)

  // CRC-32, because a zip reader is entitled to check it.
  const table = Array.from({ length: 256 }, (_, i) => {
    let c = i
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    return c >>> 0
  })
  const crc32 = (bytes: Uint8Array) => {
    let c = 0xffffffff
    for (const byte of bytes) c = table[(c ^ byte) & 0xff]! ^ (c >>> 8)
    return (c ^ 0xffffffff) >>> 0
  }

  for (const file of files) {
    const name = encoder.encode(file.name)
    const data = encoder.encode(file.body)
    const crc = crc32(data)

    const local = new Uint8Array(30 + name.length)
    const lv = new DataView(local.buffer)
    u32(lv, 0, 0x04034b50)
    u16(lv, 4, 20)
    u16(lv, 8, 0) // stored
    u32(lv, 14, crc)
    u32(lv, 18, data.length)
    u32(lv, 22, data.length)
    u16(lv, 26, name.length)
    local.set(name, 30)
    parts.push(local, data)

    const cd = new Uint8Array(46 + name.length)
    const cv = new DataView(cd.buffer)
    u32(cv, 0, 0x02014b50)
    u16(cv, 4, 20)
    u16(cv, 6, 20)
    u16(cv, 10, 0)
    u32(cv, 16, crc)
    u32(cv, 20, data.length)
    u32(cv, 24, data.length)
    u16(cv, 28, name.length)
    u32(cv, 42, offset)
    cd.set(name, 46)
    central.push(cd)

    offset += local.length + data.length
  }

  const cdBytes = concat(central)
  const eocd = new Uint8Array(22)
  const ev = new DataView(eocd.buffer)
  u32(ev, 0, 0x06054b50)
  u16(ev, 8, files.length)
  u16(ev, 10, files.length)
  u32(ev, 12, cdBytes.length)
  u32(ev, 16, offset)

  // A Blob rather than raw bytes: it is what a browser actually sends (a File is a Blob),
  // and fetch derives content-length from it, which the route requires. `.buffer` is copied
  // out because BodyInit rejects a Uint8Array over a possibly-shared buffer.
  const bytes = concat([...parts, cdBytes, eocd])
  return new Blob([bytes.slice().buffer as ArrayBuffer], { type: 'application/zip' })
}

function concat(chunks: Uint8Array[]): Uint8Array {
  const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0)
  const out = new Uint8Array(total)
  let at = 0
  for (const chunk of chunks) {
    out.set(chunk, at)
    at += chunk.length
  }
  return out
}

const ARCHIVE = makeZip([
  { name: 'MyLibrary/Widget A/part.stl', body: 'solid a' },
  { name: 'MyLibrary/Widget A/metadata.json', body: '{"Tags":["toys"],"IsArchived":true}' },
  { name: 'MyLibrary/Bracket/model.3mf', body: 'x' },
])

Deno.test('an uploaded archive is imported and reported back', async () => {
  await withServer(async (server) => {
    const cookie = await loginAsAdmin(server)

    const response = await server.fetch('/api/import/curamanager', {
      method: 'POST',
      cookie,
      headers: { 'content-type': 'application/zip' },
      body: ARCHIVE,
    })

    assert.equal(response.status, 200)
    const body = await response.json()
    assert.equal(body.projectsExtracted, 2)
    assert.equal(body.filesExtracted, 3)
    assert.equal(body.strippedRoot, 'MyLibrary')
    assert.equal(body.rescan.adopted, 2)
    assert.equal(body.tagsApplied, 1)

    // The projects are really on disk, under the admin's own library folder.
    assert.ok(existsSync(join(server.dir, 'admin', 'Widget A', 'part.stl')))
    assert.ok(existsSync(join(server.dir, 'admin', 'Bracket', 'model.3mf')))
  })
})

Deno.test('the staged upload is deleted whether the import succeeds or fails', async () => {
  await withServer(async (server) => {
    const cookie = await loginAsAdmin(server)
    const uploads = join(server.dir, '.spm', 'uploads')

    await server.fetch('/api/import/curamanager', { method: 'POST', cookie, body: ARCHIVE })
    // A multi-gigabyte copy left inside the user's own library would silently eat their quota.
    assert.deepEqual(
      [...Deno.readDirSync(uploads)].map((entry) => entry.name),
      [],
    )

    // The same must hold on the failure path — this one collides with the import above.
    const conflict = await server.fetch('/api/import/curamanager', {
      method: 'POST',
      cookie,
      body: ARCHIVE,
    })
    assert.equal(conflict.status, 409)
    assert.deepEqual(
      [...Deno.readDirSync(uploads)].map((entry) => entry.name),
      [],
    )
  })
})

Deno.test('a collision is a 409 naming the folders, and changes nothing', async () => {
  await withServer(async (server) => {
    const cookie = await loginAsAdmin(server)
    await server.fetch('/api/import/curamanager', { method: 'POST', cookie, body: ARCHIVE })

    const response = await server.fetch('/api/import/curamanager', {
      method: 'POST',
      cookie,
      body: ARCHIVE,
    })
    assert.equal(response.status, 409)
    const body = await response.json()
    assert.equal(body.error.code, 'Conflict')
    assert.ok(body.error.message.includes('Widget A'), body.error.message)
  })
})

Deno.test('the import endpoint requires a session', async () => {
  await withServer(async (server) => {
    const response = await server.fetch('/api/import/curamanager', {
      method: 'POST',
      body: ARCHIVE,
    })
    assert.equal(response.status, 401)
  })
})

Deno.test('an upload with no length is a 411 rather than an unbounded write', async () => {
  await withServer(async (server) => {
    const cookie = await loginAsAdmin(server)
    // A streamed body carries no content-length, which is exactly the case the precheck
    // exists for: nothing should be written to disk before the size is known.
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        void ARCHIVE.arrayBuffer().then((buffer) => {
          controller.enqueue(new Uint8Array(buffer))
          controller.close()
        })
      },
    })
    const response = await server.fetch('/api/import/curamanager', {
      method: 'POST',
      cookie,
      body: stream,
      // @ts-expect-error duplex is required by fetch for a stream body and is not in the DOM lib
      duplex: 'half',
    })
    assert.equal(response.status, 411)
  })
})

Deno.test('an archive larger than the cap is refused before a byte is staged', async () => {
  await withServer(async (server) => {
    const cookie = await loginAsAdmin(server)
    const response = await server.fetch('/api/import/curamanager', {
      method: 'POST',
      cookie,
      // The header alone decides this; no body of that size is ever produced.
      headers: { 'content-length': String(MAX_ARCHIVE_BYTES + 1) },
      body: ARCHIVE,
    })
    assert.equal(response.status, 413)
    assert.ok(!existsSync(join(server.dir, '.spm', 'uploads')))
  })
})

Deno.test('an archive with nothing importable in it is a 400 that explains why', async () => {
  await withServer(async (server) => {
    const cookie = await loginAsAdmin(server)
    const response = await server.fetch('/api/import/curamanager', {
      method: 'POST',
      cookie,
      body: makeZip([{ name: 'loose.txt', body: 'hello' }]),
    })
    assert.equal(response.status, 400)
    const body = await response.json()
    assert.ok(body.error.message.includes('no project folders'), body.error.message)
  })
})
