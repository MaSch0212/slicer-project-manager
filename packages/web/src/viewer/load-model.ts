import {
  DoubleSide,
  Mesh,
  MeshLambertMaterial,
  type Material,
  type Object3D,
  type Texture,
} from 'three'
import { ThreeMFLoader } from 'three/addons/loaders/3MFLoader.js'
import { OBJLoader } from 'three/addons/loaders/OBJLoader.js'
import { STLLoader } from 'three/addons/loaders/STLLoader.js'
import type { ViewableFormat } from './model-kind'

/** Why a model did not load. */
export type LoadFailure = 'missing' | 'fetch' | 'parse' | 'empty'

export class ModelLoadError extends Error {
  readonly reason: LoadFailure
  constructor(reason: LoadFailure) {
    super(reason)
    this.reason = reason
  }
}

/** One loader per format. Parsing is synchronous: the bytes are already in memory. */
export function parseModel(format: ViewableFormat, bytes: ArrayBuffer): Object3D {
  switch (format) {
    case 'stl':
      return new Mesh(new STLLoader().parse(bytes))
    case 'obj':
      return new OBJLoader().parse(new TextDecoder().decode(bytes))
    case '3mf':
      return new ThreeMFLoader().parse(bytes)
  }
}

/** The colour every model is drawn in: the warm tone the server thumbnails use. */
export const MODEL_COLOUR = 0xefdcc6

const texturesOf = (material: Material): Texture[] =>
  Object.values(material).filter(
    (value): value is Texture => (value as Texture | null)?.isTexture === true,
  )

const materialsOf = (material: Material | Material[] | undefined): Material[] =>
  Array.isArray(material) ? material : material ? [material] : []

/** Frees the GPU-side resources of a subtree. Removing it from the scene does not. */
export function disposeSubtree(root: Object3D): void {
  root.traverse((node) => {
    const mesh = node as Partial<Mesh>
    mesh.geometry?.dispose()
    for (const material of materialsOf(mesh.material)) {
      for (const texture of texturesOf(material)) texture.dispose()
      material.dispose()
    }
  })
}

/**
 * Replaces every mesh material with one shared look (flat-shaded, two-sided, the model colour).
 * A 3MF can carry its own colours and an OBJ its own materials; the viewer shows the shape, the
 * same way for every format, and each mesh gets its own instance so disposal stays one per mesh.
 */
export function materialise(root: Object3D): void {
  root.traverse((node) => {
    if ((node as Partial<Mesh>).isMesh !== true) return
    const mesh = node as Mesh
    for (const old of materialsOf(mesh.material)) old.dispose()
    mesh.material = new MeshLambertMaterial({
      color: MODEL_COLOUR,
      side: DoubleSide,
      flatShading: true,
    })
  })
}

/** How many triangles a subtree draws, indexed or not. */
export function triangleCount(root: Object3D): number {
  let total = 0
  root.traverse((node) => {
    if ((node as Partial<Mesh>).isMesh !== true) return
    const geometry = (node as Mesh).geometry
    const index = geometry.getIndex()
    const position = geometry.getAttribute('position')
    if (index) total += Math.floor(index.count / 3)
    else if (position) total += Math.floor(position.count / 3)
  })
  return total
}

/**
 * Bytes to an `Object3D` ready to draw: parsed, checked for geometry, given the shared look. A file
 * that does not parse is a `parse` failure; one that parses to nothing is `empty`.
 */
export function buildModel(format: ViewableFormat, bytes: ArrayBuffer): Object3D {
  let content: Object3D
  try {
    content = parseModel(format, bytes)
  } catch {
    throw new ModelLoadError('parse')
  }
  if (triangleCount(content) === 0) {
    disposeSubtree(content)
    throw new ModelLoadError('empty')
  }
  materialise(content)
  return content
}

/**
 * Downloads a model, reporting progress. The size the API gave is used to allocate once and fill in
 * place (no second copy), and is only a hint: a body that turns out longer or shorter is handled.
 * `signal` abandons the download when the page goes away.
 */
export async function fetchModel(
  url: string,
  sizeHint: number,
  signal: AbortSignal,
  onProgress: (fraction: number | null) => void,
  fetchFn: typeof fetch = (input, init) => fetch(input, init),
): Promise<ArrayBuffer> {
  let response: Response
  try {
    response = await fetchFn(url, { credentials: 'same-origin', signal })
  } catch {
    throw new ModelLoadError('fetch')
  }
  if (response.status === 404 || response.status === 410) throw new ModelLoadError('missing')
  if (!response.ok) throw new ModelLoadError('fetch')

  // Aborted while the headers were still arriving: nothing is listening to the body any more.
  if (signal.aborted) {
    void response.body?.cancel().catch(() => {})
    throw new ModelLoadError('fetch')
  }

  const body = response.body
  if (!body) {
    try {
      return await response.arrayBuffer()
    } catch {
      throw new ModelLoadError('fetch')
    }
  }

  const total = sizeHint
  const buffer = total > 0 ? new Uint8Array(total) : null
  const spill: Uint8Array[] = []
  let placed = 0
  let received = 0

  const reader = body.getReader()
  const stopReading = (): void => void reader.cancel().catch(() => {})
  signal.addEventListener('abort', stopReading, { once: true })
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      if (buffer && spill.length === 0 && received + value.byteLength <= total) {
        buffer.set(value, placed)
        placed += value.byteLength
      } else {
        spill.push(value)
      }
      received += value.byteLength
      onProgress(total > 0 ? Math.min(received / total, 1) : null)
    }
  } catch {
    throw new ModelLoadError('fetch')
  } finally {
    signal.removeEventListener('abort', stopReading)
  }
  if (signal.aborted) throw new ModelLoadError('fetch')

  if (buffer && received === total) return buffer.buffer as ArrayBuffer
  const out = new Uint8Array(received)
  if (buffer) out.set(buffer.subarray(0, placed))
  let offset = placed
  for (const chunk of spill) {
    out.set(chunk, offset)
    offset += chunk.byteLength
  }
  return out.buffer
}
