import { closeSync, openSync, readSync, statSync } from 'node:fs'
import { inflateRawSync } from 'node:zlib'
import { AppError } from '@spm/contract/errors.ts'

/**
 * One central-directory record.
 *
 * The first five fields are everything a *reader* needs. The rest are carried for the *rewriter*
 * (`files/zip-write.ts`), which has to reproduce a record it did not author: the general-purpose
 * flags decide whether an entry is encrypted (bit 0) or defers its sizes to a data descriptor
 * (bit 3), and the CRC, DOS timestamp and attribute words are payload-independent facts about
 * the entry that a copy has no business inventing.
 *
 * They live here rather than in a second parser inside `zip-write.ts` for the same reason the CRC
 * table moved out of the test fixture: the repo gets **one** central-directory layout, read in one
 * place. Nothing below the rewriter reads them.
 */
export type ZipEntry = {
  name: string
  method: number
  compressedSize: number
  uncompressedSize: number
  localHeaderOffset: number
  /** General-purpose bit flag. Bit 0 is encryption, bit 3 a data descriptor, bit 11 UTF-8 names. */
  flags: number
  /** CRC-32 of the *uncompressed* data, as the central directory declares it. */
  crc: number
  /** MS-DOS modification time and date, verbatim. Not decoded; nothing here needs a Date. */
  modTime: number
  modDate: number
  /** High byte is the host system, low byte the ZIP spec version the writer claimed. */
  versionMadeBy: number
  versionNeeded: number
  internalAttributes: number
  externalAttributes: number
}

const EOCD_SIG = 0x06054b50
const CD_SIG = 0x02014b50
const LOCAL_SIG = 0x04034b50
const ZIP64_LOCATOR_SIG = 0x07064b50
const ZIP64_EOCD_SIG = 0x06064b50
const EOCD_MIN = 22
const CD_MIN = 46
const ZIP64_LOCATOR_SIZE = 20
const ZIP64_EOCD_MIN = 56
/** Header id of the zip64 extended information extra field (APPNOTE 4.5.3). */
const ZIP64_EXTRA_ID = 0x0001
const MAX_COMMENT = 0xffff
/** The "look in the zip64 record instead" sentinel, for 32-bit and 16-bit fields respectively. */
const U32_MAX = 0xffffffff
const U16_MAX = 0xffff

/**
 * Every length that reaches an allocation comes out of the archive itself, so a corrupt or
 * hostile one can ask for an impossible buffer — negative, fractional, or simply 2^52 bytes.
 * `new Uint8Array(n)` answers all of those with a bare `RangeError`, which is not the failure
 * contract the rest of the system reads.
 */
function allocate(length: number): Uint8Array<ArrayBuffer> {
  try {
    return new Uint8Array(length)
  } catch {
    throw new AppError('Validation', 'zip declares an impossible length', { length })
  }
}

function readAt(fd: number, position: number, length: number): Uint8Array<ArrayBuffer> {
  // Not merely defensive: a negative `position` means "read from the descriptor's current
  // offset" to `readSync`, so a lying central directory would get plausible bytes from the wrong
  // place rather than an error.
  if (!Number.isSafeInteger(position) || position < 0) {
    throw new AppError('Validation', 'zip declares an impossible offset', { position })
  }
  const buffer = allocate(length)
  let read = 0
  while (read < length) {
    const n = readSync(fd, buffer, read, length - read, position + read)
    if (n === 0) break
    read += n
  }
  if (read !== length) throw new AppError('Validation', 'unexpected end of zip file')
  return buffer
}

/**
 * Zip64 counts sizes and offsets as unsigned 64-bit, which reaches past what a JS number can
 * index exactly. Nothing in this reader can address such an archive anyway — `readSync` takes a
 * number position — so an out-of-range value is rejected here rather than silently rounded into
 * a plausible-looking wrong offset.
 */
function toSafeNumber(value: bigint, what: string): number {
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new AppError('Validation', `zip64 ${what} is too large to read`, { value: String(value) })
  }
  return Number(value)
}

