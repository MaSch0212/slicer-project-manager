import {
  ChangeDetectionStrategy,
  Component,
  DOCUMENT,
  InjectionToken,
  inject,
  input,
  signal,
  viewChild,
  type AfterViewInit,
  type ElementRef,
  type OnDestroy,
} from '@angular/core'
import { RouterLink } from '@angular/router'
import { JigButton } from '@awdlab/jig/button'
import { JigIcon } from '@awdlab/jig/icon'
import { JigMessage } from '@awdlab/jig/message'
import tablerArrowLeft from '@iconify/icons-tabler/arrow-left'
import {
  BoxGeometry,
  DataTexture,
  DirectionalLight,
  HemisphereLight,
  Mesh,
  MeshStandardMaterial,
  NearestFilter,
  PerspectiveCamera,
  RGBAFormat,
  SRGBColorSpace,
  Scene,
  WebGLRenderer,
  type Material,
  type Object3D,
  type Texture,
} from 'three'
import { OrbitControls } from 'three/addons/controls/OrbitControls.js'
import { TranslateService } from '../../core/i18n/translate.service'

/**
 * How the page gets its renderer. Overridable because a `WebGLRenderer` cannot be built
 * without a GPU context, so a jsdom test can supply a stand-in and still exercise the real
 * scene, the real controls and the real teardown order around it.
 *
 * Declared here rather than in a shared file on purpose: the tree-shakable factory below is
 * the only eager reference to `three` in the app, and this module is reachable only through
 * the lazy route, so three.js stays out of the initial bundle.
 */
export type ViewerRendererFactory = (canvas: HTMLCanvasElement) => WebGLRenderer

export const VIEWER_RENDERER_FACTORY = new InjectionToken<ViewerRendererFactory>(
  'VIEWER_RENDERER_FACTORY',
  {
    providedIn: 'root',
    factory:
      () =>
      (canvas: HTMLCanvasElement): WebGLRenderer =>
        // `alpha`: the clear is transparent so the container's CSS carries the background
        // (see the comment on `setClearColor` below).
        new WebGLRenderer({ canvas, antialias: true, alpha: true }),
  },
)

/** A material's maps, whichever slots this particular material type happens to define. */
function texturesOf(material: Material): Texture[] {
  return Object.values(material).filter(
    (value): value is Texture => (value as Texture | null)?.isTexture === true,
  )
}

function materialsOf(material: Material | Material[] | undefined): Material[] {
  if (Array.isArray(material)) return material
  return material ? [material] : []
}

/**
 * Frees every GPU-side allocation under `root`.
 *
 * Geometries, materials and textures live in driver memory that no JavaScript garbage
 * collector can see or reclaim: dropping the last reference to a mesh leaves its buffers
 * resident until the whole context dies. Disposing a material does not touch its maps
 * either, so the textures are walked explicitly.
 */
function disposeSubtree(root: Object3D): void {
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
 * A 2x2 checker, generated rather than fetched so the placeholder costs no asset and no
 * request. It also gives the cube a real texture, which is the one class of GPU resource a
 * loaded model carries that an untextured box would not — and therefore the one the disposal
 * path could otherwise silently fail to release.
 */
function checkerTexture(): DataTexture {
  const l = 0xd0
  const d = 0x60
  // prettier-ignore
  const pixels = new Uint8Array([
    l, l, l, 0xff,  d, d, d, 0xff,
    d, d, d, 0xff,  l, l, l, 0xff,
  ])
  const texture = new DataTexture(pixels, 2, 2, RGBAFormat)
  texture.colorSpace = SRGBColorSpace
  // Nearest, not the default linear: 2x2 smoothed to grey would defeat the point of it.
  texture.magFilter = NearestFilter
  texture.needsUpdate = true
  return texture
}

@Component({
  selector: 'spm-viewer-page',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterLink, JigButton, JigIcon, JigMessage],
  template: `
    <main class="spm-main spm-main--viewer">
      <div class="spm-stack">
        <a jigButton kind="link" [routerLink]="['/projects', id()]">
          <jig-icon [icon]="icons.back" />
          {{ t.translations().viewer.back }}
        </a>

        <!--
          A canvas that never draws looks identical to a model that has not arrived yet, so a
          context that cannot be created has to be said out loud rather than left blank.
        -->
        @if (initError(); as message) {
          <jig-message color="error" role="alert">{{ message }}</jig-message>
        }

        <!--
          The canvas is appended here by the component rather than written in the template:
          three.js has to own the element it holds a context on, and dropping that element is
          part of teardown (see ngOnDestroy).

          role/aria-label sit on the container, not on the canvas, so the label stays bound
          and follows a language change; the canvas itself carries no accessible content.
        -->
        <div
          #viewport
          class="spm-viewport"
          role="img"
          [attr.aria-label]="t.translations().viewer.canvasLabel"
        ></div>
      </div>
    </main>
  `,
})
export class ViewerPage implements AfterViewInit, OnDestroy {
  private readonly document = inject(DOCUMENT)
  private readonly createRenderer = inject(VIEWER_RENDERER_FACTORY)
  protected readonly t = inject(TranslateService)
  protected readonly icons = { back: tablerArrowLeft }

  readonly id = input.required<string>()
  readonly fileId = input.required<string>()

  private readonly viewport = viewChild.required<ElementRef<HTMLElement>>('viewport')

  readonly initError = signal<string | null>(null)

