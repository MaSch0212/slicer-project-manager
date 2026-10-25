import { describe, expect, it, vi } from 'vitest'
import { createApiClient } from './client'
import { ApiError, isApiError } from './error'

function respond(body: unknown, init: ResponseInit = {}) {
  // A fresh Response per call: a body can be read once.
  return vi.fn((_input: string, _init?: RequestInit) =>
    Promise.resolve(
      new Response(typeof body === 'string' ? body : JSON.stringify(body), {
        status: 200,
        ...init,
      }),
    ),
  )
}

describe('createApiClient', () => {
  // Ported from HttpApiClient: sends credentials so the session cookie travels.
  it('sends credentials so the session cookie travels', async () => {
    const fetchFn = respond({ requiresAuth: true })
    await createApiClient(fetchFn).capabilities()
    expect(fetchFn).toHaveBeenCalledWith('/api/capabilities', { credentials: 'include' })
  })

  // Ported: builds the project query string from a ProjectQuery.
  it('builds the project query string from a ProjectQuery', async () => {
    const fetchFn = respond([])
    await createApiClient(fetchFn).projects.list({
      search: 'benchy',
      tags: ['a', 'b c'],
      includeArchived: true,
      sort: 'name',
      dir: 'asc',
      limit: 50,
      offset: 100,
    })
    const url = new URL(fetchFn.mock.calls[0]![0] as string, 'http://x')
    expect(url.pathname).toBe('/api/projects')
    expect(url.searchParams.get('search')).toBe('benchy')
    expect(url.searchParams.getAll('tags')).toEqual(['a', 'b c'])
    expect(url.searchParams.get('includeArchived')).toBe('true')
    expect(url.searchParams.get('sort')).toBe('name')
    expect(url.searchParams.get('dir')).toBe('asc')
    expect(url.searchParams.get('limit')).toBe('50')
    expect(url.searchParams.get('offset')).toBe('100')
  })

  // Ported: omits limit and offset when the caller does not page.
  it('omits limit and offset, and the whole query, when the caller gives none', async () => {
    const fetchFn = respond([])
    await createApiClient(fetchFn).projects.list({})
    expect(fetchFn.mock.calls[0]![0]).toBe('/api/projects')
    await createApiClient(fetchFn).projects.list({ includeArchived: false, sort: 'name' })
    expect(fetchFn.mock.calls[1]![0]).toBe('/api/projects?sort=name')
  })

  // Ported: turns the error envelope back into an error with its details.
  it('turns the error envelope into an ApiError with code, message, details and status', async () => {
    const fetchFn = respond(
      { error: { code: 'QuotaExceeded', message: 'too big', details: { usageBytes: 5 } } },
      { status: 413 },
    )
    const error = await createApiClient(fetchFn)
      .files.upload('p', 'a.stl', new Blob(['x']))
      .catch((e: unknown) => e)
    expect(isApiError(error)).toBe(true)
    expect(error).toBeInstanceOf(ApiError)
    expect(error).toMatchObject({
      code: 'QuotaExceeded',
      message: 'too big',
      details: { usageBytes: 5 },
      status: 413,
    })
  })

  // Ported: reports a non-JSON failure as an Internal error.
  it('reports a failure that is not our envelope as Internal, naming the status', async () => {
    const error = await createApiClient(respond('<html>bad gateway</html>', { status: 502 }))
      .capabilities()
      .catch((e: unknown) => e)
    expect(error).toMatchObject({ code: 'Internal', status: 502 })
    expect((error as ApiError).message).toContain('502')
  })

  it('does not trust an unknown error code from outside', async () => {
    const fetchFn = respond(
      { error: { code: 'Weird', message: 'x', details: {} } },
      { status: 400 },
    )
    const error = await createApiClient(fetchFn)
      .capabilities()
      .catch((e: unknown) => e)
    expect(error).toMatchObject({ code: 'Internal' })
  })

  // Ported: an unparseable success body is Internal too (the static handler's index.html).
  it('reports an unparseable success body as Internal', async () => {
    const error = await createApiClient(respond('<!doctype html>'))
      .capabilities()
      .catch((e: unknown) => e)
    expect(error).toMatchObject({ code: 'Internal', status: 200 })
  })

  it('reports a network failure as Internal, never a TypeError', async () => {
    const fetchFn = vi.fn().mockRejectedValue(new TypeError('Failed to fetch'))
    const error = await createApiClient(fetchFn)
      .capabilities()
      .catch((e: unknown) => e)
    expect(error).toBeInstanceOf(ApiError)
    expect(error).toMatchObject({ code: 'Internal', status: 0 })
  })

  it('answers 204 with undefined', async () => {
    const fetchFn = vi.fn().mockResolvedValue(new Response(null, { status: 204 }))
    await expect(createApiClient(fetchFn).auth.logout()).resolves.toBeUndefined()
  })

  // Ported: uploads a Blob without a content-length, leaving the header to the browser.
  it('uploads a Blob with the encoded file name and no content-length', async () => {
    const fetchFn = respond({ id: 'f' })
    const blob = new Blob(['x'])
    await createApiClient(fetchFn).files.upload('p 1', 'a b.stl', blob)
    const [url, init] = fetchFn.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('/api/projects/p%201/files')
    expect(init.body).toBe(blob)
    expect(init.headers).toEqual({ 'x-spm-file-name': 'a%20b.stl' })
  })

  // Ported: encodes a tag name into the delete path rather than a body.
  it('encodes a tag name into the delete path', async () => {
    const fetchFn = vi.fn().mockResolvedValue(new Response(null, { status: 204 }))
    await createApiClient(fetchFn).projects.removeTag('p1', 'a/b c')
    expect(fetchFn).toHaveBeenCalledWith('/api/projects/p1/tags/a%2Fb%20c', {
      method: 'DELETE',
      credentials: 'include',
    })
  })

  it('activates with the password as its own confirmation, at the token path', async () => {
    const fetchFn = respond({ id: 'u' })
    await createApiClient(fetchFn).auth.activate('tok/en', 'a good long password')
    const [url, init] = fetchFn.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('/api/auth/activation/tok%2Fen')
    expect(JSON.parse(init.body as string)).toEqual({
      password: 'a good long password',
      confirm: 'a good long password',
    })
  })
})
