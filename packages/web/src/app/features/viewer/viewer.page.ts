import {
  ChangeDetectionStrategy,
  Component,
  DOCUMENT,
  InjectionToken,
  PendingTasks,
  computed,
  effect,
  inject,
  input,
  resource,
  signal,
  viewChild,
  type AfterViewInit,
  type ElementRef,
  type OnDestroy,
} from '@angular/core'
import { RouterLink } from '@angular/router'
import { interpolate } from '@ngneers/signal-translate'
import { JigButton } from '@awdlab/jig/button'
import { JigIcon } from '@awdlab/jig/icon'
import { JigMessage } from '@awdlab/jig/message'
import { JigProgress } from '@awdlab/jig/progress'
import tablerArrowLeft from '@iconify/icons-tabler/arrow-left'
import type { FileDto } from '@spm/contract/dtos.ts'
import {
  Box3,
  DirectionalLight,
  HemisphereLight,
  MathUtils,
  Mesh,
  MeshStandardMaterial,
  PerspectiveCamera,
  Scene,
  Vector3,
  WebGLRenderer,
  type Material,
  type Object3D,
  type Texture,
} from 'three'
import { OrbitControls } from 'three/addons/controls/OrbitControls.js'
import { ThreeMFLoader } from 'three/addons/loaders/3MFLoader.js'
import { OBJLoader } from 'three/addons/loaders/OBJLoader.js'
import { STLLoader } from 'three/addons/loaders/STLLoader.js'
import { API_CLIENT } from '../../core/api/api-client.token'
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

/**
 * Where a load ended up. One signal holding a discriminated union rather than a status flag
 * beside a message and a percentage: those three can drift into states that do not exist —
 * "failed, 60 % done" — and every one of the four outcomes has to be distinguishable.
 *
 * `extension` is the token the message names. It is the lowercased extension where there is
 * one and the whole file name where there is not, so no message can ever render a hole.
 */
export type LoadFailure = 'missing' | 'fetch' | 'parse' | 'empty'

export type ViewerState =
  | { status: 'loading'; progress: number | null }
  | { status: 'ready' }
  | { status: 'unsupported'; extension: string }
  | { status: 'failed'; reason: LoadFailure; extension: string }

/** Shared so that re-entering the loading state does not notify: signals compare by identity. */
const LOADING: ViewerState = { status: 'loading', progress: null }

/**
 * How much of the frame is left empty around the model, per side.
 *
 * The same 6 % the thumbnail rasterizer leaves — `MARGIN_FRACTION` in
 * `packages/core/src/previews/raster.ts` — so the two pictures are framed to the same house
 * rule. Only the margin is shared, not the whole fit: the rasterizer scales the model's
 * *projected extent* to the frame, where `frame()` below fits its bounding sphere, which for an
 * elongated part is markedly more conservative. The viewer will open somewhat smaller than the
 * thumbnail, and deliberately so (see `frame`).
 */
const MARGIN_FRACTION = 0.06

/**
 * Where the camera sits, as a direction only — the distance along it is the fit.
 *
 * The same direction task 1 hard-coded as a position, kept so the viewer still opens on the
 * three-quarter view it always did. Task 4 owns which direction it should be; this task owns
 * only how far along it the camera goes.
 */
const VIEW_DIRECTION = new Vector3(2.5, 2, 3).normalize()

/**
 * The lowercased extension including its dot, or `''` when the name has no dot at all.
 *
 * Lowercased, and that is load-bearing rather than tidy: the reference library genuinely
 * contains `.STL` files, and the server classifies and rasterizes them case-insensitively
 * (`extensionOf` in `packages/core/src/previews/mesh-handler.ts`), so they arrive here as
 * `kind: 'model'` with a thumbnail already rendered. Without the fold every uppercase model in
 * the library would open on "this viewer cannot show .STL files" — the exact bug B1 shipped.
 *
 * `lastIndexOf` over the whole name: a file name cannot contain a path separator (the server's
 * `fileNameSchema` rejects one), so the dot found is always the extension's or none.
 */
function extensionOf(name: string): string {
  const dot = name.lastIndexOf('.')
  return dot === -1 ? '' : name.slice(dot).toLowerCase()
}

