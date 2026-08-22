import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { loginAsAdmin, withServer } from './harness.ts'

Deno.test('projects require a session', async () => {
  await withServer(async (server) => {
    assert.equal((await server.fetch('/api/projects')).status, 401)
  })
})

Deno.test('a project can be created, listed, fetched, patched and deleted', async () => {
  await withServer(async (server) => {
    const cookie = await loginAsAdmin(server)

    const created = await server.fetch('/api/projects', {
      method: 'POST',
      cookie,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Benchy', tags: ['boat'], website: 'https://a.example' }),
    })
    assert.equal(created.status, 200)
    const project = await created.json()
    assert.deepEqual(project.tags, ['boat'])

    const list = await (await server.fetch('/api/projects', { cookie })).json()
    assert.deepEqual(
      list.map((p: { id: string }) => p.id),
      [project.id],
    )

    const detail = await (await server.fetch(`/api/projects/${project.id}`, { cookie })).json()
    assert.deepEqual(detail.files, [])

    const patched = await server.fetch(`/api/projects/${project.id}`, {
      method: 'PATCH',
      cookie,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ isArchived: true }),
    })
    assert.equal((await patched.json()).isArchived, true)

    const deleted = await server.fetch(`/api/projects/${project.id}?deleteFiles=true`, {
      method: 'DELETE',
      cookie,
    })
    assert.equal(deleted.status, 204)
    assert.deepEqual(await (await server.fetch('/api/projects', { cookie })).json(), [])
  })
})

Deno.test('query parameters map onto the project query', async () => {
  await withServer(async (server) => {
    const cookie = await loginAsAdmin(server)
    const post = (body: unknown) =>
      server.fetch('/api/projects', {
        method: 'POST',
        cookie,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      })
    await post({ name: 'Benchy', tags: ['boat', 'petg'] })
    await post({ name: 'Bracket', tags: ['petg'] })
    const archived = await (await post({ name: 'Old' })).json()
    await server.fetch(`/api/projects/${archived.id}`, {
      method: 'PATCH',
      cookie,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ isArchived: true }),
    })

    /** Names in the order the server returned them, so sort and dir stay observable. */
    const namesInOrder = async (query: string): Promise<string[]> =>
      (await (await server.fetch(`/api/projects${query}`, { cookie })).json()).map(
        (p: { name: string }) => p.name,
      )
    /** Names as a set, for the filters where response order is not the point. */
    const names = async (query: string) => (await namesInOrder(query)).sort()

    assert.deepEqual(await names('?search=bench'), ['Benchy'])
    assert.deepEqual(await names('?tags=petg&tags=boat'), ['Benchy'])
    // Asserted in the server's own order and in both directions: sorting these
    // client-side, or checking only asc, passes even when dir is ignored entirely.
    assert.deepEqual(await namesInOrder('?sort=name&dir=asc'), ['Benchy', 'Bracket'])
    assert.deepEqual(await namesInOrder('?sort=name&dir=desc'), ['Bracket', 'Benchy'])
    assert.deepEqual(await namesInOrder('?includeArchived=true&sort=name&dir=asc'), [
      'Benchy',
      'Bracket',
      'Old',
    ])
  })
})

Deno.test('tags are added by body and removed by path', async () => {
  await withServer(async (server) => {
    const cookie = await loginAsAdmin(server)
    const project = await (
      await server.fetch('/api/projects', {
        method: 'POST',
        cookie,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'Benchy' }),
      })
    ).json()

    const added = await server.fetch(`/api/projects/${project.id}/tags`, {
      method: 'POST',
      cookie,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'needs support' }),
    })
    assert.equal(added.status, 204)
    assert.deepEqual(
      (await (await server.fetch(`/api/projects/${project.id}`, { cookie })).json()).tags,
      ['needs support'],
    )

    // The name is in the path, so there is no DELETE body (spec 4.3).
    const removed = await server.fetch(
      `/api/projects/${project.id}/tags/${encodeURIComponent('needs support')}`,
      { method: 'DELETE', cookie },
    )
    assert.equal(removed.status, 204)
    assert.deepEqual(
      (await (await server.fetch(`/api/projects/${project.id}`, { cookie })).json()).tags,
      [],
    )
  })
})