type Zip64End = { total: number; cdSize: number; cdOffset: number }

/**
 * Reads the zip64 end-of-central-directory locator and the record it points at.
 *
 * Called only when the ordinary end-of-central-directory record has saturated a field, so an
 * archive that never needed zip64 never comes through here and parses exactly as it did before
 * zip64 support existed. The locator sits immediately in front of the EOCD it belongs to, which
 * is what makes it findable without scanning: the EOCD's own position is already known.
 */
function readZip64End(fd: number, eocdAt: number, fileSize: number): Zip64End {
  const locatorAt = eocdAt - ZIP64_LOCATOR_SIZE
  if (locatorAt < 0) {
    throw new AppError('Validation', 'zip64 end-of-central-directory locator is missing')
  }
  const locator = readAt(fd, locatorAt, ZIP64_LOCATOR_SIZE)
  const locatorView = new DataView(locator.buffer, locator.byteOffset, locator.byteLength)
  if (locatorView.getUint32(0, true) !== ZIP64_LOCATOR_SIG) {
    throw new AppError('Validation', 'zip64 end-of-central-directory locator is missing')
  }

  const recordAt = toSafeNumber(
    locatorView.getBigUint64(8, true),
    'end-of-central-directory record offset',
  )
  if (recordAt + ZIP64_EOCD_MIN > fileSize) {
    throw new AppError('Validation', 'truncated zip64 end-of-central-directory record')
  }
  const record = readAt(fd, recordAt, ZIP64_EOCD_MIN)
  const view = new DataView(record.buffer, record.byteOffset, record.byteLength)
  if (view.getUint32(0, true) !== ZIP64_EOCD_SIG) {
    throw new AppError('Validation', 'corrupt zip64 end-of-central-directory record')
  }
  return {
    total: toSafeNumber(view.getBigUint64(32, true), 'entry count'),
    cdSize: toSafeNumber(view.getBigUint64(40, true), 'central directory size'),
    cdOffset: toSafeNumber(view.getBigUint64(48, true), 'central directory offset'),
  }
}

type Zip64Sizes = { compressedSize: number; uncompressedSize: number; localHeaderOffset: number }

/**
 * Applies the zip64 extended information extra field of one central-directory entry.
 *
 * The field is positional, not tagged: it holds only those values whose base field is
 * `0xffffffff`, in the fixed order uncompressed size, compressed size, local header offset,
 * disk number — so which 64-bit word means what depends entirely on the base record. Reading it
 * unconditionally, or in a different order, silently mis-assigns offsets on archives that only
 * saturated some of the fields, and the entries in the reference library saturate all three at
 * once precisely because their writer emits zip64 for everything. Hence the base value is both
 * the gate and the default: a field that is not saturated is never taken from here.
 */
function applyZip64Extra(
  view: DataView,
  extraStart: number,
  extraEnd: number,
  base: Zip64Sizes,
): Zip64Sizes {
  let at = extraStart
  while (at + 4 <= extraEnd) {
    const id = view.getUint16(at, true)
    const size = view.getUint16(at + 2, true)
    const body = at + 4
    if (body + size > extraEnd) {
      throw new AppError('Validation', 'corrupt zip extra field')
    }
    if (id !== ZIP64_EXTRA_ID) {
      at = body + size
      continue
    }

    let p = body
    const take = (what: string): number => {
      if (p + 8 > body + size) {
        throw new AppError('Validation', `zip64 extra field is missing the ${what}`)
      }
      const value = toSafeNumber(view.getBigUint64(p, true), what)
      p += 8
      return value
    }
    // Sequential, not an object literal: the order these three run in is the wire format, and a
    // reordering of the literal's properties would be an invisible corruption rather than a
    // compile error.
    const uncompressedSize =
      base.uncompressedSize === U32_MAX ? take('uncompressed size') : base.uncompressedSize
    const compressedSize =
      base.compressedSize === U32_MAX ? take('compressed size') : base.compressedSize
    const localHeaderOffset =
      base.localHeaderOffset === U32_MAX ? take('local header offset') : base.localHeaderOffset
    return { uncompressedSize, compressedSize, localHeaderOffset }
  }
  throw new AppError('Validation', 'zip entry needs a zip64 extra field but has none')
}