/** Bytes to a scene graph. Throws whatever the underlying three.js loader throws. */
type ModelParser = (bytes: ArrayBuffer) => Object3D

/**
 * Exactly the three formats the server rasterizes, so the viewer opens precisely what the
 * project page shows a thumbnail for and nothing else pretends to be viewable.
 *
 * Keys are lowercase because every lookup goes through `extensionOf`, which folds case.
 */
const PARSERS: Readonly<Record<string, ModelParser>> = {
  // STL carries geometry and nothing else — no materials, no colours — so the one material in
  // the app is applied here. OBJ and 3MF bring their own and keep them.
  '.stl': (bytes) =>
    new Mesh(new STLLoader().parse(bytes), new MeshStandardMaterial({ roughness: 0.55 })),
  // The only arm that costs a second full-size copy of the file: OBJ has no binary form, so the
  // whole thing is decoded to a JS string before the loader sees it, and a large OBJ is large
  // precisely because it is text. Task 3's size threshold has to be chosen for this arm, not
  // for the STL one.
  '.obj': (bytes) => new OBJLoader().parse(new TextDecoder().decode(bytes)),
  '.3mf': (bytes) => new ThreeMFLoader().parse(bytes),
}

/**
 * What the "unsupported" message names as openable, derived from `PARSERS` rather than written
 * out in each locale — the two would otherwise drift apart silently the moment a loader is
 * added, in two languages at once.
 */
export const SUPPORTED_FORMATS: readonly string[] = Object.keys(PARSERS).map((extension) =>
  extension.slice(1).toUpperCase(),
)

/** A load that ended in a state the user has to be told about, carrying which one. */
class ModelLoadError extends Error {
  // A plain field, not a parameter property: `erasableSyntaxOnly` is on repo-wide.
  readonly reason: LoadFailure

  constructor(reason: LoadFailure) {
    super(reason)
    this.reason = reason
  }
}

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
    // Deliberately every node that has a geometry, not only meshes: an OBJ's `l` and `p`
    // elements load as `LineSegments` and `Points`, whose buffers cost exactly as much.
    const mesh = node as Partial<Mesh>
    mesh.geometry?.dispose()
    for (const material of materialsOf(mesh.material)) {
      for (const texture of texturesOf(material)) texture.dispose()
      material.dispose()
    }
  })
}

/**
 * How many triangles under `root` would actually be drawn.
 *
 * A file can parse cleanly and hold nothing to look at: an OBJ with vertices but no faces, an
 * STL whose header claims zero triangles, a 3MF whose build section is empty. Every one of
 * those renders as an empty canvas, which is the one outcome "failure is explicit" rules out —
 * so it is detected here and reported as a failure instead.
 *
 * Meshes only, unlike `disposeSubtree`: a model made purely of lines or points has nothing
 * solid in it either, and is just as blank on a printer's turntable.
 */