// Ruling 32: pin down URLPattern's path-group encoding for DELETE .../tags/:name.
// 'needs support' round-trips identically whether URLPattern hands back an encoded or
// decoded substring (no percent signs involved), so it can't distinguish the two readings.
// A literal '%' can: decodeURIComponent('100%') throws a URIError, which would surface as a
// 500 if the handler's decodeURIComponent call were operating on an already-decoded value.
Deno.test(
  'a tag name containing a literal percent sign round-trips through the path route',
  async () => {
    await withServer(async (server) => {
      const cookie = await loginAsAdmin(server)
      const project = await (
        await server.fetch('/api/projects', {
          method: 'POST',
          cookie,
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ name: 'Benchy' }),
        })
      ).json()

      const added = await server.fetch(`/api/projects/${project.id}/tags`, {
        method: 'POST',
        cookie,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: '100% infill' }),
      })
      assert.equal(added.status, 204)
      assert.deepEqual(
        (await (await server.fetch(`/api/projects/${project.id}`, { cookie })).json()).tags,
        ['100% infill'],
      )

      const removed = await server.fetch(
        `/api/projects/${project.id}/tags/${encodeURIComponent('100% infill')}`,
        { method: 'DELETE', cookie },
      )
      assert.equal(removed.status, 204)
      assert.deepEqual(
        (await (await server.fetch(`/api/projects/${project.id}`, { cookie })).json()).tags,
        [],
      )
    })
  },
)

Deno.test(
  'a malformed percent-escape in the tag name path segment is a 400, not a 500',
  async () => {
    await withServer(async (server) => {
      const cookie = await loginAsAdmin(server)
      const project = await (
        await server.fetch('/api/projects', {
          method: 'POST',
          cookie,
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ name: 'Benchy' }),
        })
      ).json()

      const response = await server.fetch(`/api/projects/${project.id}/tags/%`, {
        method: 'DELETE',
        cookie,
      })
      assert.equal(response.status, 400)
    })
  },
)

Deno.test('rescan adopts folders and reports what it did', async () => {
  await withServer(async (server) => {
    const cookie = await loginAsAdmin(server)
    mkdirSync(join(server.dir, 'admin', 'Gridfinity Bin'), { recursive: true })
    writeFileSync(join(server.dir, 'admin', 'Gridfinity Bin', 'bin.stl'), 'solid')

    const response = await server.fetch('/api/projects/rescan', { method: 'POST', cookie })
    assert.equal(response.status, 200)
    const result = await response.json()
    assert.equal(result.adopted, 1)
    assert.equal(result.filesAdded, 1)
    assert.equal(result.previewsQueued, 1)

    const [project] = await (await server.fetch('/api/projects', { cookie })).json()
    assert.equal(project.name, 'Gridfinity Bin')
    assert.deepEqual(project.fileCounts, { model: 1, slicerProject: 0, other: 0 })
  })
})

Deno.test('another user project is a 404, not a 403', async () => {
  await withServer(async (server) => {
    const adminCookie = await loginAsAdmin(server)
    const created = await (
      await server.fetch('/api/users', {
        method: 'POST',
        cookie: adminCookie,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ username: 'anna', displayName: 'Anna' }),
      })
    ).json()
    const token = created.activationUrl.split('#')[1]
    const annaCookie = (
      await server.fetch(`/api/auth/activation/${token}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          password: 'another long password',
          confirm: 'another long password',
        }),
      })
    ).headers
      .get('set-cookie')!
      .split(';')[0]!

    const mine = await (
      await server.fetch('/api/projects', {
        method: 'POST',
        cookie: adminCookie,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'Benchy' }),
      })
    ).json()

    // Admins administer users; they never see other users' projects (spec 5.5).
    assert.equal(
      (await server.fetch(`/api/projects/${mine.id}`, { cookie: annaCookie })).status,
      404,
    )
    assert.deepEqual(await (await server.fetch('/api/projects', { cookie: annaCookie })).json(), [])
  })
})