export function readZipEntries(path: string): ZipEntry[] {
  const fd = openSync(path, 'r')
  try {
    const size = statSync(path).size
    if (size < EOCD_MIN) throw new AppError('Validation', 'file is too small to be a zip')

    const tailLength = Math.min(size, EOCD_MIN + MAX_COMMENT)
    const tail = readAt(fd, size - tailLength, tailLength)
    // Web-standard DataView over a plain Uint8Array<ArrayBuffer> allocated above; no cast needed.
    const tailView = new DataView(tail.buffer, tail.byteOffset, tail.byteLength)

    let eocd = -1
    for (let i = tail.length - EOCD_MIN; i >= 0; i--) {
      if (tailView.getUint32(i, true) === EOCD_SIG) {
        eocd = i
        break
      }
    }
    if (eocd < 0) throw new AppError('Validation', 'no zip end-of-central-directory record')

    let total = tailView.getUint16(eocd + 10, true)
    let cdSize = tailView.getUint32(eocd + 12, true)
    let cdOffset = tailView.getUint32(eocd + 16, true)
    // A zip64 value is authoritative only where the base field is saturated. Each of the three
    // is gated on its own sentinel because a writer saturates only what it feels like saturating,
    // not only what does not fit: the 28 zip64 files in the reference library are 1,620 B to
    // 7.75 MB — nowhere near needing 64 bits — and saturate the directory offset alone, keeping a
    // real 16-bit entry count and a real 32-bit directory size next to it.
    if (total === U16_MAX || cdSize === U32_MAX || cdOffset === U32_MAX) {
      const end = readZip64End(fd, size - tailLength + eocd, size)
      if (total === U16_MAX) total = end.total
      if (cdSize === U32_MAX) cdSize = end.cdSize
      if (cdOffset === U32_MAX) cdOffset = end.cdOffset
    }
    if (cdOffset + cdSize > size) {
      throw new AppError('Validation', 'zip central directory lies outside the file')
    }

    const cd = readAt(fd, cdOffset, cdSize)
    const view = new DataView(cd.buffer, cd.byteOffset, cd.byteLength)
    const decoder = new TextDecoder()
    const entries: ZipEntry[] = []
    let p = 0

    for (let i = 0; i < total; i++) {
      // The entry count can itself come from a zip64 record, so it is not trusted to agree with
      // the bytes actually present; every field read below is proven in range first.
      if (p + CD_MIN > cd.length || view.getUint32(p, true) !== CD_SIG) {
        throw new AppError('Validation', 'corrupt zip central directory')
      }
      const nameLength = view.getUint16(p + 28, true)
      const extraLength = view.getUint16(p + 30, true)
      const next = p + CD_MIN + nameLength + extraLength + view.getUint16(p + 32, true)
      if (next > cd.length) {
        throw new AppError('Validation', 'corrupt zip central directory')
      }

      const base: Zip64Sizes = {
        compressedSize: view.getUint32(p + 20, true),
        uncompressedSize: view.getUint32(p + 24, true),
        localHeaderOffset: view.getUint32(p + 42, true),
      }
      const sizes =
        base.compressedSize === U32_MAX ||
        base.uncompressedSize === U32_MAX ||
        base.localHeaderOffset === U32_MAX
          ? applyZip64Extra(
              view,
              p + CD_MIN + nameLength,
              p + CD_MIN + nameLength + extraLength,
              base,
            )
          : base

      entries.push({
        method: view.getUint16(p + 10, true),
        compressedSize: sizes.compressedSize,
        uncompressedSize: sizes.uncompressedSize,
        localHeaderOffset: sizes.localHeaderOffset,
        name: decoder.decode(cd.subarray(p + CD_MIN, p + CD_MIN + nameLength)),
        versionMadeBy: view.getUint16(p + 4, true),
        versionNeeded: view.getUint16(p + 6, true),
        flags: view.getUint16(p + 8, true),
        modTime: view.getUint16(p + 12, true),
        modDate: view.getUint16(p + 14, true),
        crc: view.getUint32(p + 16, true),
        internalAttributes: view.getUint16(p + 36, true),
        externalAttributes: view.getUint32(p + 38, true),
      })
      p = next
    }
    return entries
  } finally {
    closeSync(fd)
  }
}