function triangleCount(root: Object3D): number {
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

@Component({
  selector: 'spm-viewer-page',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterLink, JigButton, JigIcon, JigMessage, JigProgress],
  template: `
    <main class="spm-main spm-main--viewer">
      <div class="spm-stack">
        <header class="spm-stack spm-stack--tight">
          <a jigButton kind="link" [routerLink]="['/projects', id()]">
            <jig-icon [icon]="icons.back" />
            {{ t.translations().viewer.back }}
          </a>
          <h1>{{ t.translations().viewer.title }}</h1>
        </header>

        <!--
          A canvas that never draws looks identical to a model that has not arrived yet, so a
          context that cannot be created — or one the browser has taken back — has to be said
          out loud rather than left blank.

          The load states hang off the @else: with no WebGL there is no load to report on, and
          a spinner beside "this browser could not open a 3D view" would say the opposite of
          the alert next to it.
        -->
        @if (initError(); as message) {
          <jig-message color="error" role="alert">{{ message }}</jig-message>
        } @else {
          @switch (state().status) {
            @case ('loading') {
              <!--
                role="status", not "alert": a download in progress is not an interruption, and
                the percentage updates several times a second.
              -->
              <div class="spm-row spm-viewer-progress" role="status">
                <jig-progress [value]="percent() ?? 0" [indeterminate]="percent() === null" />
                <span class="spm-muted">{{ loadingLabel() }}</span>
              </div>
            }
            @case ('unsupported') {
              <!-- Warning, not error: nothing went wrong, this file is simply not a model. -->
              <jig-message color="warning" role="alert">{{ statusMessage() }}</jig-message>
            }
            @case ('failed') {
              <jig-message color="error" role="alert">{{ statusMessage() }}</jig-message>
            }
          }
        }

        <!--
          The canvas is appended here by the component rather than written in the template:
          three.js has to own the element it holds a context on, and dropping that element is
          part of teardown (see ngOnDestroy).

          role/aria-label sit on the container, not on the canvas, so the label stays bound
          and follows a language change; the canvas itself carries no accessible content.
          Both are dropped whenever there is no model on screen: announcing "3D view of the
          model" beside an alert saying there is no model tells a screen-reader user two
          opposite things, and so does announcing it while the bytes are still arriving.
        -->
        <div
          #viewport
          class="spm-viewport"
          [attr.role]="showsModel() ? 'img' : null"
          [attr.aria-label]="showsModel() ? t.translations().viewer.canvasLabel : null"
        ></div>
      </div>
    </main>
  `,
})
export class ViewerPage implements AfterViewInit, OnDestroy {
  private readonly document = inject(DOCUMENT)
  private readonly createRenderer = inject(VIEWER_RENDERER_FACTORY)
  private readonly api = inject(API_CLIENT)
  private readonly pendingTasks = inject(PendingTasks)
  protected readonly t = inject(TranslateService)
  protected readonly icons = { back: tablerArrowLeft }

  readonly id = input.required<string>()
  readonly fileId = input.required<string>()

  private readonly viewport = viewChild.required<ElementRef<HTMLElement>>('viewport')

  readonly initError = signal<string | null>(null)

  /**
   * The file's metadata, which is where `rawUrl` comes from.
   *
   * The project rather than the file, because `ApiClient` has no per-file read — and adding
   * one would mean touching `packages/contract`. The project detail is a small JSON document
   * that the page the viewer is opened from has already fetched, so this is a cache hit in
   * every real navigation and a cheap request in a cold load from a bookmark.
   */
  readonly project = resource({
    params: () => this.id(),
    loader: ({ params }) => this.api.projects.get(params),
  })

  /**
   * The route's file, or undefined while the project is still in flight *and* when the project
   * loaded but holds no such file. `hasValue()` first: `Resource.value()` throws once a load
   * settles to 'error'.
   */
  readonly file = computed<FileDto | undefined>(() => {
    if (!this.project.hasValue()) return undefined
    const fileId = this.fileId()
    return this.project.value().files.find((candidate) => candidate.id === fileId)
  })

  readonly state = signal<ViewerState>(LOADING)

  /** Whole percent, or null when the size is unknown and the bar has to be indeterminate. */
  protected readonly percent = computed(() => {
    const state = this.state()
    if (state.status !== 'loading' || state.progress === null) return null
    return Math.round(state.progress * 100)
  })

  protected readonly loadingLabel = computed(() => {
    const percent = this.percent()
    const viewer = this.t.translations().viewer
    return percent === null ? viewer.loading : interpolate(viewer.loadingPercent, { percent })
  })

  /**
   * What the failure says. Derived from the state rather than stored as a string when the
   * failure happens, so the wording follows a language change like everything else on the page.
   */
  protected readonly statusMessage = computed<string | null>(() => {
    const state = this.state()
    const viewer = this.t.translations().viewer
    if (state.status === 'unsupported') {
      // `formats` comes from PARSERS, so adding a loader cannot leave two locales claiming a
      // shorter list than the viewer actually opens.
      return interpolate(viewer.unsupported, {
        extension: state.extension,
        formats: SUPPORTED_FORMATS.join(', '),
      })
    }
    if (state.status !== 'failed') return null
    switch (state.reason) {
      case 'missing':
        return viewer.missingFile
      case 'fetch':
        return viewer.fetchFailed
      case 'parse':
        return interpolate(viewer.parseFailed, { extension: state.extension })
      case 'empty':
        return viewer.emptyModel
    }
  })

