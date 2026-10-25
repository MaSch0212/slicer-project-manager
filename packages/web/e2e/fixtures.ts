import { deflateRawSync } from 'node:zlib'

/**
 * Small, real model files built in code, so what a test puts on disk is readable in the diff and
 * genuinely parseable: the server rasterizes a thumbnail from each and the viewer draws it, which a
 * placeholder like "solid cube" would only prove can fail.
 */

type Vec = [number, number, number]
export type Mesh = { vertices: Vec[]; triangles: [number, number, number][] }

/** A box `size` mm on every side, centred on the origin, as 12 triangles with outward winding. */
export function cube(size = 20): Mesh {
  const h = size / 2
  const vertices: Vec[] = [
    [-h, -h, -h],
    [h, -h, -h],
    [h, h, -h],
    [-h, h, -h],
    [-h, -h, h],
    [h, -h, h],
    [h, h, h],
    [-h, h, h],
  ]
  const quads: [number, number, number, number][] = [
    [0, 3, 2, 1],
    [4, 5, 6, 7],
    [0, 1, 5, 4],
    [2, 3, 7, 6],
    [1, 2, 6, 5],
    [3, 0, 4, 7],
  ]
  return {
    vertices,
    triangles: quads.flatMap(([a, b, c, d]) => [
      [a, b, c],
      [a, c, d],
    ]),
  }
}

/** A square pyramid, base on the bed. */
export function pyramid(size = 24, height = 30): Mesh {
  const h = size / 2
  const vertices: Vec[] = [
    [-h, -h, 0],
    [h, -h, 0],
    [h, h, 0],
    [-h, h, 0],
    [0, 0, height],
  ]
  return {
    vertices,
    triangles: [
      [0, 3, 2],
      [0, 2, 1],
      [0, 1, 4],
      [1, 2, 4],
      [2, 3, 4],
      [3, 0, 4],
    ],
  }
}

/** A cylinder standing on the bed, `segments` sides. */
export function cylinder(radius = 10, height = 28, segments = 24): Mesh {
  const vertices: Vec[] = []
  for (let i = 0; i < segments; i++) {
    const angle = (i / segments) * Math.PI * 2
    vertices.push([Math.cos(angle) * radius, Math.sin(angle) * radius, 0])
    vertices.push([Math.cos(angle) * radius, Math.sin(angle) * radius, height])
  }
  const bottomCentre = vertices.push([0, 0, 0]) - 1
  const topCentre = vertices.push([0, 0, height]) - 1
  const triangles: [number, number, number][] = []
  for (let i = 0; i < segments; i++) {
    const next = (i + 1) % segments
    const b0 = i * 2
    const t0 = i * 2 + 1
    const b1 = next * 2
    const t1 = next * 2 + 1
    triangles.push([b0, b1, t1], [b0, t1, t0], [bottomCentre, b1, b0], [topCentre, t0, t1])
  }
  return { vertices, triangles }
}

/** Binary STL: an 80-byte header, a triangle count, then 50 bytes per triangle. */
export function binaryStl(mesh: Mesh): Uint8Array {
  const out = new Uint8Array(84 + mesh.triangles.length * 50)
  const view = new DataView(out.buffer)
  view.setUint32(80, mesh.triangles.length, true)
  let offset = 84
  for (const triangle of mesh.triangles) {
    offset += 12 // the facet normal is left zero; the rasterizer recomputes shading
    for (const index of triangle) {
      for (const value of mesh.vertices[index]!) {
        view.setFloat32(offset, value, true)
        offset += 4
      }
    }
    offset += 2 // attribute byte count
  }
  return out
}

/** Wavefront OBJ (1-based indices). */
export function obj(mesh: Mesh): Uint8Array {
  const lines = mesh.vertices.map(([x, y, z]) => `v ${x} ${y} ${z}`)
  lines.push(...mesh.triangles.map(([a, b, c]) => `f ${a + 1} ${b + 1} ${c + 1}`))
  return new TextEncoder().encode(`${lines.join('\n')}\n`)
}