export function findZipEntry(entries: ZipEntry[], name: string): ZipEntry | undefined {
  return entries.find((entry) => entry.name === name)
}

export function readZipEntryBytes(path: string, entry: ZipEntry): Uint8Array {
  const fd = openSync(path, 'r')
  try {
    return readEntryFrom(fd, entry)
  } finally {
    closeSync(fd)
  }
}

export function readZipEntryText(path: string, entry: ZipEntry): string {
  return new TextDecoder().decode(readZipEntryBytes(path, entry))
}

/**
 * Upper bound on a chunk handed to a `readZipEntryChunks` consumer, unless it asks for less.
 *
 * How often this cap does anything is a per-runtime question, and the two runtimes are orders of
 * magnitude apart. Node's `DecompressionStream` emits **1 B–16 KiB** whatever it is fed, so the cap
 * is never reached and every chunk passes through untouched. Deno's emits roughly what one
 * `COMPRESSED_SLICE_BYTES` write expands to — `COMPRESSED_SLICE_BYTES × the entry's local
 * compression ratio` — so it is the *archive* that decides, and this cap is reached routinely.
 * Deno is what the server runs, so re-slicing is a live path there and dead code on Node.
 *
 * That asymmetry is the reason for rule 3 on `readZipEntryChunks`: capping the chunk does not cap
 * what a retained chunk *pins*, because a sub-chunk is a `subarray` of the parent the runtime
 * handed over and the parent is not bounded by this constant.
 */
export const DEFAULT_ZIP_CHUNK_BYTES = 1 << 20

/**
 * How much compressed data is pushed into the inflater at a time — **the knob that bounds the
 * chunked reader's peak memory.**
 *
 * The honest bound is `COMPRESSED_SLICE_BYTES × the entry's compression ratio`, and the *archive*
 * chooses that ratio. The output cap above does not bound it: a write is expanded into the
 * inflater's readable queue before backpressure is observed, so an entry that expands 1000:1
 * makes a 1000× larger queue out of the same write. Measured against a 400 MiB run of zeroes
 * (1029:1, the DEFLATE maximum), one process per run, peak RSS:
 *
 * | compressed slice | Node chunked | Deno chunked |
 * | ---------------- | ------------ | ------------ |
 * | 16 KiB           | —            | 126 MiB      |
 * | 32 KiB (this)    | 81 MiB       | 142 MiB      |
 * | 64 KiB           | —            | 238 MiB      |
 * | 128 KiB          | 81 MiB       | 559 MiB      |
 *
 * Node stays flat because its zlib transform honours the readable's backpressure *within* one
 * write; Deno's does not, so Deno is the runtime this constant is chosen for — and Deno is what
 * ships. 32 KiB costs 2.7% (Node) / 4.6% (Deno) of wall time against 128 KiB on the real 674 MB
 * part, for a 4× tighter adversarial bound, and leaves the real-library peak unmoved (Node 80 vs
 * 83 MiB, Deno 115 vs 115 MiB).
 *
 * The reference library's worst entry is 26.2:1, i.e. ~850 KB of live queue, so none of this is
 * visible on real files — but "constant in the entry size" is only true for realistic ratios, and
 * a caller sizing a memory budget against this reader needs the real bound rather than that one.
 */
const COMPRESSED_SLICE_BYTES = 32 * 1024

export type ZipChunkOptions = {
  /**
   * Upper bound on each yielded chunk. Defaults to `DEFAULT_ZIP_CHUNK_BYTES`.
   *
   * A cap on the *chunk*, not on the reader's memory: the inflater's own queue is bounded by
   * `COMPRESSED_SLICE_BYTES` and the entry's compression ratio, and lowering this only makes the
   * same bytes arrive in more pieces.
   */
  maxChunkBytes?: number
}