  /**
   * Everything below is imperative, nullable state rather than signals, and deliberately so:
   * these are handles to resources outside Angular's world, each of which has to be released
   * exactly once and in a fixed order. Null means "not created, or already released".
   */
  private renderer: WebGLRenderer | null = null
  private controls: OrbitControls | null = null
  private canvas: HTMLCanvasElement | null = null
  private resizeObserver: ResizeObserver | null = null
  private scene: Scene | null = null
  private camera: PerspectiveCamera | null = null
  /** The single node everything drawable hangs off. See `setContent`. */
  private content: Object3D | null = null

  ngAfterViewInit(): void {
    const host = this.viewport().nativeElement
    const canvas = this.document.createElement('canvas')

    let renderer: WebGLRenderer
    try {
      renderer = this.createRenderer(canvas)
    } catch {
      // WebGL disabled, the GPU blocklisted, or too many contexts already live. The canvas is
      // never attached in this branch, so nothing is left on the page pretending to draw.
      this.initError.set(this.t.translations().viewer.noWebgl)
      return
    }

    host.appendChild(canvas)
    this.canvas = canvas
    this.renderer = renderer

    // Transparent clear. The background is `.spm-viewport`'s CSS, which is a jig theme token,
    // so the viewer is legible in both themes and follows a light/dark switch with no JS at
    // all — where a colour chosen here would have to be recomputed on every theme change.
    renderer.setClearColor(0x000000, 0)
    // Capped at 2: beyond that the pixel count grows faster than anything visible does.
    renderer.setPixelRatio(Math.min(this.document.defaultView?.devicePixelRatio ?? 1, 2))

    const scene = new Scene()
    this.scene = scene

    const camera = new PerspectiveCamera(50, 1, 0.1, 1000)
    camera.position.set(2.5, 2, 3)
    this.camera = camera

    // Two lights, not one: with a single directional light every face turned away from it
    // renders black, which against a light theme reads as a hole rather than as a shadow.
    scene.add(new HemisphereLight(0xffffff, 0x404040, 2))
    const key = new DirectionalLight(0xffffff, 1.5)
    key.position.set(4, 8, 6)
    scene.add(key)

    const controls = new OrbitControls(camera, canvas)
    controls.enableDamping = true
    this.controls = controls

    this.setContent(this.createContent())

    renderer.setAnimationLoop(() => {
      // enableDamping only advances while update() is called, so the loop is not optional.
      controls.update()
      renderer.render(scene, camera)
    })

    // A ResizeObserver, not a window listener: the canvas shares the page with the shell's
    // header and (later) a sidebar, so it can change size while the window does not.
    const observer = new ResizeObserver((entries) => {
      const rect = entries.at(-1)?.contentRect
      if (rect) this.resize(rect.width, rect.height)
    })
    observer.observe(host)
    this.resizeObserver = observer

    // The observer does fire once on observe(), but only on the next frame — the first paint
    // would otherwise be at the 1x1 default.
    this.resize(host.clientWidth, host.clientHeight)
  }

  ngOnDestroy(): void {
    // Order is load-bearing. The loop has to stop before anything it draws with is freed,
    // and the context is released last.
    //
    // None of this is optional housekeeping: a WebGL context is not reclaimed on the garbage
    // collector's schedule, and Chrome keeps only about 16 alive before it starts dropping
    // the oldest. A viewer that leaks one per navigation therefore stops working after a
    // handful of models, with no error anywhere.
    this.renderer?.setAnimationLoop(null)

    this.resizeObserver?.disconnect()
    this.resizeObserver = null

    // OrbitControls keeps pointer listeners on the canvas; while they are attached the canvas
    // — and through it the context — stays reachable.
    this.controls?.dispose()
    this.controls = null

    // Frees the scene's geometry, materials and textures down the same path a model swap
    // uses, so there is only one way for GPU memory to be released.
    this.setContent(null)
    this.scene = null
    this.camera = null

    this.renderer?.dispose()
    // dispose() drops three's own caches and programs but leaves the context itself alive
    // until the canvas is collected, which may be several GCs away — or never, if anything
    // still references it. forceContextLoss() is what actually gives the context back.
    this.renderer?.forceContextLoss()
    this.renderer = null

    this.canvas?.remove()
    this.canvas = null
  }

  /**
   * The one place where a file's bytes become geometry.
   *
   * Task 2 replaces the placeholder here — fetching `fileId`, picking the STL/3MF/OBJ loader,
   * and returning the parsed object — and task 3 gates that on the file's size. Keeping the
   * fetch here and the swap in `setContent` means there is a single point to gate and a
   * single point at which the previous model's GPU memory is released.
   */
  private createContent(): Object3D {
    return new Mesh(
      new BoxGeometry(1, 1, 1),
      new MeshStandardMaterial({ map: checkerTexture(), roughness: 0.55, metalness: 0.05 }),
    )
  }

  /**
   * The one place the scene's contents change. Whatever was there before is removed and
   * disposed first, so replacing a model cannot leak one and `null` is a full teardown.
   */
  private setContent(next: Object3D | null): void {
    const scene = this.scene
    if (!scene) return
    if (this.content) {
      scene.remove(this.content)
      disposeSubtree(this.content)
    }
    this.content = next
    if (next) scene.add(next)
  }

  private resize(width: number, height: number): void {
    const renderer = this.renderer
    const camera = this.camera
    if (!renderer || !camera) return

    // Clamped away from zero: a hidden or not-yet-laid-out container reports 0, and 0/0 puts
    // a NaN into the projection matrix, from which nothing ever draws again.
    const w = Math.max(1, Math.round(width))
    const h = Math.max(1, Math.round(height))

    camera.aspect = w / h
    camera.updateProjectionMatrix()
    // `false` — do not write inline width/height onto the canvas. Its CSS size is the
    // container's job, and letting three.js set it would feed the observer its own output.
    renderer.setSize(w, h, false)
  }
}
