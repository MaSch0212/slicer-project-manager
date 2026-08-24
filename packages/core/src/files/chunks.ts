import { closeSync, fstatSync, openSync, readSync } from 'node:fs'
import { AppError } from '@spm/contract/errors.ts'

/**
 * A parser that is handed its input a piece at a time and produces its answer at the end.
 *
 * The shape exists so that one parser body serves both a caller that already holds the whole
 * input (`feedSink`) and one that must never hold it at all (`drainSink`). Streaming is
 * unavoidably asynchronous — `DecompressionStream` is a `TransformStream`, and `readZipEntryChunks`
 * is an async generator because of it — while `parseStl(bytes)` and `parseObj(bytes)` are
 * synchronous and are what every unit test calls. A sink inverts the control so the *driver*
 * carries the asynchrony and the parser carries none of it, which is why there is exactly one
 * implementation of each format rather than a synchronous one and a streaming one that drift.
 *
 * A sink may not retain a pushed chunk past the `push` that delivered it: `readFileChunks` reuses
 * one buffer, and a `readZipEntryChunks` chunk is a view into an inflater-owned parent far larger
 * than itself. Copy what has to survive.
 */
export type ChunkSink<T> = {
  push(chunk: Uint8Array): void
  end(): T
}

/** Runs a sink over one buffer the caller already holds. */
export function feedSink<T>(sink: ChunkSink<T>, bytes: Uint8Array): T {
  if (bytes.byteLength > 0) sink.push(bytes)
  return sink.end()
}

/**
 * Runs a sink over a chunk stream.
 *
 * `for await` calls the generator's `return()` on the way out, including when `push` throws, so a
 * malformed input closes the descriptor (or cancels the inflater) rather than stranding it.
 */
export async function drainSink<T>(
  sink: ChunkSink<T>,
  chunks: AsyncIterable<Uint8Array>,
): Promise<T> {
  for await (const chunk of chunks) {
    if (chunk.byteLength > 0) sink.push(chunk)
  }
  return sink.end()
}

/**
 * How much of a plain file is read at a time. Bigger than the 3MF parser's zip chunk because
 * nothing downstream of it copies per chunk — the cost of a larger value is only the buffer
 * itself, and the cost of a smaller one is a `readSync` and a generator resumption per 64 KB of a
 * 164 MB file.
 */
export const DEFAULT_FILE_CHUNK_BYTES = 256 * 1024

/**
 * A file held open across several reads of it.
 *
 * The parsers need a file more than once: STL sniffs its first 4 KB to decide binary from ASCII
 * and then streams the body, and both ASCII STL and OBJ stream it twice more to count and then to
 * fill. Opening per read cost three `open`/`close` pairs on an ASCII file and two on every binary
 * one, which is invisible on the library's four huge models and is most of the cost on its 1 300
 * small ones — where the parse itself is a fraction of a millisecond and the syscalls are not.
 * Shaped after `openZip`, for the same reason and with the same lifetime rule: the reads are the
 * holder's to sequence, and `close()` belongs in a `finally`.
 */
export type OpenFile = {
  /** The first `maxBytes`, or the whole file if it is shorter. */
  head(maxBytes: number): Uint8Array
  /** The file from byte 0, in order. One pass; call again for another. */
  chunks(chunkBytes?: number): AsyncGenerator<Uint8Array, void, unknown>
  /** The length as of `open`. */
  size(): number
  close(): void
}

export function openFile(absPath: string): OpenFile {
  const fd = openSync(absPath, 'r')
  // Read once, at open, and every later answer comes from it — so the length a caller validates
  // against and the length the reader allocates for cannot disagree, whatever the file does
  // afterwards. It is also what keeps `chunks` from allocating a 256 KB buffer for a 40 KB file,
  // which the reference library does 1 311 times in a backfill. Worth about 2% of the STL half of
  // one: small, measured rather than assumed, and the reason it is in the code is that it costs a
  // `Math.min` and removes an obviously wrong allocation, not that it was needed.
  const bytes = fstatSync(fd).size
  let closed = false
  // Re-checked before every read rather than once, because `chunks` is a generator and its reads
  // happen whenever the consumer pulls — possibly after the holder has closed underneath it. A
  // descriptor number is recycled the moment it is closed, so an unguarded read does not fail, it
  // reads *some other file*. Same hazard, same guard, as `openZip`.
  const requireOpen = (): void => {
    if (closed) throw new AppError('Validation', 'file is already closed')
  }
  return {
    head(maxBytes) {
      requireOpen()
      const buffer = new Uint8Array(Math.max(1, maxBytes))
      let read = 0
      while (read < buffer.length) {
        const n = readSync(fd, buffer, read, buffer.length - read, read)
        if (n === 0) break
        read += n
      }
      return buffer.subarray(0, read)
    },
    async *chunks(chunkBytes: number = DEFAULT_FILE_CHUNK_BYTES) {
      // Never larger than the file. A file that has grown since `open` is not a problem — it just
      // arrives in more pieces — and a file that never fills a chunk stops paying for one.
      const buffer = new Uint8Array(Math.max(1, Math.min(chunkBytes, bytes)))
      let position = 0
      for (;;) {
        requireOpen()
        const read = readSync(fd, buffer, 0, buffer.length, position)
        if (read === 0) return
        position += read
        yield buffer.subarray(0, read)
      }
    },
    size() {
      requireOpen()
      return bytes
    },
    close() {
      if (closed) return
      closed = true
      closeSync(fd)
    },
  }
}

