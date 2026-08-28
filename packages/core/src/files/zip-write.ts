import { closeSync, openSync, readSync, unlinkSync, writeSync } from 'node:fs'
import { AppError } from '@spm/contract/errors.ts'
import { readZipEntries, type ZipEntry } from './zip.ts'

/**
 * The ZIP *writer* side, beside the reader in `zip.ts`.
 *
 * Two things live here and they are deliberately in one file:
 *
 * 1. **The header layouts and the CRC-32.** `packages/core/test/fixtures/make-3mf.ts` builds
 *    archives from scratch with fresh compression and this module rewrites existing ones without
 *    touching their payloads — different jobs, but the same three records on the wire and the same
 *    CRC polynomial. They used to be written out twice; the fixture now imports them from here so
 *    the repo has one table and one layout to keep right.
 * 2. **`rewriteZip`**, an entry-preserving rewriter: drop some entries, replace the bytes of
 *    others, copy the rest **compressed-bytes-verbatim**, and emit a fresh directory around what
 *    survives.
 *
 * ## What a rewritten archive keeps, and what it does not
 *
 * Kept, per entry: the name, the compression method and the compressed bytes exactly as they lay
 * in the input, the CRC-32, the DOS modification time and date, the version-made-by /
 * version-needed pair, the internal and external attribute words, and every general-purpose flag
 * bit except bit 3.
 *
 * **Not kept, and this is a decision rather than an oversight:**
 *
 * - **Extra fields.** An input extra field can be a zip64 extended-information record, and this
 *   writer emits a non-zip64 directory, so carrying extras across unfiltered would leave a record
 *   contradicting the base fields beside it. Filtering by header id would then have to understand
 *   every id it kept. Dropping all of them is the only rule that is right for every input. The
 *   cost is the high-resolution NTFS/Unix timestamp extras some writers add; the DOS timestamp in
 *   the record proper survives, and nothing in this system reads either.
 * - **Entry comments.** Same argument, smaller: no 3MF writer emits one, and a comment is not part
 *   of any part's payload.
 * - **The archive comment.** The EOCD is rebuilt with none.
 *
 * ## Order
 *
 * Surviving entries are emitted in **ascending input local-header offset** — the order the entries
 * physically lay in the input file, which is not necessarily central-directory order. That is what
 * makes "`[Content_Types].xml` stays first" true rather than hoped for: OPC requires the
 * content-types item to be the first item in the package, and it is first *positionally*. A
 * rewriter that walked the central directory instead would move it whenever the two orders
 * disagreed, and nothing about a ZIP requires them to agree.
 */

const LOCAL_SIG = 0x04034b50
const CD_SIG = 0x02014b50
const EOCD_SIG = 0x06054b50
const LOCAL_MIN = 30
const CD_MIN = 46
const EOCD_MIN = 22
/** Bit 0: the entry is encrypted. Refused — this writer cannot reproduce what it cannot read. */
const FLAG_ENCRYPTED = 1 << 0
/** Bit 3: sizes and CRC live in a data descriptor after the payload. Cleared; see `rewriteZip`. */
const FLAG_DATA_DESCRIPTOR = 1 << 3
const U32_MAX = 0xffffffff
/**
 * `0xffff` in the EOCD's entry count is the "read the zip64 record instead" sentinel, so an
 * archive with exactly that many entries is not representable by a non-zip64 EOCD even though the
 * field is wide enough to hold the number.
 */
const MAX_NON_ZIP64_ENTRIES = 0xffff - 1
/** One linear copy, a megabyte at a time; nothing here holds a whole entry in memory. */
const COPY_CHUNK_BYTES = 1 << 20
const EMPTY = new Uint8Array(0)

const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let i = 0; i < 256; i++) {
    let c = i
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[i] = c >>> 0
  }
  return table
})()

export function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff
  for (const byte of bytes) c = CRC_TABLE[(c ^ byte) & 0xff]! ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

/** The fields a local file header and a central directory record share, in wire order. */
export type ZipCommonFields = {
  versionNeeded: number
  flags: number
  method: number
  modTime: number
  modDate: number
  crc: number
  compressedSize: number
  uncompressedSize: number
  name: Uint8Array
  /** Written verbatim after the name. `rewriteZip` never emits one; the fixture's zip64 does. */
  extra?: Uint8Array
}

