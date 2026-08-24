import { writeFileSync } from 'node:fs'
import { deflateRawSync } from 'node:zlib'

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

export function concatBytes(parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((n, p) => n + p.length, 0)
  const out = new Uint8Array(total)
  let at = 0
  for (const part of parts) {
    out.set(part, at)
    at += part.length
  }
  return out
}

export type ZipInput = { name: string; data: string | Uint8Array; deflate?: boolean }

const U32_MAX = 0xffffffff
const U16_MAX = 0xffff

/**
 * Which parts of the archive are written in zip64 form.
 *
 * Split into independent switches rather than one "zip64" flag because that is exactly the
 * property the reader has to get right: a zip64 value is authoritative only where its base field
 * says `0xffffffff`, and the failure mode of getting it wrong — reading the extra field
 * unconditionally, or in the wrong order — is a *plausible* wrong offset rather than a crash. The
 * 28 zip64 files in the reference library saturate the EOCD's directory offset and every entry's
 * sizes and offset, while leaving a real 16-bit entry count and a real 32-bit directory size
 * beside them, so `saturateCdOffset` + `saturateEntries` reproduces the real shape and each other
 * switch exists to pin one field's gate on its own.
 */
export type Zip64Options = {
  /** Emit the zip64 end-of-central-directory record and its locator. */
  end?: boolean
  /** Write `0xffffffff` for the EOCD's central-directory offset. */
  saturateCdOffset?: boolean
  /** Write `0xffffffff` for the EOCD's central-directory size. */
  saturateCdSize?: boolean
  /** Write `0xffff` for the EOCD's entry count. */
  saturateTotal?: boolean
  /**
   * Write `0xffffffff` for each entry's compressed size, uncompressed size and local header
   * offset, and put the real values in a zip64 extended information extra field.
   */
  saturateEntries?: boolean
  /**
   * Saturate each entry's local header offset *only*, so its zip64 extra field holds one 64-bit
   * word. This is the case that catches a reader which takes the words positionally without
   * consulting the base record: the first word here is the offset, not the uncompressed size.
   */
  saturateEntryOffsetOnly?: boolean
}

