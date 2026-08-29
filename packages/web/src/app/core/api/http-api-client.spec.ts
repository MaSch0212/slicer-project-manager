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

  /**
   * The same shape again, for the whole browse block, and every method of it rather than one.
   *
   * **The whole block means the download half too.** `HttpApiClient` grew `downloads`, `discard`,
   * `notices` and `dismissNotice` when the interface did, and this list did not grow with it — so
   * four methods were refusing on nothing but the compiler's word for a round. There is no
   * `will-download` on this transport to intercept, no staging directory under a `userData` this
   * shell does not have, and no notice surface; a browser's own download manager owns all three.
   * `land` is on the list for the same reason and not a weaker one: there is no staged download
   * here for it to name, and the `files.upload` it would otherwise be a synonym for needs a body
   * the renderer has, which is exactly what a landing does not have.
   *
   * The model browser is a `WebContentsView` the main process owns; over HTTP there is no such
   * thing and no route that would make one. The `expect(fetchMock)` half is the interesting one for
   * the same reason it is in the slicer test — a method that fell through to `this.request` would
   * send `/api/browse/...` at a server that has never heard of it and surface the 404 as
   * `Internal`, which is a much worse thing for the UI to switch on than a `Forbidden`.
   *
   * A rectangle is passed to the two that take one rather than `undefined`: the parameters on this
   * class are named and unused, and a spec that called them with nothing would still compile if
   * somebody removed them and with them the call signature `ApiClient` promises.
   */
  it('refuses every browse method, without inventing a request for any of them', async () => {
    const fetchMock = vi.fn()
    const client = new HttpApiClient('', fetchMock)
    const bounds = { x: 0, y: 120, width: 800, height: 600 }
    const calls = [
      client.browse.sites(),
      client.browse.attach(bounds),
      client.browse.attach(bounds, 'https://www.thingiverse.com/'),
      client.browse.detach(),
      client.browse.hide(),
      client.browse.show(),
      client.browse.setBounds(bounds),
      client.browse.navigate('https://www.thingiverse.com/'),
      client.browse.back(),
      client.browse.forward(),
      client.browse.reload(),
      client.browse.state(),
      client.browse.clearLastPage(),
      client.browse.downloads(),
      // The id is passed rather than nothing, for the reason the rectangle is: the parameters on
      // this class are named and unused, and a spec calling them with nothing would still compile
      // if somebody removed them and with them the call signature `ApiClient` promises.
      client.browse.discard('dl-1'),
      client.browse.notices(),
      client.browse.dismissNotice('notice-1'),
      // Both arities of the landing, for the reason the two `attach` calls above are both here: the
      // optional argument is part of the call signature `ApiClient` promises, and a spec that only
      // ever called the short form would still compile if it were dropped.
      client.browse.land('dl-1', 'p-1'),
      client.browse.land('dl-1', 'p-1', { name: 'benchy.zip' }),
    ]

    for (const call of calls) {
      await expect(call).rejects.toBeInstanceOf(AppError)
      await expect(call).rejects.toMatchObject({
        code: 'Forbidden',
        message: 'this shell cannot embed a model browser',
      })
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