export type ZipCentralFields = ZipCommonFields & {
  versionMadeBy: number
  internalAttributes: number
  externalAttributes: number
  localHeaderOffset: number
}

/**
 * A local file header. Callers pass the values they want on the wire, saturation sentinels
 * included — this function is a layout, not a policy.
 */
export function localHeaderBytes(fields: ZipCommonFields): Uint8Array<ArrayBuffer> {
  const extra = fields.extra ?? EMPTY
  const out = new Uint8Array(LOCAL_MIN + fields.name.length + extra.length)
  const view = new DataView(out.buffer)
  view.setUint32(0, LOCAL_SIG, true)
  view.setUint16(4, fields.versionNeeded, true)
  view.setUint16(6, fields.flags, true)
  view.setUint16(8, fields.method, true)
  view.setUint16(10, fields.modTime, true)
  view.setUint16(12, fields.modDate, true)
  view.setUint32(14, fields.crc, true)
  view.setUint32(18, fields.compressedSize, true)
  view.setUint32(22, fields.uncompressedSize, true)
  view.setUint16(26, fields.name.length, true)
  view.setUint16(28, extra.length, true)
  out.set(fields.name, LOCAL_MIN)
  out.set(extra, LOCAL_MIN + fields.name.length)
  return out
}

/** A central directory record. Same contract as `localHeaderBytes`: layout, not policy. */
export function centralHeaderBytes(fields: ZipCentralFields): Uint8Array<ArrayBuffer> {
  const extra = fields.extra ?? EMPTY
  const out = new Uint8Array(CD_MIN + fields.name.length + extra.length)
  const view = new DataView(out.buffer)
  view.setUint32(0, CD_SIG, true)
  view.setUint16(4, fields.versionMadeBy, true)
  view.setUint16(6, fields.versionNeeded, true)
  view.setUint16(8, fields.flags, true)
  view.setUint16(10, fields.method, true)
  view.setUint16(12, fields.modTime, true)
  view.setUint16(14, fields.modDate, true)
  view.setUint32(16, fields.crc, true)
  view.setUint32(20, fields.compressedSize, true)
  view.setUint32(24, fields.uncompressedSize, true)
  view.setUint16(28, fields.name.length, true)
  view.setUint16(30, extra.length, true)
  view.setUint16(36, fields.internalAttributes, true)
  view.setUint32(38, fields.externalAttributes, true)
  view.setUint32(42, fields.localHeaderOffset, true)
  out.set(fields.name, CD_MIN)
  out.set(extra, CD_MIN + fields.name.length)
  return out
}

/** A non-zip64 end-of-central-directory record, with no archive comment. */
export function endOfCentralDirectoryBytes(fields: {
  total: number
  cdSize: number
  cdOffset: number
}): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(EOCD_MIN)
  const view = new DataView(out.buffer)
  view.setUint32(0, EOCD_SIG, true)
  view.setUint16(8, fields.total, true)
  view.setUint16(10, fields.total, true)
  view.setUint32(12, fields.cdSize, true)
  view.setUint32(16, fields.cdOffset, true)
  return out
}

export type ZipRewrite = {
  /** Entry names to leave out. A name that is not in the archive is not an error. */
  drop?: ReadonlySet<string>
  /**
   * Entry names whose payload is replaced. The replacement is written **`stored`**, with a
   * **recomputed** CRC-32 and fresh sizes: carrying the original CRC across is the easy mistake,
   * and it produces an archive most readers open happily until one does not. A name that is not
   * in the archive **is** an error — silently writing nothing is how a typo survives review.
   */
  replace?: ReadonlyMap<string, Uint8Array>
}

export type ZipRewriteResult = {
  /** Names written, in output (= input positional) order. */
  kept: string[]
  /** Names present in the input and left out, in input positional order. */
  dropped: string[]
  /** Names whose bytes were replaced, in input positional order. */
  replaced: string[]
}

