import { BufferAttribute, BufferGeometry, Group, Matrix4, Mesh, type Object3D } from 'three'
import { ThreeMFLoader } from 'three/addons/loaders/3MFLoader.js'
import { unzipSync } from 'three/addons/libs/fflate.module.js'

/**
 * 3MF to an `Object3D`, including the files slicers write.
 *
 * A plain 3MF holds its meshes in `3D/3dmodel.model`, and three.js's loader reads that. A project
 * saved by Bambu Studio or OrcaSlicer (and models exported by them) does not: the root model holds
 * only assemblies, whose components point into other parts (`3D/Objects/object_1.model`) through
 * the production extension's `p:path`. Every part numbers its objects from 1, so three.js's loader,
 * which keys objects by id across all parts at once, mixes them up or finds nothing to draw.
 *
 * So a 3MF with more than one model part is read here, by following the build from the root part:
 * each build item, through its components (into whichever part they name), down to meshes, with
 * the transforms multiplied on the way. A 3MF with one part keeps going to three.js's loader.
 */
export function parse3mf(bytes: ArrayBuffer): Object3D {
  const files = unzipSync(new Uint8Array(bytes), {
    filter: (file) => file.name.endsWith('.model') || file.name.endsWith('.rels'),
  })
  const parts = Object.keys(files).filter((name) => name.endsWith('.model'))
  if (parts.length <= 1) return new ThreeMFLoader().parse(bytes)
  return new ProductionReader(files).read()
}

/** The 3MF transform "m00 m01 m02 m10 m11 m12 m20 m21 m22 m30 m31 m32" as a matrix. */
export function parseTransform(text: string | null): Matrix4 {
  const matrix = new Matrix4()
  if (!text) return matrix
  const m = text.trim().split(/\s+/).map(Number)
  if (m.length !== 12 || m.some((value) => !Number.isFinite(value))) return matrix
  // 3MF multiplies row vectors (p · M); three.js column vectors (M · p): the same numbers, transposed.
  matrix.set(
    m[0]!,
    m[3]!,
    m[6]!,
    m[9]!,
    m[1]!,
    m[4]!,
    m[7]!,
    m[10]!,
    m[2]!,
    m[5]!,
    m[8]!,
    m[11]!,
    0,
    0,
    0,
    1,
  )
  return matrix
}

/** A part's name inside the zip, from a `p:path` ("/3D/Objects/a.model" or relative). */
function partName(path: string): string {
  return decodeURIComponent(path.replace(/^\/+/, ''))
}

/** An attribute whatever its namespace prefix: `p:path`, `path`, or a prefix of the file's own. */
function attribute(element: Element, local: string): string | null {
  const direct = element.getAttribute(local)
  if (direct !== null) return direct
  for (const attr of Array.from(element.attributes)) {
    if (attr.localName === local) return attr.value
  }
  return null
}

const byLocalName = (root: Element | Document, local: string): Element[] =>
  Array.from(root.getElementsByTagNameNS('*', local))

/** Children of `parent` with this local name (not deeper descendants). */
const childrenNamed = (parent: Element, local: string): Element[] =>
  Array.from(parent.children).filter((child) => child.localName === local)

class ProductionReader {
  private readonly documents = new Map<string, Map<string, Element>>()
  private readonly geometries = new Map<string, BufferGeometry | null>()
  private readonly decoder = new TextDecoder()
  /** Guards against a component cycle in a malformed file. */
  private depth = 0

  constructor(private readonly files: Record<string, Uint8Array>) {}

  read(): Object3D {
    const rootName = this.rootPart()
    const root = this.parse(rootName)
    if (!root) throw new Error('3MF root model part missing')
    const group = new Group()
    const builds = byLocalName(root.document, 'build')
    const items = builds.length > 0 ? childrenNamed(builds[0]!, 'item') : []
    for (const item of items) {
      const id = item.getAttribute('objectid')
      if (!id) continue
      const path = attribute(item, 'path')
      this.place(
        group,
        path ? partName(path) : rootName,
        id,
        parseTransform(item.getAttribute('transform')),
      )
    }
    // Every placement got its own copy; the originals were only templates.
    for (const geometry of this.geometries.values()) geometry?.dispose()
    return group
  }