/**
 * A zip held open across many reads.
 *
 * `readZipEntryBytes` opens and closes the file for every entry, which is fine for the one
 * or two entries a thumbnail lookup needs but is one syscall pair per file when extracting a
 * whole archive. This keeps a single descriptor for the life of the extraction.
 */
export type OpenZip = {
  entries: ZipEntry[]
  read(entry: ZipEntry): Uint8Array
  /**
   * Streams an entry (see `readZipEntryChunks` for the chunk ownership rules, which apply here
   * too). The zip must stay open for the whole iteration: the generator re-checks on every read,
   * so pulling after `close()` is an `AppError` rather than a read against a recycled descriptor.
   */
  readChunks(entry: ZipEntry, options?: ZipChunkOptions): AsyncGenerator<Uint8Array, void, unknown>
  close(): void
}

export function openZip(path: string): OpenZip {
  const entries = readZipEntries(path)
  const fd = openSync(path, 'r')
  let closed = false
  const requireOpen = (): void => {
    if (closed) throw new AppError('Validation', 'zip is already closed')
  }
  return {
    entries,
    read(entry) {
      requireOpen()
      return readEntryFrom(fd, entry)
    },
    readChunks(entry, options) {
      requireOpen()
      // Checked again before every read inside the generator, not only here. A generator is lazy,
      // so the interesting case is the one where iteration outlives the zip — and a descriptor
      // number is recycled the moment it is closed, so an unguarded read does not fail, it reads
      // *some other file*. Measured: a stored entry pulled after `close()` returned 2 MB of an
      // unrelated file, 30 chunks out of 30 wrong, with no error anywhere.
      return chunksFrom(fd, entry, options, requireOpen)
    },
    close() {
      if (closed) return
      closed = true
      closeSync(fd)
    },
  }
}

/**
 * Whether this file's central directory parses.
 *
 * **It exists to tell "mid-write" from "not a ZIP", which nothing else here can.** `entryHash`
 * falls back to a plain SHA-256 of the bytes when the directory does not parse, which is the
 * right answer for an `.stl` and exactly the wrong one for a `.3mf` a slicer is halfway through
 * writing: the fallback produces a perfectly plausible hash of half a file, and a caller
 * comparing it against a recorded one would report a change that has not finished happening.
 * The desktop watch (`packages/desktop/src/slicers/sessions.ts`) asks this question of any file
 * whose first bytes claim to be a ZIP, and treats a `false` as "not settled yet".
 *
 * It answers about the **directory**, not the payload: an archive whose directory parses and
 * whose entries do not still comes back `true`, and reading one of those throws — which is the
 * same "not settled yet" signal, reached the other way.
 *
 * A file that cannot be opened at all — `EBUSY` while a slicer holds it, `ENOENT` — is `false`
 * too. That is deliberate for the one caller: every reason this can be false is a reason to wait.
 */
export function readsAsZip(path: string): boolean {
  let zip: OpenZip
  try {
    zip = openZip(path)
  } catch {
    return false
  }
  zip.close()
  return true
}