/**
 * Reads a file as a stream of chunks, in order, opening and closing it around the iteration.
 *
 * **The yielded chunk is a view into one reused buffer and is only valid until the next pull.**
 * That is the opposite of `readZipEntryChunks`, which never reuses — and it is the right trade
 * here because there is no inflater in the way, so the buffer can be exactly the size the reader
 * chose rather than whatever the runtime handed over. Every consumer in this package decodes or
 * copies inside the loop body.
 *
 * `readSync` against an explicit position rather than the descriptor's own cursor: the cursor form
 * is spelled `null` in `node:fs` and a negative or omitted position means "wherever the descriptor
 * happens to be", which is a difference between runtimes that costs nothing to avoid.
 *
 * For a caller that reads the same file more than once, `openFile` above is the same thing without
 * the repeated `open`.
 */
export async function* readFileChunks(
  absPath: string,
  chunkBytes: number = DEFAULT_FILE_CHUNK_BYTES,
): AsyncGenerator<Uint8Array, void, unknown> {
  const file = openFile(absPath)
  try {
    yield* file.chunks(chunkBytes)
  } finally {
    file.close()
  }
}

/**
 * A line longer than this is refused rather than accumulated.
 *
 * The carry-over a line sink holds is one incomplete line, so this constant *is* the sink's memory
 * bound — without it a file with no newline in it would be buffered whole, which is the failure
 * this whole task exists to remove. No text mesh format writes a line remotely this long: an OBJ
 * `f` line for a 10 000-gon is a few hundred kilobytes at the very worst, and an ASCII STL vertex
 * record is under 80 bytes.
 *
 * **It bounds the buffered callers too, and that is a narrowing.** `parseStl(bytes)` and
 * `parseObj(bytes)` go through the same sink, so a caller that already holds a 4 MB single-line
 * OBJ in memory — where the old whole-text walk would simply have parsed it — now gets an
 * `AppError`. Deliberate: one line-splitting implementation is worth more than the buffered path's
 * ability to accept a file the streaming path could not, and the alternative is two grammars that
 * disagree about which files are valid depending on how they were opened.
 */
export const MAX_LINE_CHARS = 1 << 20

/**
 * Splits a chunk stream into lines, keeping only the incomplete tail between pushes.
 *
 * Lines arrive without their `\n`; a trailing `\r` is left on, because both callers already strip
 * whitespace (OBJ trims, the ASCII STL regex treats `\r` as whitespace) and stripping it here
 * would be a second place for the CRLF rule to live. The final segment is always visited, even
 * when it is empty — a file ending in `\n` therefore ends with one empty line, exactly as an
 * `indexOf`-driven walk over the whole decoded text did.
 *
 * `TextDecoder` is used in streaming mode, so a multi-byte character split across a chunk boundary
 * is held back and completed rather than becoming two U+FFFD replacements.
 */
export function makeLineSink(visit: (line: string) => void): ChunkSink<void> {
  const decoder = new TextDecoder()
  let carry = ''
  return {
    push(chunk) {
      const text = carry + decoder.decode(chunk, { stream: true })
      let start = 0
      for (;;) {
        const at = text.indexOf('\n', start)
        if (at === -1) break
        visit(text.slice(start, at))
        start = at + 1
      }
      carry = start === 0 ? text : text.slice(start)
      if (carry.length > MAX_LINE_CHARS) {
        throw new AppError('Validation', `text line is longer than ${MAX_LINE_CHARS} characters`, {
          maxLineChars: MAX_LINE_CHARS,
        })
      }
    },
    end() {
      const last = carry + decoder.decode()
      carry = ''
      visit(last)
    },
  }
}
