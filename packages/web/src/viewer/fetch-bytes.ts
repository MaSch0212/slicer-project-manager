/**
 * Fetching a file's bytes with progress, free of three.js, so the archive preview can use it
 * without loading the 3D chunk. The model viewer re-exports it from `load-model`.
 */

/** Why a model did not load. */
export type LoadFailure = 'missing' | 'fetch' | 'parse' | 'empty'

export class ModelLoadError extends Error {
  readonly reason: LoadFailure
  constructor(reason: LoadFailure) {
    super(reason)
    this.reason = reason
  }
}

/**
 * Downloads a model, reporting progress. The size the API gave is used to allocate once and fill in
 * place (no second copy), and is only a hint: a body that turns out longer or shorter is handled.
 * `signal` abandons the download when the page goes away.
 */
export async function fetchModel(
  url: string,
  sizeHint: number,
  signal: AbortSignal,
  onProgress: (fraction: number | null) => void,
  fetchFn: typeof fetch = (input, init) => fetch(input, init),
): Promise<ArrayBuffer> {
  let response: Response
  try {
    response = await fetchFn(url, { credentials: 'same-origin', signal })
  } catch {
    throw new ModelLoadError('fetch')
  }
  if (response.status === 404 || response.status === 410) throw new ModelLoadError('missing')
  if (!response.ok) throw new ModelLoadError('fetch')

  // Aborted while the headers were still arriving: nothing is listening to the body any more.
  if (signal.aborted) {
    void response.body?.cancel().catch(() => {})
    throw new ModelLoadError('fetch')
  }

  const body = response.body
  if (!body) {
    try {
      return await response.arrayBuffer()
    } catch {
      throw new ModelLoadError('fetch')
    }
  }

  const total = sizeHint
  const buffer = total > 0 ? new Uint8Array(total) : null
  const spill: Uint8Array[] = []
  let placed = 0
  let received = 0

  const reader = body.getReader()
  const stopReading = (): void => void reader.cancel().catch(() => {})
  signal.addEventListener('abort', stopReading, { once: true })
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      if (buffer && spill.length === 0 && received + value.byteLength <= total) {
        buffer.set(value, placed)
        placed += value.byteLength
      } else {
        spill.push(value)
      }
      received += value.byteLength
      onProgress(total > 0 ? Math.min(received / total, 1) : null)
    }
  } catch {
    throw new ModelLoadError('fetch')
  } finally {
    signal.removeEventListener('abort', stopReading)
  }
  if (signal.aborted) throw new ModelLoadError('fetch')

  if (buffer && received === total) return buffer.buffer as ArrayBuffer
  const out = new Uint8Array(received)
  if (buffer) out.set(buffer.subarray(0, placed))
  let offset = placed
  for (const chunk of spill) {
    out.set(chunk, offset)
    offset += chunk.byteLength
  }
  return out.buffer
}