  /** The root model part, from the package relationships; `3D/3dmodel.model` by convention. */
  private rootPart(): string {
    const rels = this.files['_rels/.rels']
    if (rels) {
      const doc = new DOMParser().parseFromString(this.decoder.decode(rels), 'application/xml')
      for (const rel of byLocalName(doc, 'Relationship')) {
        const type = rel.getAttribute('Type') ?? ''
        const target = rel.getAttribute('Target')
        if (target && type.endsWith('/3dmodel')) return partName(target)
      }
    }
    return '3D/3dmodel.model'
  }

  /** A part's objects by id, parsed once. */
  private parse(name: string): { document: Document; objects: Map<string, Element> } | undefined {
    const bytes = this.files[name]
    if (!bytes) return undefined
    const document = new DOMParser().parseFromString(this.decoder.decode(bytes), 'application/xml')
    let objects = this.documents.get(name)
    if (!objects) {
      objects = new Map(
        byLocalName(document, 'object').map((object) => [object.getAttribute('id') ?? '', object]),
      )
      this.documents.set(name, objects)
    }
    return { document, objects }
  }

  private object(part: string, id: string): Element | undefined {
    if (!this.documents.has(part)) this.parse(part)
    return this.documents.get(part)?.get(id)
  }

  /** Adds an object (a mesh, or the components it is made of) to `group` under `transform`. */
  private place(group: Group, part: string, id: string, transform: Matrix4): void {
    if (this.depth > 32) return
    const object = this.object(part, id)
    if (!object) return
    const mesh = childrenNamed(object, 'mesh')[0]
    if (mesh) {
      const geometry = this.geometry(part, id, mesh)
      if (geometry) group.add(new Mesh(geometry.clone().applyMatrix4(transform)))
      return
    }
    const components = childrenNamed(object, 'components')[0]
    if (!components) return
    this.depth++
    for (const component of childrenNamed(components, 'component')) {
      const child = component.getAttribute('objectid')
      if (!child) continue
      const path = attribute(component, 'path')
      const local = parseTransform(component.getAttribute('transform'))
      this.place(group, path ? partName(path) : part, child, transform.clone().multiply(local))
    }
    this.depth--
  }

  /** One mesh's geometry, built once however many times it is placed. */
  private geometry(part: string, id: string, mesh: Element): BufferGeometry | null {
    const key = `${part}#${id}`
    const cached = this.geometries.get(key)
    if (cached !== undefined) return cached
    const vertices = byLocalName(mesh, 'vertex')
    const triangles = byLocalName(mesh, 'triangle')
    if (vertices.length === 0 || triangles.length === 0) {
      this.geometries.set(key, null)
      return null
    }
    const positions = new Float32Array(vertices.length * 3)
    vertices.forEach((vertex, index) => {
      positions[index * 3] = Number(vertex.getAttribute('x'))
      positions[index * 3 + 1] = Number(vertex.getAttribute('y'))
      positions[index * 3 + 2] = Number(vertex.getAttribute('z'))
    })
    const indices = new Uint32Array(triangles.length * 3)
    let count = 0
    for (const triangle of triangles) {
      const a = Number(triangle.getAttribute('v1'))
      const b = Number(triangle.getAttribute('v2'))
      const c = Number(triangle.getAttribute('v3'))
      if (![a, b, c].every((v) => Number.isInteger(v) && v >= 0 && v < vertices.length)) continue
      indices[count++] = a
      indices[count++] = b
      indices[count++] = c
    }
    const geometry = new BufferGeometry()
    geometry.setAttribute('position', new BufferAttribute(positions, 3))
    geometry.setIndex(new BufferAttribute(indices.subarray(0, count), 1))
    this.geometries.set(key, geometry)
    return geometry
  }
}