  /** Whether there is really something in the canvas to describe. */
  protected readonly showsModel = computed(
    () => this.initError() === null && this.state().status === 'ready',
  )

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
  /** Which project/file the current content was built from, so `syncContent` is idempotent. */
  private loadedKey: string | null = null
  /**
   * Bumped once per load. A fetch is slower than a navigation, so f1's bytes routinely land
   * after the route has already moved to f2; the token is how a finished load knows whether
   * the scene is still its to fill.
   */
  private loadToken = 0
  /** The download in progress, so it can be called off. See `abortInFlight`. */
  private inFlight: AbortController | null = null
  /**
   * Set the first time the user touches the controls. After that the camera is theirs and the
   * automatic fit stops moving it — see `resize`.
   */
  private userMovedCamera = false

  constructor() {
    // The router reuses this one instance across a `:fileId` change — it only swaps the
    // input, the same trap project-detail.page.ts documents at length for `:id`. So
    // ngAfterViewInit does not re-run, and without this the viewer would keep showing the
    // previous model after a "next file" navigation. The effect also covers the other
    // trigger: the project metadata arriving after the view is already up.
    effect(() => this.syncContent())
  }

  /**
   * The browser took the context back. Chrome caps live contexts at about 16 and evicts the
   * *oldest* rather than refusing a new one, so this — not a constructor failure — is what
   * the "too many 3D views are already open" half of the message actually looks like.
   *
   * three.js registers its own internal `onContextLost` but never tells the application, so
   * without this the page is a frozen canvas with no words on it and a `render()` that throws
   * on every frame. `preventDefault()` is deliberately not called: that is what asks for a
   * `webglcontextrestored` event, and restoring would mean rebuilding the whole scene.
   */
  private readonly onContextLost = (): void => {
    this.renderer?.setAnimationLoop(null)
    this.initError.set(this.t.translations().viewer.noWebgl)
  }

  /**
   * The user has taken hold of the camera; from here on it is theirs and `resize` stops
   * re-fitting it.
   *
   * Bound to the canvas's own input events rather than to OrbitControls' 'start', so the flag
   * does not depend on which events the controls happen to dispatch internally — and so a test
   * can produce it, which a real pointer-capture sequence cannot be in jsdom.
   */
  private readonly onUserInput = (): void => {
    this.userMovedCamera = true
  }

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
    canvas.addEventListener('webglcontextlost', this.onContextLost)

    // Transparent clear. The background is `.spm-viewport`'s CSS, which is a jig theme token,
    // so the viewer is legible in both themes and follows a light/dark switch with no JS at
    // all — where a colour chosen here would have to be recomputed on every theme change.
    renderer.setClearColor(0x000000, 0)
    // Capped at 2: beyond that the pixel count grows faster than anything visible does.
    renderer.setPixelRatio(Math.min(this.document.defaultView?.devicePixelRatio ?? 1, 2))

    const scene = new Scene()
    this.scene = scene

    // Near and far are placeholders until a model is framed; `frame()` sizes them to it.
    const camera = new PerspectiveCamera(50, 1, 0.1, 1000)
    camera.position.copy(VIEW_DIRECTION).multiplyScalar(4)
    this.camera = camera

    // Two lights, not one: with a single directional light every face turned away from it
    // renders black, which against a light theme reads as a hole rather than as a shadow.
    scene.add(new HemisphereLight(0xffffff, 0x404040, 2))
    const key = new DirectionalLight(0xffffff, 1.5)
    key.position.set(4, 8, 6)
    scene.add(key)

    canvas.addEventListener('pointerdown', this.onUserInput)
    canvas.addEventListener('wheel', this.onUserInput)

    const controls = new OrbitControls(camera, canvas)
    controls.enableDamping = true
    this.controls = controls

    // The first load. The effect in the constructor may already have run — before the view
    // existed, so it did nothing but subscribe — which is why syncContent is idempotent.
    this.syncContent()

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
    // Whatever is still downloading belongs to nobody now. Without this a 164 MB STL goes on
    // arriving for minutes after the user has left: its whole buffer stays resident, the
    // server's stream stays open (this ships onto 2 GB NAS boxes), and when it finally lands
    // the destroyed component still parses it and builds a second full-size BufferGeometry —
    // blocking whatever page the user went to — purely so it can be disposed. Nothing bounds
    // how many of those can pile up.
    //
    // The token is bumped as well, so the residual race — an abort that arrives after the last
    // read — lands in `load`'s stale arm instead of writing state, and `onProgress` stops
    // repainting a dead component's signals.
    this.loadToken++
    this.abortInFlight()

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