/**
 * Reads one entry as a stream of chunks, each at most `maxChunkBytes`, in order.
 *
 * The point is that a 674 MB model part no longer *has* to be one allocation: a consumer that
 * only needs a sliding window over the bytes — the 3MF marker scan is the one this exists for —
 * can pull chunks and keep a small carry-over, and peak memory stops being a function of the
 * largest entry in the library.
 *
 * **Async, deliberately, while `readZipEntryBytes` stays synchronous.** `DecompressionStream` is
 * the only inflater both runtimes agree on that does not buffer the whole entry, and it is a
 * `TransformStream`, so a chunked read cannot be synchronous whatever the caller would prefer.
 * The alternative — making the one reader async and awaiting it everywhere — would turn
 * `classify3mf`, `extractEmbeddedThumbnail` and every caller of theirs async in order to stream
 * entries that are, in the reference library, a few kilobytes of config XML. So the two paths
 * are kept separate: sync for the callers that genuinely want the whole (small) thing, async for
 * the one caller that must not hold a whole (huge) one.
 *
 * The descriptor is opened on the first pull and closed when the generator finishes — including
 * when a consumer abandons it early, since `for await` calls `return()` on the way out.
 *
 * ## What a chunk is, and how long it is yours
 *
 * 1. **A chunk is a view, and it may alias a buffer far larger than itself.** Deflated chunks come
 *    from the runtime's `DecompressionStream`; where one exceeds `maxChunkBytes` it is handed over
 *    as a `subarray` of it, so the parent stays alive as long as the sub-chunk does — and
 *    `maxChunkBytes` bounds the sub-chunk, not the parent. **Parent size is
 *    `COMPRESSED_SLICE_BYTES × the entry's local compression ratio`, which the archive controls**,
 *    subject to whatever the runtime does with it: Node never exceeds 16 KiB, Deno tracks the
 *    formula. Measured at the current 32 KiB slice — 1 B–16,384 B on Node either way; on Deno
 *    22 B–947,429 B across the whole reference library, and **33,713,376 B (32.2 MiB) for a single
 *    parent** on a 1028.8:1 run of zeroes, which is 32 KiB × 1028.8 to the byte. Stored entries are
 *    the exception — each chunk is a freshly allocated buffer of its own, and nothing is aliased.
 * 2. **Nothing is ever reused.** A chunk stays valid and unchanged for as long as you hold it —
 *    the next pull allocates rather than refilling. Holding one past the loop is safe.
 * 3. **A consumer that retains more than one chunk must copy.** Point 1 is why: keeping N views
 *    keeps N parents, and a parent is up to a megabyte on real files and tens of megabytes on a
 *    compressible one — retention is *not* bounded by the chunk size the consumer asked for. A
 *    sliding window that carries a tail across iterations should `slice()` (a real copy on
 *    `Uint8Array`) the part it keeps, and let the chunk itself go.
 * 4. **Chunks are read-only to the consumer.** Writing into one writes into the parent, which
 *    later sub-chunks of the same parent are still views of.
 */
export async function* readZipEntryChunks(
  path: string,
  entry: ZipEntry,
  options?: ZipChunkOptions,
): AsyncGenerator<Uint8Array, void, unknown> {
  const fd = openSync(path, 'r')
  try {
    yield* chunksFrom(fd, entry, options)
  } finally {
    closeSync(fd)
  }
}

/** The body of readZipEntryBytes, against an already-open descriptor. */
function readEntryFrom(fd: number, entry: ZipEntry): Uint8Array {
  const data = readAt(fd, dataOffsetOf(fd, entry), entry.compressedSize)
  if (entry.method === 0) {
    assertDeclaredSize(data.byteLength, entry.uncompressedSize)
    return data
  }
  if (entry.method === 8) return inflateEntry(data, entry.uncompressedSize)
  throw new AppError('Validation', `unsupported zip compression method ${entry.method}`)
}

/**
 * Where an entry's data starts: past its local header, whose name and extra field lengths are
 * its own and routinely differ from the central directory's copy.
 */
function dataOffsetOf(fd: number, entry: ZipEntry): number {
  const header = readAt(fd, entry.localHeaderOffset, 30)
  const view = new DataView(header.buffer, header.byteOffset, header.byteLength)
  if (view.getUint32(0, true) !== LOCAL_SIG) {
    throw new AppError('Validation', 'corrupt zip local header')
  }
  return entry.localHeaderOffset + 30 + view.getUint16(26, true) + view.getUint16(28, true)
}

/** zlib rejects anything below this; an empty entry would otherwise ask for a 0-byte chunk. */
const MIN_INFLATE_CHUNK = 64
/**
 * Ceiling on the sizing hint below. Past it the hint stops being a saving and starts being a way
 * for a lying central directory to demand an arbitrary allocation; an entry genuinely larger
 * than this simply falls back to zlib's grow-and-concat, which is what every entry used to do.
 */
