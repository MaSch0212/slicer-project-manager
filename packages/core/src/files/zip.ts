import { closeSync, openSync, readSync, statSync } from 'node:fs'
import { inflateRawSync } from 'node:zlib'
import { AppError } from '@spm/contract/errors.ts'

export type ZipEntry = {
  name: string
  method: number
  compressedSize: number
  uncompressedSize: number
  localHeaderOffset: number
}

const EOCD_SIG = 0x06054b50
const CD_SIG = 0x02014b50
const LOCAL_SIG = 0x04034b50
const EOCD_MIN = 22
const MAX_COMMENT = 0xffff

function readAt(fd: number, position: number, length: number): Uint8Array {
  const buffer = new Uint8Array(length)
  let read = 0
  while (read < length) {
    const n = readSync(fd, buffer, read, length - read, position + read)
    if (n === 0) break
    read += n
  }
  if (read !== length) throw new AppError('Validation', 'unexpected end of zip file')
  return buffer
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

    const total = tailView.getUint16(eocd + 10, true)
    const cdSize = tailView.getUint32(eocd + 12, true)
    const cdOffset = tailView.getUint32(eocd + 16, true)
    if (cdOffset === 0xffffffff)
      throw new AppError('Validation', 'zip64 archives are not supported')

    const cd = readAt(fd, cdOffset, cdSize)
    const view = new DataView(cd.buffer, cd.byteOffset, cd.byteLength)
    const decoder = new TextDecoder()
    const entries: ZipEntry[] = []
    let p = 0

    for (let i = 0; i < total; i++) {
      if (view.getUint32(p, true) !== CD_SIG) {
        throw new AppError('Validation', 'corrupt zip central directory')
      }
      const nameLength = view.getUint16(p + 28, true)
      entries.push({
        method: view.getUint16(p + 10, true),
        compressedSize: view.getUint32(p + 20, true),
        uncompressedSize: view.getUint32(p + 24, true),
        localHeaderOffset: view.getUint32(p + 42, true),
        name: decoder.decode(cd.subarray(p + 46, p + 46 + nameLength)),
      })
      p += 46 + nameLength + view.getUint16(p + 30, true) + view.getUint16(p + 32, true)
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
    const header = readAt(fd, entry.localHeaderOffset, 30)
    const view = new DataView(header.buffer, header.byteOffset, header.byteLength)
    if (view.getUint32(0, true) !== LOCAL_SIG) {
      throw new AppError('Validation', 'corrupt zip local header')
    }
    const dataOffset =
      entry.localHeaderOffset + 30 + view.getUint16(26, true) + view.getUint16(28, true)
    const data = readAt(fd, dataOffset, entry.compressedSize)

    if (entry.method === 0) return data
    if (entry.method === 8) return new Uint8Array(inflateRawSync(data))
    throw new AppError('Validation', `unsupported zip compression method ${entry.method}`)
  } finally {
    closeSync(fd)
  }
}

export function readZipEntryText(path: string, entry: ZipEntry): string {
  return new TextDecoder().decode(readZipEntryBytes(path, entry))
}