    this.canvas?.removeEventListener('webglcontextlost', this.onContextLost)
    this.canvas?.removeEventListener('pointerdown', this.onUserInput)
    this.canvas?.removeEventListener('wheel', this.onUserInput)
    this.canvas?.remove()
    this.canvas = null
  }

  /**
   * Calls off the download in progress, if there is one.
   *
   * Used both on teardown and when a newer file supersedes an older one: navigating from a slow
   * file to a fast one otherwise leaves the first still arriving, to be thrown away on the doorstep.
   */
  private abortInFlight(): void {
    this.inFlight?.abort()
    this.inFlight = null
  }

  /**
   * Builds the content for the current route unless it is already on screen.
   *
   * Idempotent on purpose: it is called both from `ngAfterViewInit` and from an effect, and
   * which of the two runs first is Angular's business, not this component's.
   */
  private syncContent(): void {
    // Read first and unconditionally — this is what subscribes the effect. An early return
    // above any of these would leave the effect subscribed to less than it depends on, and a
    // later change to the missing one would go unnoticed.
    const key = `${this.id()}/${this.fileId()}`
    const metadataFailed = this.project.status() === 'error'
    const settled = metadataFailed || this.project.hasValue()
    const file = this.file()

    if (!this.scene || this.loadedKey === key) return
    if (!settled) {
      // The project is still in flight. Nothing to load yet, and nothing to record either —
      // the effect runs again when it settles.
      this.state.set(LOADING)
      return
    }

    this.loadedKey = key
    // Registered as a pending task so the application counts as unstable while a model is
    // downloading: `ApplicationRef.whenStable()` is what tests and SSR both wait on, and a
    // bare promise chain is invisible to it.
    void this.pendingTasks.run(() => this.load(file, metadataFailed))
  }

  /**
   * One load, start to finish: decide, fetch, parse, frame, swap — and put the page into
   * exactly one of the four states on the way out.
   *
   * `file` is undefined for two different reasons and they do not read the same: the project
   * loaded and holds no such id (a stale link, or a file deleted from another tab), or the
   * project could not be fetched at all (`metadataFailed`, a network problem the user can
   * retry).
   */
  private async load(file: FileDto | undefined, metadataFailed: boolean): Promise<void> {
    // Bump first, abort second, and that order is load-bearing: the aborted load's continuation
    // has to find its own token already stale, or it would report its own cancellation to the
    // user as a failed download of the file they have just moved on to.
    const token = ++this.loadToken
    this.abortInFlight()
    this.state.set(LOADING)

    if (!file) {
      const reason = metadataFailed ? 'fetch' : 'missing'
      this.state.set({ status: 'failed', reason, extension: '' })
      return
    }

    const parse = PARSERS[extensionOf(file.name)]
    // The whole name when there is no extension, so no message renders an empty slot.
    const extension = extensionOf(file.name) || file.name
    if (!parse) {
      // Decided before anything is fetched, which is also where task 3's size gate belongs:
      // both are reasons not to open a connection at all.
      this.state.set({ status: 'unsupported', extension })
      return
    }

    const inFlight = new AbortController()
    this.inFlight = inFlight

    let content: Object3D
    try {
      content = await this.createContent(file, parse, token, inFlight.signal)
    } catch (error) {
      if (token !== this.loadToken) return
      const reason = error instanceof ModelLoadError ? error.reason : 'parse'
      this.state.set({ status: 'failed', reason, extension })
      return
    } finally {
      if (this.inFlight === inFlight) this.inFlight = null
    }

    if (token !== this.loadToken) {
      // A newer load already owns the scene. Released here rather than dropped: handing it to
      // `setContent` would evict the model that *is* current, and dropping it would strand its
      // buffers on the GPU.
      //
      // Since supersession now aborts the older transfer, a stale load normally dies in the
      // catch above rather than arriving here with a finished model — the only awaits between
      // the abort point and this line are network reads, and a macrotask teardown cannot
      // interleave into the microtask hop out of `createContent`. That is a property of today's
      // await topology, not of the design: parsing a 164 MB STL off the main thread, which is
      // where this is heading, reopens the window immediately. Pinned by a seam test.
      disposeSubtree(content)
      return
    }

    // A new model gets a fresh fit even if the previous one had been orbited around.
    this.userMovedCamera = false
    this.frame(content)
    this.setContent(content)
    this.state.set({ status: 'ready' })
  }

  /**
   * The one place where a file's bytes become geometry.
   *
   * Everything that can go wrong on the way leaves as a `ModelLoadError` naming which of the
   * three failures it was, so `load` above states the outcome and never has to guess.
   */
  private async createContent(
    file: FileDto,
    parse: ModelParser,
    token: number,
    signal: AbortSignal,
  ): Promise<Object3D> {
    const bytes = await this.fetchModel(file, signal, (progress) => {
      // A stale load must not repaint the progress bar of the one that replaced it.
      if (token === this.loadToken) this.state.set({ status: 'loading', progress })
    })

    let content: Object3D
    try {
      content = parse(bytes)
    } catch {
      throw new ModelLoadError('parse')
    }

    if (triangleCount(content) === 0) {
      // Parsed, and empty. Released before the throw: it is a real scene graph either way.
      disposeSubtree(content)
      throw new ModelLoadError('empty')
    }
    return content
  }

  /**
   * The one place a model's bytes are fetched, and therefore the one place there is to gate.
   *
   * Task 3 gates earlier still — in `load`, beside the unsupported-extension arm — because a
   * file over the size threshold must not open a connection at all; this stays the only door
   * to the network so that gate cannot be routed around.
   */
  private async fetchModel(
    file: FileDto,
    signal: AbortSignal,
    onProgress: (progress: number | null) => void,
  ): Promise<ArrayBuffer> {
    let response: Response
    try {
      response = await fetch(file.rawUrl, { credentials: 'same-origin', signal })
    } catch {
      throw new ModelLoadError('fetch')
    }
    // The bytes are gone, or the id no longer resolves — a different thing from a connection
    // that would not open, and there is already a message that says so and points back at the
    // project. Anything else that is not 2xx is a transport problem the user can retry.
    if (response.status === 404 || response.status === 410) throw new ModelLoadError('missing')
    if (!response.ok) throw new ModelLoadError('fetch')

    const body = response.body
    // No readable stream to be had. Still correct, just silent about progress.
    if (!body) {
      try {
        return await response.arrayBuffer()
      } catch {
        throw new ModelLoadError('fetch')
      }
    }

    // Pre-allocated at the size the DTO already carries, and written into as the chunks
    // arrive. Collecting the chunks and concatenating at the end would hold the whole file
    // twice at the moment of the copy, and the reference library has a 164 MB STL in it.
    const total = file.sizeBytes
    const buffer = total > 0 ? new Uint8Array(total) : null
    // What arrived once the buffer was full or absent — a stale DTO, or a proxy that
    // re-encodes. Once a chunk lands here `received` has passed `total`, so every later one
    // does too and the two halves stay in order.
    const spill: Uint8Array[] = []
    let placed = 0
    let received = 0

    const reader = body.getReader()
    // Aborting the signal already errors this stream, per the Fetch standard, so a pending
    // read would reject on its own. The reader is cancelled anyway for two reasons: a
    // `Response` that did not come from this fetch — a cache hit, a service worker's reply —
    // is not wired to the signal at all; and cancellation is the half that is *observable*,
    // where `signal.aborted` says only that the intent was expressed.
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
      // The connection dropped part-way. Emphatically *not* a parse failure: telling someone to
      // re-upload a perfectly good 164 MB model because their wifi blinked is the wrong advice,
      // and over a home connection a mid-stream drop is the likely failure, not a corner case.
      throw new ModelLoadError('fetch')
    } finally {
      signal.removeEventListener('abort', stopReading)
    }

    // Cancelled rather than finished: `reader.cancel()` ends the loop cleanly, so without this
    // a torn-off transfer would hand a truncated buffer to a parser as if it were the file.
    if (signal.aborted) throw new ModelLoadError('fetch')

    if (buffer && received === total) return buffer.buffer
    const out = new Uint8Array(received)
    if (buffer) out.set(buffer.subarray(0, placed))
    let offset = placed
    for (const chunk of spill) {
      out.set(chunk, offset)
      offset += chunk.byteLength
    }
    return out.buffer
  }

  /**
   * Centres `content` on the origin and pulls the camera back far enough to hold all of it.
   *
   * The fit is to the model's bounding *sphere*, not to its projected outline: the user can
   * orbit, and the sphere is the only bound that still holds after they do — fitting the
   * silhouette, as the thumbnail rasterizer does, would put a long, flat model half off-screen
   * the moment it turned. The cost is that an elongated part opens somewhat smaller here than
   * its thumbnail looks, which is the right trade for a view that moves. It is
   * computed against both the vertical and the horizontal field of view and the wider distance
   * wins, so a tall model in a wide viewport is framed by its height and not cropped by it.
   *
   * Task 1's fixed `(2.5, 2, 3)` was right for a unit cube and useless for anything else. A
   * printable STL is tens to hundreds of millimetres across and sits wherever its exporter left
   * it, so the camera was both far too close and pointed nowhere near it — a correctly loaded
   * model, and a completely blank canvas.
   */
  private frame(content: Object3D): void {
    const camera = this.camera
    if (!camera) return

    const box = new Box3().setFromObject(content)
    if (box.isEmpty()) return

    // Centred by moving the model, not the camera: OrbitControls orbits its `target`, so a
    // model centred on the origin is a model that spins about itself rather than swinging.
    content.position.sub(box.getCenter(new Vector3()))

    // Half the box's diagonal — the radius of the sphere about its centre that contains it.
    // Floored away from zero so a degenerate model cannot divide anything by nothing.
    const radius = Math.max(box.getSize(new Vector3()).length() / 2, 1e-6)

    const halfFovY = MathUtils.degToRad(camera.fov) / 2
    const halfFovX = Math.atan(Math.tan(halfFovY) * camera.aspect)
    const distance =
      Math.max(radius / Math.sin(halfFovY), radius / Math.sin(halfFovX)) / (1 - 2 * MARGIN_FRACTION)

    camera.position.copy(VIEW_DIRECTION).multiplyScalar(distance)
    // Sized to the model rather than left at task 1's fixed 0.1 / 1000, which quietly assumes
    // every model is within an order of magnitude or two of a unit cube. A model exported in
    // metres is smaller than that near plane; a laser scan in microns, or anything a few metres
    // across, is beyond that far one. Both render as a blank canvas with nothing else wrong.
    camera.near = distance / 1000
    camera.far = (distance + radius) * 10
    camera.updateProjectionMatrix()

    camera.lookAt(0, 0, 0)
    this.controls?.target.set(0, 0, 0)
    this.controls?.update()
  }

  /**
   * The one place the scene's contents change. Whatever was there before is removed and
   * disposed first, so replacing a model cannot leak one and `null` is a full teardown.
   */
  private setContent(next: Object3D | null): void {
    const scene = this.scene
    if (!scene) {
      // There is nothing to put it in, so nothing will ever release it either, and dropping it
      // would strand its geometry, material and textures on the GPU.
      //
      // Defensive, and deliberately kept: `ngOnDestroy` now aborts the download and bumps the
      // load token, so a parsed model cannot reach here through `load` as the awaits stand
      // today. It is a guard against an await being added between the abort point and the
      // install — parsing in a Worker being the obvious one — and against any future caller.
      // Pinned by a seam test, which is the ordinary condition of defensive code.
      if (next) disposeSubtree(next)
      return
    }
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

    // The fit depends on the aspect ratio, and a container that narrows — a window dragged
    // thin, a phone turned upright — crops a model that was framed while it was wide. So the
    // fit is redone, but only while the camera is still the one this component placed:
    // re-framing after the user has orbited or zoomed would undo their work every time the
    // window moved.
    if (this.content && !this.userMovedCamera) this.frame(this.content)
  }
}
