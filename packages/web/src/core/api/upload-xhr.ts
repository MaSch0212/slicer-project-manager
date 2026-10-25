import { ApiError, errorFromResponse } from './error'

/**
 * POSTs `body` with upload progress. `fetch` cannot report how much of a request body has left the
 * machine, `XMLHttpRequest` can, which is the whole reason this exists beside the client's other
 * calls. Same contract as `request` in client.ts: resolves with the parsed JSON, rejects with an
 * `ApiError` (the server's envelope when there is one), and never with a raw event.
 *
 * `createXhr` is a parameter so a test can hand in a fake.
 */
export function uploadWithProgress<T>(
  path: string,
  body: Blob,
  options: {
    headers?: Record<string, string>
    onProgress?: (fraction: number) => void
    signal?: AbortSignal
    createXhr?: () => XMLHttpRequest
  } = {},
): Promise<T> {
  const xhr = (options.createXhr ?? (() => new XMLHttpRequest()))()
  return new Promise<T>((resolve, reject) => {
    xhr.open('POST', path)
    xhr.withCredentials = true
    for (const [name, value] of Object.entries(options.headers ?? {})) {
      xhr.setRequestHeader(name, value)
    }
    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable && event.total > 0) {
        options.onProgress?.(Math.min(event.loaded / event.total, 1))
      }
    }
    xhr.onerror = () => reject(new ApiError('Internal', 'network error'))
    xhr.onabort = () => reject(new ApiError('Internal', 'upload cancelled'))
    xhr.ontimeout = () => reject(new ApiError('Internal', 'upload timed out'))
    xhr.onload = () => {
      const response = new Response(xhr.status === 204 ? null : xhr.responseText, {
        status: xhr.status,
      })
      if (xhr.status < 200 || xhr.status >= 300) {
        void errorFromResponse(response).then(reject)
        return
      }
      if (xhr.status === 204) {
        resolve(undefined as T)
        return
      }
      try {
        options.onProgress?.(1)
        resolve(JSON.parse(xhr.responseText) as T)
      } catch {
        reject(
          new ApiError('Internal', 'the server returned an unparseable body', {
            status: xhr.status,
          }),
        )
      }
    }
    options.signal?.addEventListener('abort', () => xhr.abort(), { once: true })
    xhr.send(body)
  })
}