export function writeZip(path: string, entries: ZipInput[], zip64?: Zip64Options): void {
  const encoder = new TextEncoder()
  const body: Uint8Array[] = []
  const central: Uint8Array[] = []
  let offset = 0

  for (const entry of entries) {
    const raw = typeof entry.data === 'string' ? encoder.encode(entry.data) : entry.data
    const method = entry.deflate ? 8 : 0
    const stored = entry.deflate ? new Uint8Array(deflateRawSync(raw)) : raw
    const name = encoder.encode(entry.name)
    const checksum = crc32(raw)

    const local = new Uint8Array(30 + name.length)
    const lv = new DataView(local.buffer)
    lv.setUint32(0, 0x04034b50, true)
    lv.setUint16(4, 20, true)
    lv.setUint16(8, method, true)
    lv.setUint32(14, checksum, true)
    lv.setUint32(18, stored.length, true)
    lv.setUint32(22, raw.length, true)
    lv.setUint16(26, name.length, true)
    local.set(name, 30)
    body.push(local, stored)

    // The zip64 extended information extra field is positional: uncompressed size, then
    // compressed size, then local header offset, and only for the fields the base record
    // saturated. All three are saturated together here, which is what a real producer does.
    const extraWords = zip64?.saturateEntries ? 3 : zip64?.saturateEntryOffsetOnly ? 1 : 0
    const extraLength = extraWords === 0 ? 0 : 4 + extraWords * 8
    const cd = new Uint8Array(46 + name.length + extraLength)
    const cv = new DataView(cd.buffer)
    cv.setUint32(0, 0x02014b50, true)
    // 4.5 ("45") is the version that introduced zip64; a plain archive keeps the 2.0 it always
    // claimed, so a fixture built without zip64 options is byte-for-byte the file it was before.
    const version = extraWords === 0 ? 20 : 45
    cv.setUint16(4, version, true)
    cv.setUint16(6, version, true)
    cv.setUint16(10, method, true)
    cv.setUint32(16, checksum, true)
    cv.setUint32(20, zip64?.saturateEntries ? U32_MAX : stored.length, true)
    cv.setUint32(24, zip64?.saturateEntries ? U32_MAX : raw.length, true)
    cv.setUint16(28, name.length, true)
    cv.setUint16(30, extraLength, true)
    cv.setUint32(42, extraWords === 0 ? offset : U32_MAX, true)
    cd.set(name, 46)
    if (extraWords > 0) {
      const at = 46 + name.length
      cv.setUint16(at, 0x0001, true)
      cv.setUint16(at + 2, extraWords * 8, true)
      if (extraWords === 3) {
        cv.setBigUint64(at + 4, BigInt(raw.length), true)
        cv.setBigUint64(at + 12, BigInt(stored.length), true)
        cv.setBigUint64(at + 20, BigInt(offset), true)
      } else {
        cv.setBigUint64(at + 4, BigInt(offset), true)
      }
    }
    central.push(cd)

    offset += local.length + stored.length
  }

  const cdBytes = concatBytes(central)
  const tail: Uint8Array[] = []

  if (zip64?.end) {
    const record = new Uint8Array(56)
    const rv = new DataView(record.buffer)
    rv.setUint32(0, 0x06064b50, true)
    rv.setBigUint64(4, BigInt(56 - 12), true) // size of the record after this field
    rv.setUint16(12, 45, true)
    rv.setUint16(14, 45, true)
    rv.setBigUint64(24, BigInt(entries.length), true)
    rv.setBigUint64(32, BigInt(entries.length), true)
    rv.setBigUint64(40, BigInt(cdBytes.length), true)
    rv.setBigUint64(48, BigInt(offset), true)

    const locator = new Uint8Array(20)
    const kv = new DataView(locator.buffer)
    kv.setUint32(0, 0x07064b50, true)
    kv.setBigUint64(8, BigInt(offset + cdBytes.length), true)
    kv.setUint32(16, 1, true)

    tail.push(record, locator)
  }

  const eocd = new Uint8Array(22)
  const ev = new DataView(eocd.buffer)
  ev.setUint32(0, 0x06054b50, true)
  ev.setUint16(8, zip64?.saturateTotal ? U16_MAX : entries.length, true)
  ev.setUint16(10, zip64?.saturateTotal ? U16_MAX : entries.length, true)
  ev.setUint32(12, zip64?.saturateCdSize ? U32_MAX : cdBytes.length, true)
  ev.setUint32(16, zip64?.saturateCdOffset ? U32_MAX : offset, true)
  tail.push(eocd)

  writeFileSync(path, concatBytes([...body, cdBytes, ...tail]))
}

/** A slice_info.config carrying the given header-item keys, values deliberately junk. */
export function sliceInfo(keys: string[]): string {
  const items = keys.map((key) => `    <header_item key="${key}" value="whatever"/>`).join('\n')
  return `<?xml version="1.0" encoding="UTF-8"?>\n<config>\n  <header>\n${items}\n  </header>\n  <plate>\n    <metadata key="printer_model_id" value="Anycubic Kobra X"/>\n  </plate>\n</config>\n`
}

const MODEL_XML = '<?xml version="1.0"?><model unit="millimeter"><resources/></model>'

export function curaProject(path: string, thumbnail?: Uint8Array): void {
  writeZip(path, [
    { name: '[Content_Types].xml', data: '<Types/>' },
    { name: '3D/3dmodel.model', data: MODEL_XML, deflate: true },
    { name: 'Cura/plugin_metadata.json', data: '{}' },
    { name: 'Cura/preferences.cfg', data: '[general]' },
    ...(thumbnail ? [{ name: 'Metadata/thumbnail.png', data: thumbnail }] : []),
  ])
}

export function prusaProject(path: string, thumbnail?: Uint8Array): void {
  writeZip(path, [
    { name: '3D/3dmodel.model', data: MODEL_XML, deflate: true },
    { name: 'Metadata/Slic3r_PE.config', data: '; generated by PrusaSlicer' },
    { name: 'Metadata/Slic3r_PE_model.config', data: '<config/>' },
    ...(thumbnail ? [{ name: 'Metadata/thumbnail.png', data: thumbnail }] : []),
  ])
}

