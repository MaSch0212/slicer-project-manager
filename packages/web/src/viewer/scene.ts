import {
  AmbientLight,
  Box3,
  DirectionalLight,
  MathUtils,
  PerspectiveCamera,
  Scene,
  Vector3,
  WebGLRenderer,
  type Object3D,
} from 'three'
import { OrbitControls } from 'three/addons/controls/OrbitControls.js'
import { disposeSubtree } from './load-model'

/** Fraction of the view left empty round the model, per side. */
const MARGIN_FRACTION = 0.06

/**
 * Where the camera sits relative to the model, as a unit direction: the isometric basis the server
 * rasterizer draws thumbnails from (parent spec 7.4), so the viewer opens on the view the thumbnail
 * showed. +Z is up, the bed normal, as in a slicer.
 */
const VIEW_DIRECTION = new Vector3(
  0.4326772674141481,
  -0.6924283709739895,
  0.5773502691896256,
).normalize()
const WORLD_UP = new Vector3(0, 0, 1)

/** The key light direction of the rasterizer; a second light from the opposite side lights the back. */
const KEY_LIGHT_DIRECTION = new Vector3(-0.3, -0.55, 0.78).normalize()
const AMBIENT_SHARE = 0.2

/** One arrow-key press orbits this much, and one +/- press zooms by this factor. */
const ORBIT_STEP = MathUtils.degToRad(5)
const DOLLY_STEP = 1 / 1.1

/**
 * How far back the camera must sit for a sphere of `radius` to fit the view with a margin, on the
 * tighter axis (a portrait stage is limited by its width, a landscape one by its height).
 */
export function fitDistance(radius: number, fovDegrees: number, aspect: number): number {
  const halfFovY = MathUtils.degToRad(fovDegrees) / 2
  const halfFovX = Math.atan(Math.tan(halfFovY) * aspect)
  return (
    Math.max(radius / Math.sin(halfFovY), radius / Math.sin(halfFovX)) / (1 - 2 * MARGIN_FRACTION)
  )
}

export type RendererFactory = (canvas: HTMLCanvasElement) => WebGLRenderer

const defaultRenderer: RendererFactory = (canvas) =>
  // Transparent clear: the stage behind the canvas is a themed surface, so the background follows
  // light and dark with nothing hard-coded here.
  new WebGLRenderer({ canvas, antialias: true, alpha: true })

/** Thrown by `createModelViewer` when no WebGL context can be made. */
export class NoWebGlError extends Error {}

export type ModelViewer = {
  /** Shows `root` (centred and framed), freeing the model it replaces. */
  setModel(root: Object3D): void
  /** Puts the camera back where the model opened, and hands the automatic re-fit back. */
  resetView(): void
  /** Handles an arrow, +, - or 0 key on the stage. True when the key was claimed. */
  handleKey(event: KeyboardEvent): boolean
  /** Called once if the browser takes the GL context back at runtime. */
  onContextLost(callback: () => void): void
  dispose(): void
}

/**
 * The three.js side of the viewer: a renderer on a canvas appended to `host`, a camera orbiting the
 * bed normal, two lights, orbit controls, and a resize observer. Everything is released by
 * `dispose()`, including the GL context (disposing the renderer alone does not release it).
 * Throws `NoWebGlError` when there is no context to be had.
 */