const MAX_INFLATE_CHUNK = 1 << 30

/**
 * Inflates one entry into a single buffer, sized up front.
 *
 * Two copies used to be live here at once, and only one of them was visible in this file.
 *
 * The visible one was `new Uint8Array(inflateRawSync(data))`, which copies. The invisible one is
 * inside zlib: it inflates into `chunkSize` buffers — 16 KB by default — and `Buffer.concat`s
 * them at the end, so the finished entry and the pieces it was assembled from are both alive
 * across that concat. Sizing the chunk to the declared uncompressed size makes it one piece, and
 * `concat` of one piece of exactly the right length is the only case that does not copy. Measured
 * on the reference library: the 674 MB model part went from 2161 MB of peak RSS to 934 MB, and
 * the 466 MB one from 1083 MB to 664 MB.
 *
 * The re-copy was **not** load-bearing for correctness, but the *type* it produced is worth
 * keeping, so it is replaced by a view rather than simply dropped. `inflateRawSync` returns a
 * `node:buffer` `Buffer` on both Node and Deno. `Buffer` is a `Uint8Array` subclass with three
 * traps for anything downstream: `slice` returns a view where `Uint8Array.prototype.slice`
 * returns a copy, `toString` decodes UTF-8 where `Uint8Array`'s joins decimal digits, and for
 * results at or under 4 KB Node hands back a window into a shared 64 KB pool, so `.buffer` is
 * emphatically not the entry (measured: `byteOffset` 17184 of a 65536-byte `ArrayBuffer`). The
 * view below costs nothing, copies nothing, and closes all three: a real `Uint8Array`, and the
 * `byteOffset`/`byteLength` that every `DataView` in this codebase already passes along.
 *
 * The result is checked against the declared size, which is not merely tidiness: the central
 * directory's `uncompressedSize` is what `projects/import-zip.ts` charges against a user's quota
 * *before* extracting, while the bytes it then writes are these. Unchecked, an archive that
 * declares 3 bytes and inflates to 300 MB passes the quota gate and writes 300 MB. All 11 361
 * entries in the reference library agree with their declaration exactly.
 */
function inflateEntry(data: Uint8Array, uncompressedSize: number): Uint8Array {
  const chunkSize = Math.min(Math.max(uncompressedSize, MIN_INFLATE_CHUNK), MAX_INFLATE_CHUNK)
  let inflated
  try {
    inflated = inflateRawSync(data, { chunkSize })
  } catch (error) {
    throw new AppError('Validation', 'zip entry could not be inflated', { cause: String(error) })
  }
  assertDeclaredSize(inflated.byteLength, uncompressedSize)
  return new Uint8Array(inflated.buffer, inflated.byteOffset, inflated.byteLength)
}

/** Shared by the stored and deflated paths, hence "yields" rather than "inflates to". */
function assertDeclaredSize(actual: number, declared: number): void {
  if (actual !== declared) {
    throw new AppError('Validation', 'zip entry does not yield its declared uncompressed size', {
      declared,
      actual,
    })
  }
}

/**
 * The body of readZipEntryChunks, against an already-open descriptor.
 *
 * `requireOpen` is re-checked before every read rather than once at the start, because a
 * generator's reads happen whenever the consumer pulls — possibly after the owner has closed the
 * zip underneath it. See the note in `openZip`.
 */
