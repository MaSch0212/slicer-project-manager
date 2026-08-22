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

    await client.account.me()

    const [url, init] = fetchMock.mock.calls[0]!
    expect(url).toBe('/api/account')
    expect(init.credentials).toBe('include')
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

  it('reports a non-JSON failure as an Internal AppError', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('gateway down', { status: 502 }))
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
