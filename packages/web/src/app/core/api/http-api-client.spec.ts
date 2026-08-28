import { describe, expect, it, vi } from 'vitest'
import { AppError } from '@spm/contract/errors.ts'
import { HttpApiClient } from './http-api-client'

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

describe('HttpApiClient', () => {
  it('sends credentials so the session cookie travels', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ id: '1' }))
    const client = new HttpApiClient('', fetchMock)

    const me = await client.account.me()

    const [url, init] = fetchMock.mock.calls[0]!
    expect(url).toBe('/api/account')
    expect(init.credentials).toBe('include')
    // The parsed body has to reach the caller: without this, a transport that returned
    // undefined for every success would still pass every other test here.
    expect(me).toEqual({ id: '1' })
  })

  it('prefixes every path with the base url a non-browser shell passes', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ theme: 'dark' }))
    const client = new HttpApiClient('http://127.0.0.1:8787', fetchMock)

    await client.settings.get()

    expect(fetchMock.mock.calls[0]![0]).toBe('http://127.0.0.1:8787/api/account/settings')
  })

  it('builds the project query string from a ProjectQuery', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse([]))
    const client = new HttpApiClient('', fetchMock)

    await client.projects.list({
      search: '100%',
      tags: ['petg', 'functional'],
      includeArchived: true,
      sort: 'name',
      dir: 'asc',
    })

    const url = new URL(fetchMock.mock.calls[0]![0], 'http://x')
    expect(url.searchParams.get('search')).toBe('100%')
    expect(url.searchParams.getAll('tags')).toEqual(['petg', 'functional'])
    expect(url.searchParams.get('includeArchived')).toBe('true')
    expect(url.searchParams.get('sort')).toBe('name')
    expect(url.searchParams.get('dir')).toBe('asc')
  })

  /**
   * `ApiClient` is one interface and both transports answer the whole of it. Over HTTP there is
   * no local folder and no route to ask for one, so this refuses in the shape every other method
   * here fails in — an `AppError` with a code — and, crucially, without inventing a request.
   */
  it('refuses to pick a local folder, and does not go to the server to say so', async () => {
    const fetchMock = vi.fn()
    const client = new HttpApiClient('', fetchMock)

    await expect(client.library.pick()).rejects.toBeInstanceOf(AppError)
    await expect(client.library.pick()).rejects.toMatchObject({ code: 'Forbidden' })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  /**
   * The same shape, for the whole slicer block, and all seven rather than one of them.
   *
   * Over HTTP the machine the user is sitting at is a browser tab, so there is nothing here to
   * configure and no route that would configure it. The interesting half is `expect(fetchMock)`:
   * a method that fell through to `this.request` would send a request to a path the server has
   * never heard of and surface a 404 as `Internal`, which is a much worse thing for the UI to
   * switch on than a `Forbidden` it can recognise.
   */
  it('refuses every slicer method, without inventing a request for any of them', async () => {
    const fetchMock = vi.fn()
    const client = new HttpApiClient('', fetchMock)
    const calls = [
      client.slicers.get(),
      client.slicers.scan(),
      client.slicers.addManual('cura'),
      client.slicers.remove('manual:one'),
      client.slicers.bind('cura', 'manual:one'),
      client.slicers.setDefault('orca'),
      client.slicers.resetConfig(),
    ]

    for (const call of calls) {
      await expect(call).rejects.toBeInstanceOf(AppError)
      await expect(call).rejects.toMatchObject({ code: 'Forbidden' })
    }
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('turns the error envelope back into an AppError with its details', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse(
        {
          error: {
            code: 'QuotaExceeded',
            message: 'storage quota exceeded',
            details: { usageBytes: 90, quotaBytes: 100, incomingBytes: 20 },
          },
        },
        413,
      ),
    )
    const client = new HttpApiClient('', fetchMock)

    await expect(
      client.files.upload('p1', 'a.stl', {
        stream: new ReadableStream(),
        sizeBytes: 20,
      }),
    ).rejects.toMatchObject({ code: 'QuotaExceeded', details: { quotaBytes: 100 } })
  })

  it('uploads a Blob without a content-length, leaving the header to the browser', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ id: 'f1' }))
    const client = new HttpApiClient('', fetchMock)
    const blob = new Blob(['solid stl'], { type: 'model/stl' })

    await client.files.upload('p1', 'a.stl', { blob })

    const [url, init] = fetchMock.mock.calls[0]!
    expect(url).toBe('/api/projects/p1/files')
    expect(init.body).toBe(blob)
    expect(init.headers['x-spm-file-name']).toBe('a.stl')
    // Content-Length is a forbidden header name: setting it here is stripped, so the Blob
    // must be what tells the browser the length. duplex is only for a stream body.
    expect('content-length' in init.headers).toBe(false)
    expect(init.duplex).toBeUndefined()
  })

  it('uploads a stream with the content-length and duplex a non-browser shell needs', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ id: 'f2' }))
    const client = new HttpApiClient('', fetchMock)
    const stream = new ReadableStream<Uint8Array>()

    await client.files.upload('p1', 'b.stl', { stream, sizeBytes: 42 })

    const [, init] = fetchMock.mock.calls[0]!
    expect(init.body).toBe(stream)
    expect(init.headers['content-length']).toBe('42')
    expect(init.duplex).toBe('half')
  })

  it('reports a non-JSON failure as an Internal AppError', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('gateway down', { status: 502 }))
    const client = new HttpApiClient('', fetchMock)
    const error = await client.capabilities().catch((e: unknown) => e)
    expect(error).toBeInstanceOf(AppError)
    expect((error as AppError).code).toBe('Internal')
  })

  it('reports an unparseable success body as an Internal AppError too', async () => {
    // The static handler answers an unrecognised path with index.html and status 200, so a
    // mistyped /api path lands here. Callers must still see an AppError, not a SyntaxError.
    const fetchMock = vi.fn().mockResolvedValue(
      new Response('<!doctype html><html></html>', {
        status: 200,
        headers: { 'content-type': 'text/html' },
      }),
    )
    const client = new HttpApiClient('', fetchMock)

    const error = await client.capabilities().catch((e: unknown) => e)

    expect(error).toBeInstanceOf(AppError)
    expect((error as AppError).code).toBe('Internal')
  })

  it('encodes a tag name into the delete path rather than a body', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 204 }))
    const client = new HttpApiClient('', fetchMock)

    await client.projects.removeTag('p1', 'needs support')

    const [url, init] = fetchMock.mock.calls[0]!
    expect(url).toBe('/api/projects/p1/tags/needs%20support')
    expect(init.method).toBe('DELETE')
    expect(init.body).toBeUndefined()
  })
})