/**
 * Writes a copy of `inputPath` at `outputPath` with `rewrite` applied.
 *
 * Surviving entries keep their compressed bytes byte-for-byte: no decompress/recompress round
 * trip, `stored` and `deflate` alike, and the whole operation costs one linear copy of the parts
 * that survive.
 *
 * **General-purpose flags.** Bit 3 is cleared, because this writer puts real sizes in the local
 * header and emits no data descriptor. It can do that for *any* input, descriptor-bearing ones
 * included, because the sizes come from the central directory, which carries them whether or not
 * the local header did — that is the same fact `zip.ts` already relies on to read such an entry.
 * Bit 11 (UTF-8 names) and every other bit are copied, since they describe the bytes being copied.
 *
 * **zip64.** The output is always non-zip64. That is a capability, not a limitation: the 28 zip64
 * files in the reference library (`previews/handlers.ts`) run 1,620 B to 7.75 MB, so every size,
 * offset and count fits its 32- or 16-bit field with room to spare, and a rewriter that builds the
 * directory from values it has already parsed can simply emit the plain form. An earlier draft of
 * the spec refused zip64 outright; that was wrong by a wide margin.
 *
 * **Refusals**, both `AppError('Validation', …)` with a `reason` in `details`:
 *
 * - `'encrypted'` — an entry with general-purpose bit 0 set. Its bytes cannot be reproduced
 *   without the key, and a strong-encryption entry (bit 6) sets bit 0 too.
 * - `'unrepresentable'` — a value that genuinely does not fit the non-zip64 form: an entry or
 *   directory over 4 GiB - 1, an output offset past it, or 65,535 entries or more.
 *
 * Nothing else is a reason to refuse. Every check runs before the output file is created, so a
 * refusal leaves nothing behind; a failure *during* the copy unlinks what it had written.
 */
export function rewriteZip(
  inputPath: string,
  outputPath: string,
  rewrite: ZipRewrite = {},
): ZipRewriteResult {
  const drop = rewrite.drop ?? new Set<string>()
  const replace = rewrite.replace ?? new Map<string, Uint8Array>()
  const encoder = new TextEncoder()

  // Positional order, not central-directory order. See the file header: this is the whole of the
  // "[Content_Types].xml stays first" guarantee.
  const entries = readZipEntries(inputPath).sort(
    (a, b) => a.localHeaderOffset - b.localHeaderOffset,
  )

  const known = new Set(entries.map((entry) => entry.name))
  for (const name of replace.keys()) {
    if (!known.has(name)) {
      throw new AppError('Validation', 'replacement names an entry the archive does not have', {
        reason: 'unrepresentable',
        entry: name,
      })
    }
  }

  const dropped: string[] = []
  const replaced: string[] = []
  const plan: PlannedEntry[] = []
  let offset = 0

  for (const entry of entries) {
    if (drop.has(entry.name)) {
      dropped.push(entry.name)
      continue
    }
    if ((entry.flags & FLAG_ENCRYPTED) !== 0) {
      throw new AppError('Validation', 'zip entry is encrypted', {
        reason: 'encrypted',
        entry: entry.name,
      })
    }

    const name = encoder.encode(entry.name)
    const replacement = replace.get(entry.name)
    if (replacement) replaced.push(entry.name)
    const fields: ZipCentralFields = {
      versionMadeBy: entry.versionMadeBy,
      versionNeeded: entry.versionNeeded,
      // Bit 3 goes; everything else, bit 11 included, describes bytes we are copying unchanged.
      flags: entry.flags & ~FLAG_DATA_DESCRIPTOR,
      method: replacement ? 0 : entry.method,
      modTime: entry.modTime,
      modDate: entry.modDate,
      crc: replacement ? crc32(replacement) : entry.crc,
      compressedSize: replacement ? replacement.length : entry.compressedSize,
      uncompressedSize: replacement ? replacement.length : entry.uncompressedSize,
      name,
      internalAttributes: entry.internalAttributes,
      externalAttributes: entry.externalAttributes,
      localHeaderOffset: offset,
    }
    fitsOrRefuse(entry.name, fields)
    plan.push({ source: entry, fields, replacement })
    offset += LOCAL_MIN + name.length + fields.compressedSize
  }

  if (plan.length > MAX_NON_ZIP64_ENTRIES) {
    throw new AppError('Validation', 'too many zip entries for a non-zip64 directory', {
      reason: 'unrepresentable',
      total: plan.length,
    })
  }
  const central = plan.map((planned) => centralHeaderBytes(planned.fields))
  const cdSize = central.reduce((n, record) => n + record.length, 0)
  if (offset >= U32_MAX || cdSize >= U32_MAX) {
    throw new AppError('Validation', 'zip is too large for a non-zip64 directory', {
      reason: 'unrepresentable',
      cdOffset: offset,
      cdSize,
    })
  }

  writeArchive(inputPath, outputPath, plan, central, {
    total: plan.length,
    cdSize,
    cdOffset: offset,
  })
  return { kept: plan.map((planned) => planned.source.name), dropped, replaced }
}