/** Anycubic, Bambu and Orca share this layout exactly; only the header keys differ. */
export function bambuLineageProject(
  path: string,
  headerKeys: string[],
  thumbnail?: Uint8Array,
): void {
  writeZip(path, [
    { name: '3D/3dmodel.model', data: MODEL_XML, deflate: true },
    { name: 'Metadata/project_settings.config', data: '{"version": "02.08.02.61"}' },
    { name: 'Metadata/model_settings.config', data: '<config/>' },
    { name: 'Metadata/slice_info.config', data: sliceInfo(headerKeys) },
    ...(thumbnail
      ? [
          { name: 'Metadata/plate_1.png', data: thumbnail },
          { name: 'Metadata/plate_1_small.png', data: thumbnail },
          { name: 'Metadata/top_1.png', data: thumbnail },
        ]
      : []),
  ])
}

/** Saved but never sliced, so slice_info.config was never written (spec 3.4, rule 4). */
export function unslicedBambuProject(path: string): void {
  writeZip(path, [
    { name: '3D/3dmodel.model', data: MODEL_XML, deflate: true },
    { name: 'Metadata/project_settings.config', data: '{"version": "02.06.00.51"}' },
    { name: 'Metadata/model_settings.config', data: '<config/>' },
  ])
}

export function plainMesh3mf(path: string): void {
  writeZip(path, [
    { name: '[Content_Types].xml', data: '<Types/>' },
    { name: '3D/3dmodel.model', data: MODEL_XML, deflate: true },
  ])
}

const TETRAHEDRON_MODEL_XML =
  '<?xml version="1.0" encoding="UTF-8"?><model unit="millimeter"><resources>' +
  '<object id="1" type="model"><mesh><vertices>' +
  '<vertex x="0" y="0" z="0"/><vertex x="10" y="0" z="0"/>' +
  '<vertex x="0" y="10" z="0"/><vertex x="0" y="0" z="10"/>' +
  '</vertices><triangles>' +
  '<triangle v1="0" v2="2" v3="1"/><triangle v1="0" v2="1" v3="3"/>' +
  '<triangle v1="1" v2="2" v3="3"/><triangle v1="2" v2="0" v3="3"/>' +
  '</triangles></mesh></object></resources><build><item objectid="1"/></build></model>'

/**
 * A plain-mesh 3MF that actually contains geometry: a tetrahedron, four triangles with four
 * distinct normals, so a rasterized thumbnail of it is a shape rather than a flat blob.
 *
 * Kept separate from `plainMesh3mf` rather than folded into it. That one has an empty
 * `<resources/>` on purpose — it exists to prove classification, and classification is exactly
 * the question of what a 3MF is when it has no slicer metadata, geometry or not.
 */
export function meshGeometry3mf(path: string, thumbnail?: Uint8Array): void {
  writeZip(path, [
    { name: '[Content_Types].xml', data: '<Types/>' },
    { name: '3D/3dmodel.model', data: TETRAHEDRON_MODEL_XML, deflate: true },
    // A plain mesh with an embedded thumbnail is not a contradiction: the 28 zip64 files in the
    // reference library classify as `model` (no slicer metadata at all) and 16 of them carry one.
    ...(thumbnail ? [{ name: 'Metadata/thumbnail.png', data: thumbnail }] : []),
  ])
}

/**
 * A slicer project (`kind: 'slicer_project'`, by rule 3 of `classify3mf`) that holds real
 * geometry, with an embedded thumbnail only if one is passed.
 *
 * This is the common shape in the reference library and the reason the handler chain exists:
 * 326 of its 374 projects were saved but never sliced, so the slicer wrote no plate render.
 * `bambuLineageProject` cannot stand in — its model part is deliberately empty, which makes it
 * useful for classification and useless for rasterizing.
 */
export function slicerProjectWithMesh(path: string, thumbnail?: Uint8Array): void {
  writeZip(path, [
    // Not read by anything under test, but every real 3MF is an OPC package and has one.
    { name: '[Content_Types].xml', data: '<Types/>' },
    { name: '3D/3dmodel.model', data: TETRAHEDRON_MODEL_XML, deflate: true },
    { name: 'Metadata/project_settings.config', data: '{"version": "02.08.02.61"}' },
    { name: 'Metadata/model_settings.config', data: '<config/>' },
    { name: 'Metadata/slice_info.config', data: sliceInfo(['X-BBL-Client-Type']) },
    ...(thumbnail ? [{ name: 'Metadata/plate_1.png', data: thumbnail }] : []),
  ])
}
