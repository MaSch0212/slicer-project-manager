/**
 * Reading a text file for the preview: at most the first `maxBytes` of it (the download stops
 * there, so a 300 MB G-code file costs two megabytes, not three hundred), decoded as UTF-8, and a
 * judgement on whether it is text at all.
 */

/** How much of a text file the preview reads. */
export const TEXT_MAX_BYTES = 2 * 1024 * 1024

/** Above this the text is shown plain: highlighting a few megabytes freezes the page. */
export const HIGHLIGHT_MAX_CHARS = 512 * 1024

export class TextFetchError extends Error {
  readonly missing: boolean
  constructor(missing: boolean) {
    super(missing ? 'missing' : 'fetch')
    this.missing = missing
  }
}

/** The first `maxBytes` of a file, and whether there was more. */
export async function fetchHead(
  url: string,
  maxBytes: number,
  signal: AbortSignal,
  fetchFn: typeof fetch = (input, init) => fetch(input, init),
): Promise<{ bytes: Uint8Array; truncated: boolean }> {
  let response: Response
  try {
    response = await fetchFn(url, { credentials: 'same-origin', signal })
  } catch {
    throw new TextFetchError(false)
  }
  if (response.status === 404 || response.status === 410) throw new TextFetchError(true)
  if (!response.ok) throw new TextFetchError(false)
  const body = response.body
  if (!body) {
    const all = new Uint8Array(await response.arrayBuffer())
    return { bytes: all.slice(0, maxBytes), truncated: all.byteLength > maxBytes }
  }
  const reader = body.getReader()
  const chunks: Uint8Array[] = []
  let received = 0
  let truncated = false
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      chunks.push(value)
      received += value.byteLength
      if (received >= maxBytes) {
        truncated = received > maxBytes
        // Whatever else the server would send is not wanted.
        void reader.cancel().catch(() => {})
        break
      }
    }
  } catch {
    throw new TextFetchError(false)
  }
  const bytes = new Uint8Array(Math.min(received, maxBytes))
  let at = 0
  for (const chunk of chunks) {
    const part = chunk.subarray(0, Math.min(chunk.byteLength, bytes.byteLength - at))
    bytes.set(part, at)
    at += part.byteLength
    if (at >= bytes.byteLength) break
  }
  return { bytes, truncated }
}

/**
 * The bytes as text, or `binary` when they are not: a NUL in the first 8 KB is what `git` and
 * `grep` go by, and it is right for every file a library like this holds. A byte-order mark is
 * dropped; UTF-16 files (with their mark) are decoded as such.
 */
export function decodeText(bytes: Uint8Array): { text: string; binary: boolean } {
  if (bytes[0] === 0xff && bytes[1] === 0xfe) {
    return { text: new TextDecoder('utf-16le').decode(bytes.subarray(2)), binary: false }
  }
  if (bytes[0] === 0xfe && bytes[1] === 0xff) {
    return { text: new TextDecoder('utf-16be').decode(bytes.subarray(2)), binary: false }
  }
  const head = bytes.subarray(0, 8192)
  if (head.includes(0)) return { text: '', binary: true }
  // `ignoreBOM: false` (the default) strips a UTF-8 mark; a cut at the 2 MB line may split one
  // character, which decodes as a replacement character at the very end.
  return { text: new TextDecoder('utf-8').decode(bytes), binary: false }
}

/** How many lines a text has, for the line numbers. A trailing newline does not start one. */
export function lineCount(text: string): number {
  if (text === '') return 1
  let lines = 1
  for (let index = text.indexOf('\n'); index !== -1; index = text.indexOf('\n', index + 1)) {
    lines++
  }
  return text.endsWith('\n') ? lines - 1 : lines
}
