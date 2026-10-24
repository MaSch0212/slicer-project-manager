import { readFileSync, writeFileSync } from 'node:fs'

/**
 * Post-hoc surgery on an archive `make-3mf.ts` already wrote.
 *
 * Separate from `make-3mf.ts` on purpose. That fixture builds well-formed archives and its surface
 * is depended on across four packages; these produce archives no writer here would emit —
 * general-purpose flags a `writeZip` caller cannot set, wall-clock timestamps, a central directory
 * whose order disagrees with the file's — which is exactly what the rewriter and the change
 * detector have to be right about.
 *
 * Non-zip64 inputs only, and no archive comment: everything here is written by `writeZip`, whose
 * end-of-central-directory record is the last 22 bytes of the file.
 */

const CD_SIG = 0x02014b50
const EOCD_SIG = 0x06054b50
const CD_MIN = 46
const EOCD_MIN = 22

export type ZipHeaderPatch = {
  name: string
  /** A view over the whole file; writes through it land in the file when the patch returns. */
  file: DataView
  /** Offset of this entry's central directory record. */
  centralAt: number
  /** Offset of this entry's local file header. */
  localAt: number
}

/** Calls `edit` once per entry, in central-directory order, then writes the file back. */
export function patchZipHeaders(path: string, edit: (entry: ZipHeaderPatch) => void): void {
  const bytes = new Uint8Array(readFileSync(path))
  const file = new DataView(bytes.buffer)
  for (const record of centralRecords(bytes, file)) {
    edit({
      name: record.name,
      file,
      centralAt: record.at,
      localAt: file.getUint32(record.at + 42, true),
    })
  }
  writeFileSync(path, bytes)
}

/**
 * Reverses the order of the central directory's records, leaving every local header and payload
 * exactly where it was.
 *
 * The result is a perfectly legal archive whose directory order is the opposite of its physical
 * order — the shape that catches a rewriter emitting entries in the order it read them rather than
 * the order they lie in, which is how `[Content_Types].xml` silently stops being first.
 */
export function reverseCentralDirectory(path: string): void {
  const bytes = new Uint8Array(readFileSync(path))
  const file = new DataView(bytes.buffer)
  const eocdAt = bytes.length - EOCD_MIN
  const cdOffset = file.getUint32(eocdAt + 16, true)
  const records = centralRecords(bytes, file).map((record) =>
    bytes.slice(record.at, record.at + record.length),
  )
  let at = cdOffset
  for (const record of records.reverse()) {
    bytes.set(record, at)
    at += record.length
  }
  writeFileSync(path, bytes)
}

function centralRecords(
  bytes: Uint8Array,
  file: DataView,
): { name: string; at: number; length: number }[] {
  const eocdAt = bytes.length - EOCD_MIN
  if (file.getUint32(eocdAt, true) !== EOCD_SIG) {
    throw new Error('patch-zip expects an archive with no comment and no zip64 records')
  }
  const total = file.getUint16(eocdAt + 10, true)
  const decoder = new TextDecoder()
  const records: { name: string; at: number; length: number }[] = []
  let at = file.getUint32(eocdAt + 16, true)
  for (let i = 0; i < total; i++) {
    if (file.getUint32(at, true) !== CD_SIG) throw new Error('corrupt central directory')
    const nameLength = file.getUint16(at + 28, true)
    const length =
      CD_MIN + nameLength + file.getUint16(at + 30, true) + file.getUint16(at + 32, true)
    records.push({
      name: decoder.decode(bytes.subarray(at + CD_MIN, at + CD_MIN + nameLength)),
      at,
      length,
    })
    at += length
  }
  return records
}