export function createModelViewer(
  host: HTMLElement,
  createRenderer: RendererFactory = defaultRenderer,
): ModelViewer {
  const canvas = host.ownerDocument.createElement('canvas')
  let renderer: WebGLRenderer
  try {
    renderer = createRenderer(canvas)
  } catch {
    throw new NoWebGlError('no WebGL')
  }
  host.appendChild(canvas)
  renderer.setClearColor(0x000000, 0)
  renderer.setPixelRatio(Math.min(host.ownerDocument.defaultView?.devicePixelRatio ?? 1, 2))

  const scene = new Scene()
  const camera = new PerspectiveCamera(50, 1, 0.1, 1000)
  camera.up.copy(WORLD_UP)
  camera.position.copy(VIEW_DIRECTION).multiplyScalar(4)

  scene.add(new AmbientLight(0xffffff, AMBIENT_SHARE * Math.PI))
  for (const sign of [1, -1]) {
    const light = new DirectionalLight(0xffffff, (1 - AMBIENT_SHARE) * Math.PI)
    light.position.copy(KEY_LIGHT_DIRECTION).multiplyScalar(sign)
    scene.add(light)
  }

  const controls = new OrbitControls(camera, canvas)
  controls.enableDamping = true

  let content: Object3D | null = null
  // Once the user has taken hold of the camera a resize must not snatch it back.
  let userMovedCamera = false
  let contextLost: (() => void) | undefined
  const markMoved = (): void => {
    userMovedCamera = true
  }
  const lost = (): void => {
    renderer.setAnimationLoop(null)
    contextLost?.()
  }
  canvas.addEventListener('pointerdown', markMoved)
  canvas.addEventListener('wheel', markMoved)
  canvas.addEventListener('webglcontextlost', lost)

  function frame(root: Object3D): void {
    const box = new Box3().setFromObject(root)
    if (box.isEmpty()) return
    // Centre on the origin, so it orbits about itself.
    root.position.sub(box.getCenter(new Vector3()))
    const radius = Math.max(box.getSize(new Vector3()).length() / 2, 1e-6)
    const distance = fitDistance(radius, camera.fov, camera.aspect)
    camera.position.copy(VIEW_DIRECTION).multiplyScalar(distance)
    camera.near = distance / 1000
    camera.far = (distance + radius) * 10
    camera.updateProjectionMatrix()
    camera.lookAt(0, 0, 0)
    controls.target.set(0, 0, 0)
    controls.update()
  }

  /** Re-fits, killing any damping coast first so the camera lands exactly where framed. */
  function refit(root: Object3D): void {
    controls.enableDamping = false
    controls.update()
    controls.enableDamping = true
    frame(root)
  }

  function resize(width: number, height: number): void {
    const w = Math.max(1, Math.round(width))
    const h = Math.max(1, Math.round(height))
    camera.aspect = w / h
    camera.updateProjectionMatrix()
    renderer.setSize(w, h, false)
    if (content && !userMovedCamera) refit(content)
  }

  renderer.setAnimationLoop(() => {
    controls.update()
    renderer.render(scene, camera)
  })

  const observer = new ResizeObserver((entries) => {
    const rect = entries.at(-1)?.contentRect
    if (rect) resize(rect.width, rect.height)
  })
  observer.observe(host)
  resize(host.clientWidth, host.clientHeight)

  function resetView(): void {
    if (!content) return
    userMovedCamera = false
    refit(content)
  }

  return {
    setModel(root) {
      if (content) {
        scene.remove(content)
        disposeSubtree(content)
      }
      content = root
      scene.add(root)
      userMovedCamera = false
      refit(root)
    },

    resetView,

    handleKey(event) {
      if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return false
      switch (event.key) {
        case 'ArrowLeft':
          controls.rotateLeft(-ORBIT_STEP)
          break
        case 'ArrowRight':
          controls.rotateLeft(ORBIT_STEP)
          break
        case 'ArrowUp':
          controls.rotateUp(ORBIT_STEP)
          break
        case 'ArrowDown':
          controls.rotateUp(-ORBIT_STEP)
          break
        case '+':
        case '=':
          controls.dollyIn(DOLLY_STEP)
          break
        case '-':
          controls.dollyOut(DOLLY_STEP)
          break
        case '0':
          resetView()
          event.preventDefault()
          return true
        default:
          return false
      }
      userMovedCamera = true
      event.preventDefault()
      return true
    },

    onContextLost(callback) {
      contextLost = callback
    },

    dispose() {
      // Stop drawing before anything it draws with is freed.
      renderer.setAnimationLoop(null)
      observer.disconnect()
      controls.dispose()
      if (content) {
        scene.remove(content)
        disposeSubtree(content)
        content = null
      }
      renderer.dispose()
      renderer.forceContextLoss()
      canvas.removeEventListener('pointerdown', markMoved)
      canvas.removeEventListener('wheel', markMoved)
      canvas.removeEventListener('webglcontextlost', lost)
      canvas.remove()
    },
  }
}