async function* chunksFrom(
  fd: number,
  entry: ZipEntry,
  options?: ZipChunkOptions,
  requireOpen: () => void = () => {},
): AsyncGenerator<Uint8Array, void, unknown> {
  const maxChunkBytes = Math.max(1, options?.maxChunkBytes ?? DEFAULT_ZIP_CHUNK_BYTES)
  if (entry.method !== 0 && entry.method !== 8) {
    throw new AppError('Validation', `unsupported zip compression method ${entry.method}`)
  }
  requireOpen()
  const dataOffset = dataOffsetOf(fd, entry)

  if (entry.method === 0) {
    // Stored: the file *is* the output, so it is read straight out at the caller's chunk size
    // and never passes through an inflater at all.
    assertDeclaredSize(entry.compressedSize, entry.uncompressedSize)
    for (let at = 0; at < entry.compressedSize; at += maxChunkBytes) {
      requireOpen()
      yield readAt(fd, dataOffset + at, Math.min(maxChunkBytes, entry.compressedSize - at))
    }
    return
  }

  const stream = new DecompressionStream('deflate-raw')
  const writer = stream.writable.getWriter()
  const reader = stream.readable.getReader()

  // Only a failure to *read* the archive is recorded here. Anything the stream itself throws —
  // and the writer rejects with the same error the reader does, once the inflater has failed —
  // is not a source failure and must not be mistaken for one: it becomes the AppError below
  // rather than escaping as zlib's bare `TypeError`.
  let sourceFailed = false
  let sourceError: unknown
  let produced = 0

  // The compressed side runs as its own task rather than inline. `writer.ready` only resolves
  // once the inflater's output queue has drained, and only this generator's consumer drains it,
  // so writing and reading from one sequential loop would deadlock on the first full queue.
  const pump = (async () => {
    try {
      for (let at = 0; at < entry.compressedSize; at += COMPRESSED_SLICE_BYTES) {
        const length = Math.min(COMPRESSED_SLICE_BYTES, entry.compressedSize - at)
        let slice
        try {
          requireOpen()
          slice = readAt(fd, dataOffset + at, length)
        } catch (error) {
          sourceFailed = true
          sourceError = error
          throw error
        }
        await writer.ready
        await writer.write(slice)
      }
      await writer.close()
    } catch (error) {
      // Errors on the compressed side (a short read, a bad offset) have to reach the consumer,
      // and the consumer is only ever awaiting the readable. Aborting the writable is what
      // carries them across.
      await writer.abort(error).catch(() => {})
      throw error
    }
  })()
  // Settled immediately rather than only where it is awaited, so a compressed-side failure is
  // never momentarily an unhandled rejection.
  const pumpDone = pump.then(
    () => {},
    () => {},
  )

  try {
    for (;;) {
      let result
      try {
        result = await reader.read()
      } catch (error) {
        // The readable reports only that the stream was aborted; if the compressed side is what
        // went wrong, it holds the AppError that says so, so wait for it to settle first.
        await pumpDone
        if (sourceFailed) throw sourceError
        throw new AppError('Validation', 'zip entry could not be inflated', {
          cause: String(error),
        })
      }
      if (result.done) break
      const chunk = result.value
      produced += chunk.byteLength
      // Live code on Deno, where a chunk is `COMPRESSED_SLICE_BYTES × the entry's compression
      // ratio` — under a megabyte on real files, 32 MiB on a 1029:1 one — and unreachable on
      // Node, whose largest is 16 KiB. A sub-chunk keeps the whole parent alive, which is what
      // rule 3 on `readZipEntryChunks` is about: this bounds the chunk, not the retention.
      if (chunk.byteLength <= maxChunkBytes) {
        yield chunk
      } else {
        for (let at = 0; at < chunk.byteLength; at += maxChunkBytes) {
          yield chunk.subarray(at, Math.min(at + maxChunkBytes, chunk.byteLength))
        }
      }
    }
    // The readable finished, so the whole entry came out; the compressed side can only still be
    // holding a read failure, which would mean the two disagree about how much data there was.
    await pumpDone
    if (sourceFailed) throw sourceError
    // Same contract as the buffered path: what came out has to be what the central directory
    // declared, because that declaration is what the caller sized its budget (and its quota) on.
    assertDeclaredSize(produced, entry.uncompressedSize)
  } finally {
    // Covers the abandoned-early case: cancelling the readable and aborting the writable unblock
    // a pump parked on `writer.ready`, so it cannot outlive the generator holding the descriptor.
    await reader.cancel().catch(() => {})
    await writer.abort().catch(() => {})
    await pumpDone
  }
}
