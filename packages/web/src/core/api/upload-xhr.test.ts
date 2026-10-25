import { describe, expect, it, vi } from 'vitest'
import { ApiError } from './error'
import { uploadWithProgress } from './upload-xhr'

/** Just enough of XMLHttpRequest for the code under test, driven by hand. */
class FakeXhr {
  upload: { onprogress: ((event: unknown) => void) | null } = { onprogress: null }
  onload: (() => void) | null = null
  onerror: (() => void) | null = null
  onabort: (() => void) | null = null
  ontimeout: (() => void) | null = null
  withCredentials = false
  status = 0
  responseText = ''
  readonly headers: Record<string, string> = {}
  opened: [string, string] | undefined
  sent: unknown
  open = (method: string, url: string) => (this.opened = [method, url])
  setRequestHeader = (name: string, value: string) => (this.headers[name] = value)
  send = (body: unknown) => (this.sent = body)
  abort = vi.fn(() => this.onabort?.())
  respond(status: number, body: string) {
    this.status = status
    this.responseText = body
    this.onload?.()
  }
}

const make = () => {
  const xhr = new FakeXhr()
  return { xhr, createXhr: () => xhr as unknown as XMLHttpRequest }
}

describe('uploadWithProgress', () => {
  it('posts the body with credentials and the headers it was given', async () => {
    const { xhr, createXhr } = make()
    const body = new Blob(['x'])
    const result = uploadWithProgress<{ id: string }>('/api/projects/p/files', body, {
      headers: { 'x-spm-file-name': 'a.stl' },
      createXhr,
    })
    expect(xhr.opened).toEqual(['POST', '/api/projects/p/files'])
    expect(xhr.withCredentials).toBe(true)
    expect(xhr.headers).toEqual({ 'x-spm-file-name': 'a.stl' })
    expect(xhr.sent).toBe(body)
    xhr.respond(200, '{"id":"f1"}')
    await expect(result).resolves.toEqual({ id: 'f1' })
  })

  it('reports how much has been sent, as a fraction, and ignores an unknown total', async () => {
    const { xhr, createXhr } = make()
    const onProgress = vi.fn()
    const result = uploadWithProgress('/x', new Blob(['x']), { onProgress, createXhr })
    xhr.upload.onprogress!({ lengthComputable: true, loaded: 25, total: 100 })
    xhr.upload.onprogress!({ lengthComputable: false, loaded: 50, total: 0 })
    expect(onProgress.mock.calls).toEqual([[0.25]])
    xhr.respond(200, '{}')
    await result
    expect(onProgress).toHaveBeenLastCalledWith(1)
  })

  it('rejects with the typed error the server sent, details included', async () => {
    const { xhr, createXhr } = make()
    const result = uploadWithProgress('/x', new Blob(['x']), { createXhr })
    xhr.respond(
      413,
      JSON.stringify({
        error: {
          code: 'QuotaExceeded',
          message: 'over quota',
          details: { usageBytes: 1, quotaBytes: 2, incomingBytes: 3 },
        },
      }),
    )
    const error = await result.catch((e: unknown) => e)
    expect(error).toBeInstanceOf(ApiError)
    expect(error).toMatchObject({ code: 'QuotaExceeded', status: 413 })
    expect((error as ApiError).details).toMatchObject({ quotaBytes: 2 })
  })

  it('turns a reply that is not an envelope into an Internal that names the status', async () => {
    const { xhr, createXhr } = make()
    const result = uploadWithProgress('/x', new Blob(['x']), { createXhr })
    xhr.respond(502, '<html>bad gateway</html>')
    await expect(result).rejects.toMatchObject({ code: 'Internal', status: 502 })
  })

  it('rejects with Internal on a network failure and on a body that is not JSON', async () => {
    const failing = make()
    const one = uploadWithProgress('/x', new Blob(['x']), { createXhr: failing.createXhr })
    failing.xhr.onerror!()
    await expect(one).rejects.toMatchObject({ code: 'Internal' })

    const garbled = make()
    const two = uploadWithProgress('/x', new Blob(['x']), { createXhr: garbled.createXhr })
    garbled.xhr.respond(200, 'not json')
    await expect(two).rejects.toMatchObject({ code: 'Internal', status: 200 })
  })

  it('aborts the request when the signal fires', async () => {
    const { xhr, createXhr } = make()
    const controller = new AbortController()
    const result = uploadWithProgress('/x', new Blob(['x']), {
      signal: controller.signal,
      createXhr,
    })
    controller.abort()
    expect(xhr.abort).toHaveBeenCalled()
    await expect(result).rejects.toMatchObject({ code: 'Internal' })
  })
})