/** A zip of stored or deflated entries. A 3MF and a CuraManager archive are both one. */
export function zip(files: { name: string; body: string | Uint8Array }[]): Uint8Array {
  const local: Buffer[] = []
  const central: Buffer[] = []
  let offset = 0
  for (const file of files) {
    const name = Buffer.from(file.name, 'utf8')
    const raw = Buffer.from(file.body)
    const data = deflateRawSync(raw)
    const crc = crc32(raw)

    const header = Buffer.alloc(30)
    header.writeUInt32LE(0x04034b50, 0)
    header.writeUInt16LE(20, 4)
    header.writeUInt16LE(8, 8) // deflate
    header.writeUInt32LE(crc, 14)
    header.writeUInt32LE(data.length, 18)
    header.writeUInt32LE(raw.length, 22)
    header.writeUInt16LE(name.length, 26)
    local.push(header, name, data)

    const entry = Buffer.alloc(46)
    entry.writeUInt32LE(0x02014b50, 0)
    entry.writeUInt16LE(20, 4)
    entry.writeUInt16LE(20, 6)
    entry.writeUInt16LE(8, 10)
    entry.writeUInt32LE(crc, 16)
    entry.writeUInt32LE(data.length, 20)
    entry.writeUInt32LE(raw.length, 24)
    entry.writeUInt16LE(name.length, 28)
    entry.writeUInt32LE(offset, 42)
    central.push(entry, name)

    offset += header.length + name.length + data.length
  }
  const centralBytes = Buffer.concat(central)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(files.length, 8)
  end.writeUInt16LE(files.length, 10)
  end.writeUInt32LE(centralBytes.length, 12)
  end.writeUInt32LE(offset, 16)
  return Buffer.concat([...local, centralBytes, end])
}

function crc32(bytes: Buffer): number {
  let c = 0xffffffff
  for (const byte of bytes) {
    c ^= byte
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
  }
  return (c ^ 0xffffffff) >>> 0
}

/** A plain 3MF (no slicer configuration), so the server classifies it as a model. */
export function threeMf(mesh: Mesh): Uint8Array {
  const vertices = mesh.vertices.map(([x, y, z]) => `<vertex x="${x}" y="${y}" z="${z}"/>`).join('')
  const triangles = mesh.triangles
    .map(([a, b, c]) => `<triangle v1="${a}" v2="${b}" v3="${c}"/>`)
    .join('')
  return zip([
    {
      name: '[Content_Types].xml',
      body: '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/></Types>',
    },
    {
      name: '_rels/.rels',
      body: '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Target="/3D/3dmodel.model" Id="rel0" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/></Relationships>',
    },
    {
      name: '3D/3dmodel.model',
      body: `<?xml version="1.0" encoding="UTF-8"?><model unit="millimeter" xml:lang="en-US" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02"><resources><object id="1" type="model"><mesh><vertices>${vertices}</vertices><triangles>${triangles}</triangles></mesh></object></resources><build><item objectid="1"/></build></model>`,
    },
  ])
}

/** A file that looks like STEP at the top. The app lists it but has no kernel to draw it. */
export function stepStub(): Uint8Array {
  return new TextEncoder().encode(
    "ISO-10303-21;\nHEADER;\nFILE_DESCRIPTION(('stub'),'2;1');\nENDSEC;\nDATA;\nENDSEC;\nEND-ISO-10303-21;\n",
  )
}

/**
 * A zipped CuraManager library: one project folder per entry group, each with the metadata file the
 * importer reads tags and archived state from, plus a loose root file it must skip.
 */
export function curaManagerArchive(suffix = ''): Uint8Array {
  const alpha = `Zip Import Alpha${suffix}`
  const beta = `Zip Import Beta${suffix}`
  return zip([
    { name: `CuraLibrary/${alpha}/part.stl`, body: binaryStl(cube(12)) },
    {
      name: `CuraLibrary/${alpha}/metadata.json`,
      body: JSON.stringify({ Tags: ['zip-imported', 'cura'], IsArchived: false }),
    },
    { name: `CuraLibrary/${beta}/model.3mf`, body: threeMf(pyramid()) },
    {
      name: `CuraLibrary/${beta}/metadata.json`,
      body: JSON.stringify({ Tags: ['zip-imported'], IsArchived: true }),
    },
    // Skipped by the importer: a loose file at the library root.
    { name: 'CuraLibrary/metadata-cache.json', body: '{}' },
  ])
}
