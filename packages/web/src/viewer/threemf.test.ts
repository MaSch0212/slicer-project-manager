import { strToU8 as encode, zipSync } from 'three/addons/libs/fflate.module.js'
import { Box3, Vector3, type Mesh } from 'three'
import { describe, expect, it } from 'vitest'
import { triangleCount } from './load-model'
import { parse3mf, parseTransform } from './threemf'

/**
 * Text as bytes of *this* realm's Uint8Array. Under jsdom, `TextEncoder` returns another realm's,
 * which fflate's `zipSync` does not recognise as file data and zips up as a folder of numbers.
 */
const strToU8 = (text: string) => new Uint8Array(encode(text))

const NS = 'http://schemas.microsoft.com/3dmanufacturing/core/2015/02'
const PROD = 'http://schemas.microsoft.com/3dmanufacturing/production/2015/06'

const RELS =
  '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
  '<Relationship Target="/3D/3dmodel.model" Id="rel-1" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/>' +
  '</Relationships>'

/** A unit cube's mesh: 8 vertices, 12 triangles. */
const CUBE = (() => {
  const vertices: string[] = []
  for (const x of [0, 1]) {
    for (const y of [0, 1]) {
      for (const z of [0, 1]) vertices.push(`<vertex x="${x}" y="${y}" z="${z}"/>`)
    }
  }
  const faces = [
    [0, 1, 3],
    [0, 3, 2],
    [4, 6, 7],
    [4, 7, 5],
    [0, 4, 5],
    [0, 5, 1],
    [2, 3, 7],
    [2, 7, 6],
    [0, 2, 6],
    [0, 6, 4],
    [1, 5, 7],
    [1, 7, 3],
  ]
  const triangles = faces.map(([a, b, c]) => `<triangle v1="${a}" v2="${b}" v3="${c}"/>`)
  return `<mesh><vertices>${vertices.join('')}</vertices><triangles>${triangles.join('')}</triangles></mesh>`
})()

const buffer = (bytes: Uint8Array): ArrayBuffer =>
  bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer

/** What Bambu Studio and OrcaSlicer write: the meshes in parts of their own, numbered from 1. */
function bambuLike(): ArrayBuffer {
  const part =
    `<?xml version="1.0"?><model unit="millimeter" xmlns="${NS}">` +
    `<resources><object id="1" type="model">${CUBE}</object></resources><build/></model>`
  const root =
    `<?xml version="1.0"?><model unit="millimeter" xmlns="${NS}" xmlns:p="${PROD}" requiredextensions="p"><resources>` +
    '<object id="1" type="model"><components><component p:path="/3D/Objects/object_1.model" objectid="1" transform="1 0 0 0 1 0 0 0 1 0 0 0"/></components></object>' +
    '<object id="2" type="model"><components><component p:path="/3D/Objects/object_2.model" objectid="1"/></components></object>' +
    '</resources><build>' +
    '<item objectid="1" transform="1 0 0 0 1 0 0 0 1 10 20 0"/>' +
    '<item objectid="2" transform="2 0 0 0 2 0 0 0 2 100 0 0"/>' +
    '</build></model>'
  return buffer(
    zipSync({
      '_rels/.rels': strToU8(RELS),
      '3D/3dmodel.model': strToU8(root),
      '3D/Objects/object_1.model': strToU8(part),
      '3D/Objects/object_2.model': strToU8(part),
      'Metadata/project_settings.config': strToU8('{}'),
    }),
  )
}

describe('reading a 3MF', () => {
  it('follows the build through components into other parts', () => {
    const scene = parse3mf(bambuLike())
    expect(triangleCount(scene)).toBe(24)
    const boxes = scene.children.map((child) => {
      const geometry = (child as Mesh).geometry
      geometry.computeBoundingBox()
      return geometry.boundingBox!
    })
    expect(boxes[0]!.min).toEqual(new Vector3(10, 20, 0))
    // The second item is scaled by two and moved along x.
    expect(boxes[1]!.max).toEqual(new Vector3(102, 2, 2))
    expect(new Box3().setFromObject(scene).max.x).toBe(102)
  })

  it('reads the 3MF transform in its own (row-vector) order', () => {
    const point = new Vector3(1, 0, 0).applyMatrix4(parseTransform('0 1 0 -1 0 0 0 0 1 5 6 7'))
    expect(point.toArray().map((v) => Math.round(v))).toEqual([5, 7, 7])
  })

  it('still reads a plain single-part 3MF with three.js', () => {
    const root =
      `<?xml version="1.0"?><model unit="millimeter" xmlns="${NS}">` +
      `<resources><object id="1" type="model">${CUBE}</object></resources>` +
      '<build><item objectid="1"/></build></model>'
    const bytes = zipSync({ '_rels/.rels': strToU8(RELS), '3D/3dmodel.model': strToU8(root) })
    expect(triangleCount(parse3mf(buffer(bytes)))).toBe(12)
  })
})
