import {
  DoubleSide,
  Mesh,
  MeshLambertMaterial,
  type Material,
  type Object3D,
  type Texture,
} from 'three'
import { OBJLoader } from 'three/addons/loaders/OBJLoader.js'
import { STLLoader } from 'three/addons/loaders/STLLoader.js'
import { ModelLoadError } from './fetch-bytes'
import type { ViewableFormat } from './model-kind'
import { parse3mf } from './threemf'

export { fetchModel, ModelLoadError, type LoadFailure } from './fetch-bytes'

/** One loader per format. Parsing is synchronous: the bytes are already in memory. */
export function parseModel(format: ViewableFormat, bytes: ArrayBuffer): Object3D {
  switch (format) {
    case 'stl':
      return new Mesh(new STLLoader().parse(bytes))
    case 'obj':
      return new OBJLoader().parse(new TextDecoder().decode(bytes))
    case '3mf':
      return parse3mf(bytes)
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