type PlannedEntry = {
  source: ZipEntry
  fields: ZipCentralFields
  replacement: Uint8Array | undefined
}

/**
 * `>=`, not `>`. `0xffffffff` is the "look in the zip64 record instead" sentinel, so a value that
 * happens to be exactly that is *not* representable by a plain record even though the field is
 * wide enough to hold it: writing it would send a reader looking for an extra field this writer
 * does not emit. The same reasoning as `MAX_NON_ZIP64_ENTRIES`, one field wider.
 */
function fitsOrRefuse(name: string, fields: ZipCentralFields): void {
  const oversized =
    fields.compressedSize >= U32_MAX ||
    fields.uncompressedSize >= U32_MAX ||
    fields.localHeaderOffset >= U32_MAX
  if (oversized) {
    throw new AppError('Validation', 'zip entry is too large for a non-zip64 directory', {
      reason: 'unrepresentable',
      entry: name,
    })
  }
}

function writeArchive(
  inputPath: string,
  outputPath: string,
  plan: PlannedEntry[],
  central: Uint8Array[],
  end: { total: number; cdSize: number; cdOffset: number },
): void {
  const input = openSync(inputPath, 'r')
  let output: number | undefined
  try {
    output = openSync(outputPath, 'w')
    for (const planned of plan) {
      writeAll(output, localHeaderBytes(planned.fields))
      if (planned.replacement) {
        writeAll(output, planned.replacement)
      } else {
        copyEntryData(input, output, planned.source)
      }
    }
    for (const record of central) writeAll(output, record)
    writeAll(output, endOfCentralDirectoryBytes(end))
  } catch (error) {
    // A half-written archive is worse than none: the next step re-classifies the output, and a
    // truncated file would classify `other` and be reported as the wrong kind of failure.
    if (output !== undefined) {
      closeSync(output)
      output = undefined
    }
    try {
      unlinkSync(outputPath)
    } catch {
      // Nothing to clean up, or the platform will not let us; the original error is what matters.
    }
    throw error
  } finally {
    closeSync(input)
    if (output !== undefined) closeSync(output)
  }
}

/** Copies one entry's compressed payload across, a bounded slice at a time. */
function copyEntryData(input: number, output: number, entry: ZipEntry): void {
  const from = dataOffsetOf(input, entry)
  const buffer = new Uint8Array(Math.min(COPY_CHUNK_BYTES, Math.max(entry.compressedSize, 1)))
  for (let at = 0; at < entry.compressedSize; at += buffer.length) {
    const length = Math.min(buffer.length, entry.compressedSize - at)
    readExactly(input, from + at, buffer, length)
    writeAll(output, buffer.subarray(0, length))
  }
}

/**
 * Where an entry's data starts. The local header's own name and extra lengths are read rather
 * than the central directory's copy, because the two routinely differ — the same reason `zip.ts`
 * does this for reading.
 */
function dataOffsetOf(fd: number, entry: ZipEntry): number {
  const header = new Uint8Array(LOCAL_MIN)
  readExactly(fd, entry.localHeaderOffset, header, LOCAL_MIN)
  const view = new DataView(header.buffer)
  if (view.getUint32(0, true) !== LOCAL_SIG) {
    throw new AppError('Validation', 'corrupt zip local header', {
      reason: 'unrepresentable',
      entry: entry.name,
    })
  }
  return entry.localHeaderOffset + LOCAL_MIN + view.getUint16(26, true) + view.getUint16(28, true)
}

function readExactly(fd: number, position: number, into: Uint8Array, length: number): void {
  let read = 0
  while (read < length) {
    const n = readSync(fd, into, read, length - read, position + read)
    if (n === 0) break
    read += n
  }
  if (read !== length) throw new AppError('Validation', 'unexpected end of zip file')
}

/** `writeSync` is allowed to write less than it was given; nothing in this file may assume it did not. */
function writeAll(fd: number, bytes: Uint8Array): void {
  let written = 0
  while (written < bytes.length) {
    written += writeSync(fd, bytes, written, bytes.length - written)
  }
}
