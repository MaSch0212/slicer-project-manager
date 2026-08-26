import { ApplicationRef, signal } from '@angular/core'
import { TestBed } from '@angular/core/testing'
import { Router, provideRouter, withComponentInputBinding } from '@angular/router'
import { RouterTestingHarness } from '@angular/router/testing'
import {
  Box3,
  BoxGeometry,
  BufferGeometry,
  DataTexture,
  DoubleSide,
  Frustum,
  Material,
  Matrix4,
  Mesh,
  MeshStandardMaterial,
  PerspectiveCamera,
  Texture,
  Vector3,
  type AmbientLight,
  type DirectionalLight,
  type Light,
  type MeshLambertMaterial,
  type Object3D,
  type Scene,
  type WebGLRenderer,
} from 'three'
import { OrbitControls } from 'three/addons/controls/OrbitControls.js'
import { ThreeMFLoader } from 'three/addons/loaders/3MFLoader.js'
import { OBJLoader } from 'three/addons/loaders/OBJLoader.js'
import { STLLoader } from 'three/addons/loaders/STLLoader.js'
import { strToU8, zipSync } from 'three/addons/libs/fflate.module.js'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Capabilities, FileDto, ProjectDetailDto } from '@spm/contract/dtos.ts'
import { API_CLIENT } from '../../core/api/api-client.token'
import { AuthStore } from '../../core/auth.store'
import { CapabilitiesStore } from '../../core/capabilities.store'
import { formatBytes } from '../../core/format-bytes'
import { authGuard } from '../../core/guards'
import { TranslateService } from '../../core/i18n/translate.service'
import en from '../../core/i18n/locales/en.json'
import { sharedRoutes } from '../../routes.shared'
import { provideJigForTests } from '../../../testing/jig'
import {
  SUPPORTED_FORMATS,
  VIEWER_RENDERER_FACTORY,
  ViewerPage,
  limitOf,
  sizeLimitFor,
  type ViewerState,
} from './viewer.page'

const CAPABILITIES: Capabilities = {
  requiresAuth: true,
  canManageUsers: false,
  canPickLocalFolder: false,
  canLaunchSlicer: false,
  canConfigureSlicers: false,
  canBrowseModelSites: false,
}

const VIEW_URL = '/projects/p1/view/f1'

// ------------------------------------------------------------------ model fixtures

/**
 * A box, deliberately off-origin and deliberately not a cube: a fit that forgot to centre and
 * a fit that used one axis for all three both still look right on a unit cube at the origin,
 * which is exactly why task 1's hard-coded camera survived a whole task without complaint.
 * Millimetres, because that is what a printable model is measured in.
 */
const BOX_MIN: [number, number, number] = [10, 20, 30]
const BOX_MAX: [number, number, number] = [30, 60, 130]

const CORNERS: [number, number, number][] = [
  [BOX_MIN[0], BOX_MIN[1], BOX_MIN[2]],
  [BOX_MAX[0], BOX_MIN[1], BOX_MIN[2]],
  [BOX_MAX[0], BOX_MAX[1], BOX_MIN[2]],
  [BOX_MIN[0], BOX_MAX[1], BOX_MIN[2]],
  [BOX_MIN[0], BOX_MIN[1], BOX_MAX[2]],
  [BOX_MAX[0], BOX_MIN[1], BOX_MAX[2]],
  [BOX_MAX[0], BOX_MAX[1], BOX_MAX[2]],
  [BOX_MIN[0], BOX_MAX[1], BOX_MAX[2]],
]

/** The six quads, wound outwards. */
const QUADS: [number, number, number, number][] = [
  [0, 3, 2, 1],
  [4, 5, 6, 7],
  [0, 1, 5, 4],
  [2, 3, 7, 6],
  [1, 2, 6, 5],
  [3, 0, 4, 7],
]

/** The same twelve triangles every one of the three fixtures below encodes. */
const TRIANGLES: [number, number, number][] = QUADS.flatMap(
  ([a, b, c, d]): [number, number, number][] => [
    [a, b, c],
    [a, c, d],
  ],
)

/**
 * A real binary STL, built here rather than checked in as a binary blob for the same reason
 * e2e/preview.spec.ts builds its cube inline: what the loader parses is readable in the diff.
 * It has to be genuinely parseable — a placeholder like `solid box` would only ever prove that
 * the loader can fail.
 */
function binaryStl(triangles: [number, number, number][], scale = 1): Uint8Array {
  const out = new Uint8Array(84 + triangles.length * 50)
  const view = new DataView(out.buffer)
  // The 80-byte header is left zeroed, which is also what makes STLLoader's `isBinary` take
  // the byte-length branch rather than sniffing for the ASCII "solid".
  view.setUint32(80, triangles.length, true)
  let offset = 84
  for (const triangle of triangles) {
    offset += 12 // facet normal left zero; three.js recomputes shading from the geometry
    for (const corner of triangle) {
      for (const value of CORNERS[corner]!) {
        view.setFloat32(offset, value * scale, true)
        offset += 4
      }
    }
    offset += 2 // attribute byte count
  }
  return out
}

/**
 * UTF-8 bytes, re-wrapped in *this* realm's `Uint8Array`.
 *
 * fflate's `strToU8` returns whatever `TextEncoder` hands back, which under vitest's jsdom
 * environment belongs to Node's realm while the module's own `Uint8Array` is jsdom's. `zipSync`
 * tests `value instanceof Uint8Array` to tell a file from a directory, so without this re-wrap
 * it silently zips each byte of the content as a separate nested entry.
 */
function utf8(text: string): Uint8Array {
  return new Uint8Array(strToU8(text))
}

function objText(): Uint8Array {
  const lines = [
    ...CORNERS.map(([x, y, z]) => `v ${x} ${y} ${z}`),
    // OBJ vertex indices are 1-based.
    ...TRIANGLES.map(([a, b, c]) => `f ${a + 1} ${b + 1} ${c + 1}`),
  ]
  return utf8(lines.join('\n') + '\n')
}

/**
 * A minimal but real 3MF: an OPC zip holding the package relationships and one 3D model part.
 * ThreeMFLoader resolves the model part through `_rels/.rels`, so both entries are load-bearing
 * and a zip with only the model in it does not parse.
 */
function threeMf(): Uint8Array {
  const rels =
    '<?xml version="1.0" encoding="UTF-8"?>' +
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    '<Relationship Id="rel0" Target="/3D/3dmodel.model"' +
    ' Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/>' +
    '</Relationships>'
  const model =
    '<?xml version="1.0" encoding="UTF-8"?>' +
    '<model unit="millimeter"' +
    ' xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02">' +
    '<resources><object id="1" type="model"><mesh><vertices>' +
    CORNERS.map(([x, y, z]) => `<vertex x="${x}" y="${y}" z="${z}"/>`).join('') +
    '</vertices><triangles>' +
    TRIANGLES.map(([a, b, c]) => `<triangle v1="${a}" v2="${b}" v3="${c}"/>`).join('') +
    '</triangles></mesh></object></resources>' +
    '<build><item objectid="1"/></build></model>'
  // Stored rather than deflated: the bytes in the diff are the bytes the loader inflates.
  return zipSync({ '_rels/.rels': utf8(rels), '3D/3dmodel.model': utf8(model) }, { level: 0 })
}

const STL_BOX = binaryStl(TRIANGLES)
const OBJ_BOX = objText()
const THREEMF_BOX = threeMf()
/** A structurally valid STL that declares, and contains, nothing to draw. */
const STL_EMPTY = binaryStl([])
/** A different model, so "which of the two is in the scene" is answerable by counting. */
const STL_WEDGE = binaryStl(TRIANGLES.slice(0, 4))
/** An upload that stopped part-way: the header promises twelve triangles and delivers two. */
const STL_TRUNCATED = STL_BOX.slice(0, 184)

// ------------------------------------------------------------------ transport doubles

/**
 * A stand-in for `Response`.
 *
 * Hand-built rather than a real one so a test can decide exactly where the chunk boundaries
 * fall — which is the whole of what the progress reporting is computed from — and so the spec
 * does not depend on which `fetch` implementation the jsdom environment happens to expose.
 */
function fakeResponse(body: ReadableStream<Uint8Array> | null, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    body,
    arrayBuffer: async () => new ArrayBuffer(0),
  } as unknown as Response
}

/**
 * A 2xx response with no readable stream at all, which is what a cache hit or a service
 * worker's reply can look like — the one path where progress cannot be reported and the bytes
 * come from `arrayBuffer()` in a single lump. `bytes: null` makes that call reject.
 */
function bodilessResponse(bytes: Uint8Array | null): Response {
  return {
    ok: true,
    status: 200,
    body: null,
    arrayBuffer: async () => {
      if (!bytes) throw new TypeError('network error')
      return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)
    },
  } as unknown as Response
}

/** A response that dies part-way through its body, the way a dropped connection does. */
function truncatedResponse(bytes: Uint8Array, at: number): Response {
  return fakeResponse(
    new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes.slice(0, at))
        controller.error(new TypeError('network error'))
      },
    }),
  )
}

/** A response whose body arrives in one go. */
function servedAtOnce(bytes: Uint8Array): Response {
  return fakeResponse(
    new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes)
        controller.close()
      },
    }),
  )
}

/**
 * A response whose chunks the test releases one at a time, so progress — and, more to the point,
 * a transfer being cut off part-way — is observable.
 *
 * `cancelled()` is the direct evidence that an abandoned download really stops: the component
 * cancels the body reader, which runs this stream's `cancel`.
 */
function paced(
  bytes: Uint8Array,
  count: number,
): { response: Response; next: () => void; cancelled: () => boolean } {
  const size = Math.ceil(bytes.byteLength / count)
  const gates: Array<() => void> = []
  const waits: Promise<void>[] = []
  for (let index = 0; index < count; index++) {
    waits.push(new Promise<void>((resolve) => gates.push(resolve)))
  }
  let sent = 0
  let cancelled = false
  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      await waits[sent]!
      sent += 1
      // The stream may have been cancelled while this pull sat on its gate, and enqueueing into
      // a closed controller throws — which would surface as an unhandled rejection rather than
      // as the test's own assertion.
      if (cancelled) return
      const start = (sent - 1) * size
      controller.enqueue(bytes.slice(start, Math.min(start + size, bytes.byteLength)))
      if (sent >= count) controller.close()
    },
    cancel() {
      cancelled = true
    },
  })
  return {
    response: fakeResponse(stream),
    next: () => gates.shift()?.(),
    cancelled: () => cancelled,
  }
}

// ------------------------------------------------------------------ Angular doubles

/**
 * A stand-in for `WebGLRenderer`, because jsdom has no WebGL at all: a real one throws in its
 * constructor here, which is the very path the "says so in words" test exercises. Everything
 * else in the scene — the geometry, the material, the texture, the controls — is the real
 * three.js object, so those disposals are asserted on the real prototypes below.
 */
function fakeRenderer(canvas: HTMLCanvasElement) {
  const fake = {
    domElement: canvas,
    /** What the component last handed to setAnimationLoop; null means the loop is stopped. */
    animationLoop: null as (() => void) | null,
    clearAlpha: null as number | null,
    sizes: [] as [number, number][],
    /** The scene and camera of the last frame drawn, which is where the model can be found. */
    lastFrame: null as { scene: Scene; camera: PerspectiveCamera } | null,
    setClearColor: vi.fn((_color: unknown, alpha?: number) => {
      fake.clearAlpha = alpha ?? 1
    }),
    setPixelRatio: vi.fn(),
    setSize: vi.fn((width: number, height: number) => {
      fake.sizes.push([width, height])
    }),
    setAnimationLoop: vi.fn((callback: (() => void) | null) => {
      fake.animationLoop = callback
    }),
    render: vi.fn((scene: Scene, camera: PerspectiveCamera) => {
      fake.lastFrame = { scene, camera }
    }),
    dispose: vi.fn(),
    forceContextLoss: vi.fn(),
    /** Drives one frame the way the browser would, so "the loop stopped" is observable. */
    tick: () => fake.animationLoop?.(),
  }
  return fake
}

type FakeRenderer = ReturnType<typeof fakeRenderer>

/** A factory that keeps every renderer it built, so a test can find the one that was used. */
function recording(made: FakeRenderer[]): (canvas: HTMLCanvasElement) => WebGLRenderer {
  return (canvas) => {
    const fake = fakeRenderer(canvas)
    made.push(fake)
    return fake as unknown as WebGLRenderer
  }
}

/**
 * jsdom ships no ResizeObserver, and the component deliberately uses one rather than a window
 * listener — so the test supplies one it can fire on demand, which is also the only way to
 * give the viewport a non-zero box in jsdom (clientWidth is always 0 there).
 */
class FakeResizeObserver {
  static instances: FakeResizeObserver[] = []
  readonly targets: Element[] = []
  disconnected = false
  private readonly callback: ResizeObserverCallback

  constructor(callback: ResizeObserverCallback) {
    this.callback = callback
    FakeResizeObserver.instances.push(this)
  }

  observe(target: Element): void {
    this.targets.push(target)
  }

  unobserve(): void {}

  disconnect(): void {
    this.disconnected = true
  }

  emit(width: number, height: number): void {
    this.callback(
      [{ contentRect: { width, height } } as ResizeObserverEntry],
      this as unknown as ResizeObserver,
    )
  }
}

/** When a mock's nth call happened, and a real failure rather than `undefined` if it did not. */
function callOrder(mock: { mock: { invocationCallOrder: number[] } }, index: number): number {
  const order = mock.mock.invocationCallOrder[index]
  if (order === undefined) throw new Error(`call ${index} never happened`)
  return order
}

type Spies = {
  geometry: ReturnType<typeof vi.spyOn>
  material: ReturnType<typeof vi.spyOn>
  texture: ReturnType<typeof vi.spyOn>
  controls: ReturnType<typeof vi.spyOn>
}

function spyOnDisposals(): Spies {
  return {
    geometry: vi.spyOn(BufferGeometry.prototype, 'dispose'),
    material: vi.spyOn(Material.prototype, 'dispose'),
    texture: vi.spyOn(Texture.prototype, 'dispose'),
    controls: vi.spyOn(OrbitControls.prototype, 'dispose'),
  }
}

// ------------------------------------------------------------------ fixtures and setup

function fileDto(over: Partial<FileDto> = {}): FileDto {
  return {
    id: 'f1',
    name: 'box.stl',
    kind: 'model',
    sizeBytes: STL_BOX.byteLength,
    previewState: 'ready',
    rawUrl: '/api/files/f1/raw',
    ...over,
  }
}

function projectDto(files: FileDto[]): ProjectDetailDto {
  return {
    id: 'p1',
    name: 'Benchy',
    isArchived: false,
    state: 'ok',
    tags: [],
    fileCounts: { model: files.length, slicerProject: 0, other: 0 },
    createdAt: 0,
    updatedAt: 0,
    files,
  }
}

type Options = {
  create?: (canvas: HTMLCanvasElement) => WebGLRenderer
  /** The project's files. The default is one `.stl` at f1 and one at f2. */
  files?: FileDto[]
  /** Overrides `projects.get`, for the "the metadata itself failed" case. */
  get?: () => Promise<ProjectDetailDto>
  /** What the network hands back for a `rawUrl`. The default serves STL_BOX in one chunk. */
  serve?: (url: string) => Promise<Response>
  url?: string
  authenticated?: boolean
  /** Await the load before returning. False when the test wants to watch it happen. */
  wait?: boolean
}

const settle = () => TestBed.inject(ApplicationRef).whenStable()

/** The TestBed, with the real route table but nothing navigated yet. */
async function configure(options: Options): Promise<{ fetch: ReturnType<typeof vi.fn> }> {
  const files = options.files ?? [fileDto(), fileDto({ id: 'f2', rawUrl: '/api/files/f2/raw' })]
  const get = options.get ?? (() => Promise.resolve(projectDto(files)))
  const serve = options.serve ?? (() => Promise.resolve(servedAtOnce(STL_BOX)))

  // The viewer fetches the model itself rather than through ApiClient — rawUrl is a plain
  // static route, not a JSON endpoint — so the double is on `fetch`, not on the client.
  // `init` is declared but unused on purpose: it is what carries the abort signal, and the
  // cancellation tests read it back off `fetch.mock.calls`.
  const fetchStub = vi.fn((url: string, _init?: RequestInit) => serve(url))
  vi.stubGlobal('fetch', fetchStub)

  TestBed.configureTestingModule({
    providers: [
      ...provideJigForTests(),
      // The real route table, plus one inert route to navigate away to: leaving for
      // /projects would lazily load a page that wants an API client, which has nothing to
      // do with what is under test here.
      provideRouter(
        [...sharedRoutes, { path: 'blank', children: [] }],
        withComponentInputBinding(),
      ),
      { provide: CapabilitiesStore, useValue: { capabilities: signal(CAPABILITIES) } },
      {
        provide: AuthStore,
        useValue: {
          isAuthenticated: signal(options.authenticated ?? true),
          isAdmin: signal(false),
        },
      },
      { provide: VIEWER_RENDERER_FACTORY, useValue: options.create ?? recording([]) },
      { provide: API_CLIENT, useValue: { projects: { get: vi.fn(get) } } },
    ],
  })
  await TestBed.inject(TranslateService).ready
  return { fetch: fetchStub }
}

async function setup(options: Options = {}): Promise<{
  harness: RouterTestingHarness
  page: ViewerPage
  host: HTMLElement
  observer: FakeResizeObserver | undefined
  fetch: ReturnType<typeof vi.fn>
}> {
  const { fetch } = await configure(options)

  const harness = await RouterTestingHarness.create()
  const page = await harness.navigateByUrl(options.url ?? VIEW_URL, ViewerPage)
  harness.detectChanges()
  // The load is registered with PendingTasks, so application stability covers it as well as
  // the project fetch — one await for the whole pipeline.
  if (options.wait !== false) await settle()
  harness.detectChanges()

  return {
    harness,
    page,
    host: harness.routeNativeElement as HTMLElement,
    observer: FakeResizeObserver.instances.at(-1),
    fetch,
  }
}

/**
 * Reaches past `private`, which TypeScript only enforces at compile time.
 *
 * Both branches these drive are defensive: a supersession aborts the older transfer and a
 * teardown aborts and bumps the token, so with today's await topology neither "a parsed model
 * arrives with no scene to hold it" nor "a parsed model arrives after its token went stale" can
 * be produced from the public surface. They are kept because that unreachability is a property
 * of where the awaits happen to be — put the parse in a Worker, which is where a 164 MB STL is
 * heading, and both are live again. Defensive code reachable only through a seam is the ordinary
 * condition of defensive code; defensive code reachable from nowhere at all is the thing to
 * avoid, and that is what these two prevent.
 */
function seam(page: ViewerPage): {
  setContent(next: Object3D | null): void
  loadAnyway(): void
} {
  return page as unknown as { setContent(next: Object3D | null): void; loadAnyway(): void }
}

/** Ages the current load out, exactly as starting a newer one does. See `seam`. */
function stale(page: ViewerPage): void {
  const inner = page as unknown as { loadToken: number }
  inner.loadToken += 1
}

/** A stand-in for a parsed model: one geometry, one material, one texture. */
function strayModel(): Mesh {
  return new Mesh(
    new BoxGeometry(1, 1, 1),
    new MeshStandardMaterial({ map: new DataTexture(new Uint8Array([1, 2, 3, 4]), 1, 1) }),
  )
}

/** The fake the component was actually handed, recovered from the canvas it was built on. */
function rendererOf(host: HTMLElement, made: FakeRenderer[]): FakeRenderer {
  const canvas = host.querySelector('canvas')
  const fake = made.find((candidate) => candidate.domElement === canvas)
  if (!fake) throw new Error('no renderer was created for the rendered canvas')
  return fake
}

/** The model actually in the scene, found through the frame the renderer was asked to draw. */
function drawn(renderer: FakeRenderer): { scene: Scene; camera: PerspectiveCamera } {
  renderer.tick()
  const frame = renderer.lastFrame
  if (!frame) throw new Error('nothing was ever rendered')
  return frame
}

/** Just the three things `leakedListeners` reads off an `addEventListener` spy. */
type ListenerSpy = {
  mock: { calls: unknown[][]; contexts: unknown[]; invocationCallOrder: number[] }
}

/**
 * Listener types added to `canvas` and never taken off again.
 *
 * Replays every `addEventListener` and `removeEventListener` on that element **in the order
 * they happened**, pairing by type and handler reference, and reports what is still on at the
 * end. One assertion for every listener the component and OrbitControls between them put on the
 * canvas, including any added later: a teardown line that is present but does nothing, or absent
 * altogether, shows up here without anyone having to remember to write a test for it.
 *
 * Chronological rather than adds-then-removes, and that is load-bearing: three's `Controls`
 * calls `disconnect()` at the top of `connect()`, so five `removeEventListener` calls land
 * before the matching adds. Cancelling those against the later adds hid OrbitControls' own five
 * listeners entirely — deleting `controls.dispose()` left this test green until it was fixed.
 */
function leakedListeners(
  add: ListenerSpy,
  remove: ListenerSpy,
  canvas: HTMLCanvasElement,
): string[] {
  type Event = { at: number; on: boolean; type: string; handler: unknown }
  const events: Event[] = []
  for (const [spy, on] of [
    [add, true],
    [remove, false],
  ] as const) {
    spy.mock.calls.forEach((call, index) => {
      if (spy.mock.contexts[index] !== canvas) return
      events.push({
        at: spy.mock.invocationCallOrder[index] ?? 0,
        on,
        type: call[0] as string,
        handler: call[1],
      })
    })
  }
  events.sort((a, b) => a.at - b.at)

  const live: { type: string; handler: unknown }[] = []
  for (const event of events) {
    if (event.on) {
      live.push({ type: event.type, handler: event.handler })
      continue
    }
    const at = live.findIndex((one) => one.type === event.type && one.handler === event.handler)
    if (at !== -1) live.splice(at, 1)
  }
  return live.map((one) => one.type)
}

/** Lets a rejected promise or a cancelled stream settle before the assertions run. */
const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0))

// ------------------------------------------------------------------ the size gate

/**
 * The threshold, read back from the component rather than written out here.
 *
 * A spec that hardcoded "105 MB" would still be green — and would no longer be testing
 * anything — the day a `peakCost` was retuned or the budget moved, because both of its sizes
 * would drift to the same side of the new line together. Throwing rather than defaulting is
 * the other half of that: `?? 0` would put *every* file over the line, and the over-the-line
 * tests would pass without a gate existing at all.
 */
function limitFor(name: string): number {
  const limit = sizeLimitFor(name)
  if (limit === undefined) throw new Error(`no size limit for ${name}`)
  return limit
}

/** The largest whole number of bytes that must still open with no prompt. */
const justUnder = (name: string): number => Math.floor(limitFor(name))
/** One byte past it. */
const justOver = (name: string): number => Math.floor(limitFor(name)) + 1

/**
 * The "load it anyway" control, found by the label the user actually reads.
 *
 * By label and not by a test-only attribute, so this also asserts the button is legible: a
 * control found by `data-testid` can be an empty box on screen and the test cannot tell.
 */
function gateButton(host: HTMLElement): HTMLButtonElement | null {
  for (const button of host.querySelectorAll('button')) {
    if (button.textContent?.includes(en.viewer.loadAnyway)) return button as HTMLButtonElement
  }
  return null
}

/** Everything under the scene that would actually be drawn as triangles. */
/**
 * The camera's own right / up / view axes, read out of its world matrix.
 *
 * Columns 0, 1 and 2 of a three.js camera's `matrixWorld` are exactly those three vectors, and
 * `view` points from the target towards the camera — the same convention `CAMERA_BASIS` uses.
 */
function cameraBasis(camera: PerspectiveCamera): [Vector3, Vector3, Vector3] {
  const m = camera.matrixWorld.elements
  return [
    new Vector3(m[0]!, m[1]!, m[2]!),
    new Vector3(m[4]!, m[5]!, m[6]!),
    new Vector3(m[8]!, m[9]!, m[10]!),
  ]
}

/**
 * `CAMERA_BASIS` from `packages/core/src/previews/raster.ts`, transcribed.
 *
 * Transcribed and not imported, deliberately: `packages/web` must not reach into
 * `packages/core`, and the component transcribes the same numbers for the same reason. Two
 * independent copies of a published constant is exactly what makes this test worth running —
 * it is checking that the component's copy still agrees with the source of truth, so it has to
 * hold its own.
 */
const RASTER_BASIS = {
  right: new Vector3(0.8480480961564261, 0.5299192642332049, 0),
  up: new Vector3(-0.3059490298538092, 0.4896207966016621, 0.8164965809277261),
  view: new Vector3(0.4326772674141481, -0.6924283709739895, 0.5773502691896256),
}

function expectVectorClose(actual: Vector3, expected: Vector3): void {
  // Component by component rather than by distance: a single flipped axis is a mirrored basis,
  // and `distanceTo` reports it as one number that reads like rounding until it does not.
  expect(actual.x).toBeCloseTo(expected.x, 9)
  expect(actual.y).toBeCloseTo(expected.y, 9)
  expect(actual.z).toBeCloseTo(expected.z, 9)
}

/**
 * The real `OrbitControls` the component built, reached past `private` the way `seam` does.
 *
 * A stand-in would defeat the purpose. What these tests are about is how the camera behaves
 * under three's own spherical model — which axis it orbits about, and which direction its
 * confusingly named dolly moves — and only the real object can answer that.
 */
function controlsOf(page: ViewerPage): OrbitControls {
  const controls = (page as unknown as { controls: OrbitControls | null }).controls
  if (!controls) throw new Error('the page has no OrbitControls')
  return controls
}

/**
 * Runs the render loop until `OrbitControls`' damping has spent itself.
 *
 * `enableDamping` means a rotate or a dolly is applied a fraction at a time — 5 % per frame at
 * the default factor — and the rest arrives only on the frames the animation loop drives. In a
 * browser that is a smooth glide over about a second; here nothing drives the loop but the
 * test. 500 frames leaves 0.95^500, about 7e-12 of the original delta, so an assertion at 1e-6
 * is measuring the camera and not the easing.
 */
function settleCamera(renderer: FakeRenderer): void {
  for (let index = 0; index < 500; index++) renderer.tick()
}

/**
 * Tears the TestBed down so one test can build a second page.
 *
 * Angular refuses a second `configureTestingModule` once the module has been instantiated, and
 * several assertions here are only worth having with their control case in the same test —
 * "the reset button is absent, *and* this same query finds it when there is a model" says
 * something that two separate tests do not.
 */
function restart(): void {
  TestBed.resetTestingModule()
}

/** The "Reset view" control, found by the label a user reads. */
function resetButton(host: HTMLElement): HTMLButtonElement | null {
  return (
    [...host.querySelectorAll('button')].find(
      (button) => button.textContent?.trim() === en.viewer.resetView,
    ) ?? null
  )
}

function meshesIn(scene: Scene): Mesh[] {
  const found: Mesh[] = []
  scene.traverse((node) => {
    if ((node as Partial<Mesh>).isMesh === true) found.push(node as Mesh)
  })
  return found
}

function triangleCountIn(scene: Scene): number {
  return meshesIn(scene).reduce((total, mesh) => {
    const index = mesh.geometry.getIndex()
    const position = mesh.geometry.getAttribute('position')
    return total + Math.floor((index?.count ?? position?.count ?? 0) / 3)
  }, 0)
}

/** Waits until the state is anything other than loading, then reports which. */
async function settledState(harness: RouterTestingHarness, page: ViewerPage): Promise<ViewerState> {
  await vi.waitFor(() => {
    harness.detectChanges()
    expect(page.state().status).not.toBe('loading')
  })
  return page.state()
}

describe('ViewerPage', () => {
  beforeEach(() => {
    FakeResizeObserver.instances = []
    vi.stubGlobal('ResizeObserver', FakeResizeObserver)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('resolves projects/:id/view/:fileId and binds both route params', async () => {
    const { harness, host, page } = await setup()

    expect(harness.routeDebugElement?.componentInstance).toBeInstanceOf(ViewerPage)
    // Every neighbouring page has one, and without it the viewer has no accessible heading.
    expect(host.querySelector('h1')?.textContent).toContain(en.viewer.title)
    // withComponentInputBinding: both route params reach the component, which is how the
    // file's rawUrl is found.
    expect(page.id()).toBe('p1')
    expect(page.fileId()).toBe('f1')
  })

  it('turns an anonymous visitor away instead of mounting the viewer', async () => {
    // The behavioural half of the guard, and the one that can fail: with a session provided
    // the guard is a pass-through, so a spec that only ever signs in would stay green with
    // `canActivate` deleted from the route.
    //
    // No RouterTestingHarness here on purpose — with no outlet the router resolves the URL
    // without activating anything, so this cannot accidentally pass by way of a component.
    await configure({ authenticated: false })
    const router = TestBed.inject(Router)

    await router.navigateByUrl(VIEW_URL)

    expect(router.url).toBe('/login')
  })

  it('loads the viewer lazily rather than importing it into the shell', () => {
    // three.js is ~550kB and only this route reaches it. The spec statically imports
    // ViewerPage, so this asserts the route's own shape rather than the import graph; the
    // build output is the other half of the proof (see the task report).
    const route = sharedRoutes.find((candidate) => candidate.path === 'projects/:id/view/:fileId')
    expect(route).toBeDefined()
    expect(route?.loadComponent).toBeTypeOf('function')
    expect(route?.component).toBeUndefined()
    // `toEqual([authGuard])`, not `toContain(authGuard)`: `toContain` passes silently when the
    // received value is `undefined` and the argument is a function, so the obvious spelling of
    // this assertion is vacuous under the exact mutation it exists to catch — deleting
    // `canActivate` from the route. An equality against the whole array cannot do that.
    expect(route?.canActivate).toEqual([authGuard])
  })

  it('renders into a canvas and starts a frame loop', async () => {
    const made: FakeRenderer[] = []
    const { host } = await setup({ create: recording(made) })

    const canvas = host.querySelector('canvas')
    expect(canvas).not.toBeNull()

    const renderer = rendererOf(host, made)
    expect(renderer.animationLoop).toBeTypeOf('function')
    renderer.tick()
    expect(renderer.render).toHaveBeenCalled()
  })

  it('clears transparently so the themed container behind it shows through', async () => {
    const made: FakeRenderer[] = []
    const { host } = await setup({ create: recording(made) })

    // A hardcoded clear colour would be illegible in one of the two themes. Alpha 0 hands the
    // background to CSS, which tracks the light/dark switch with no JS at all.
    expect(rendererOf(host, made).clearAlpha).toBe(0)
  })

  it('says so in words when a WebGL context cannot be created', async () => {
    const { host, page } = await setup({
      create: () => {
        throw new Error('WebGL unavailable')
      },
    })

    expect(page.initError()).toBe(en.viewer.noWebgl)
    expect(host.querySelector('[role="alert"]')?.textContent).toContain('WebGL')
    // A blank canvas is not an acceptable outcome: there must be nothing there pretending
    // it is about to draw.
    expect(host.querySelector('canvas')).toBeNull()
    // And the container must stop announcing a 3D view it does not have, which would
    // contradict the alert sitting right above it.
    expect(host.querySelector('.spm-viewport')?.getAttribute('role')).toBeNull()
    expect(host.querySelector('.spm-viewport')?.getAttribute('aria-label')).toBeNull()
    // Nor may a download spinner sit beside "this browser could not open a 3D view": there is
    // no load to report on, and the two together say opposite things.
    expect(host.querySelector('[role="status"]')).toBeNull()
  })

  it('says so in words when the browser takes the context back at runtime', async () => {
    const made: FakeRenderer[] = []
    const { harness, host, page } = await setup({ create: recording(made) })
    const renderer = rendererOf(host, made)
    const canvas = host.querySelector('canvas')

    // Chrome caps live contexts at about 16 and evicts the *oldest* rather than refusing a
    // new one, so this — not a constructor failure — is what "too many 3D views are already
    // open" actually looks like. three.js sees it and says nothing.
    canvas?.dispatchEvent(new Event('webglcontextlost'))
    harness.detectChanges()

    expect(page.initError()).toBe(en.viewer.noWebgl)
    expect(host.querySelector('[role="alert"]')?.textContent).toContain('WebGL')
    // The loop has to stop too: render() throws on a lost context, once per frame, forever.
    expect(renderer.animationLoop).toBeNull()
  })

  it('does not fetch another model once the context is gone for good', async () => {
    const made: FakeRenderer[] = []
    const { harness, host, page, fetch } = await setup({ create: recording(made) })
    host.querySelector('canvas')?.dispatchEvent(new Event('webglcontextlost'))
    harness.detectChanges()
    expect(fetch.mock.calls.map(([url]) => url)).toEqual(['/api/files/f1/raw'])

    // Reachable only by editing the URL — nothing in the app links viewer→viewer — but the
    // router reuses the instance, so the effect fires and would happily download and parse a
    // model into a renderer whose context is dead. That is a user's bandwidth and a tab's memory
    // spent on something nobody can see.
    const next = await harness.navigateByUrl('/projects/p1/view/f2', ViewerPage)
    await settle()

    expect(next).toBe(page)
    expect(next.fileId()).toBe('f2')
    expect(fetch.mock.calls.map(([url]) => url)).toEqual(['/api/files/f1/raw'])
    // And the message is still the true one. Clearing it to let the load through would trade a
    // correct error for a blank canvas, because nothing rebuilds the renderer on an input change.
    expect(next.initError()).toBe(en.viewer.noWebgl)
    expect(host.querySelector('[role="alert"]')?.textContent).toContain('WebGL')
  })

  it('swaps the model when the router reuses it for another file', async () => {
    const spies = spyOnDisposals()
    const made: FakeRenderer[] = []
    const { harness, page, fetch } = await setup({ create: recording(made) })
    expect(spies.geometry).not.toHaveBeenCalled()

    const next = await harness.navigateByUrl('/projects/p1/view/f2', ViewerPage)
    await settle()

    // Angular's default reuse strategy keeps the instance and swaps only the input, so
    // ngAfterViewInit does not re-run — the trap project-detail.page.ts documents for `:id`.
    // Without a reactive trigger the viewer would sit there showing the previous model.
    expect(next).toBe(page)
    expect(next.fileId()).toBe('f2')
    expect(next.state()).toEqual({ status: 'ready' })
    // The second file's own bytes were fetched, not the first one's shown again.
    expect(fetch.mock.calls.map(([url]) => url)).toEqual(['/api/files/f1/raw', '/api/files/f2/raw'])
    // The previous model was released rather than merely detached...
    expect(spies.geometry).toHaveBeenCalledTimes(1)
    expect(spies.material).toHaveBeenCalledTimes(1)
    // ...and the context was reused, not rebuilt, which is the whole reason reuse is safe.
    expect(made.length).toBe(1)
    expect(made[0]?.dispose).not.toHaveBeenCalled()
  })

  it('follows its container with a ResizeObserver rather than the window', async () => {
    const made: FakeRenderer[] = []
    const aspect = vi.spyOn(PerspectiveCamera.prototype, 'updateProjectionMatrix')
    const { host, observer } = await setup({ create: recording(made) })

    // The canvas shares a page with a sidebar, so the window's size says nothing useful.
    expect(observer?.targets).toEqual([host.querySelector('.spm-viewport')])

    observer?.emit(800, 400)

    const renderer = rendererOf(host, made)
    expect(renderer.sizes.at(-1)).toEqual([800, 400])
    const camera = aspect.mock.contexts.at(-1) as PerspectiveCamera
    expect(camera.aspect).toBeCloseTo(2)
  })

  it('never lets a zero-sized container produce a NaN aspect ratio', async () => {
    const aspect = vi.spyOn(PerspectiveCamera.prototype, 'updateProjectionMatrix')
    const { observer } = await setup()

    // display:none, or an observation that lands before layout.
    observer?.emit(0, 0)

    const camera = aspect.mock.contexts.at(-1) as PerspectiveCamera
    expect(Number.isFinite(camera.aspect)).toBe(true)
  })

  describe('choosing a loader by extension', () => {
    /**
     * The three formats are asserted by what comes out, not by which class was constructed: a
     * spy proving `STLLoader.parse` ran would still be green if the bytes it returned were
     * empty, and an empty model is the exact failure this viewer must never render silently.
     * Each fixture encodes the same twelve-triangle box, so one number covers all three.
     */
    const cases: [string, Uint8Array][] = [
      ['box.stl', STL_BOX],
      ['box.obj', OBJ_BOX],
      ['box.3mf', THREEMF_BOX],
      // The reference library genuinely contains uppercase names, and the server classifies
      // and rasterizes them case-insensitively — so they arrive here as viewable models with
      // a thumbnail already rendered. Without the fold in `extensionOf` every one of them
      // would open on "this viewer cannot show .STL files", which is the bug B1 shipped.
      ['BOX.STL', STL_BOX],
      ['BOX.OBJ', OBJ_BOX],
      ['BOX.3MF', THREEMF_BOX],
    ]

    for (const [name, bytes] of cases) {
      it(`parses ${name} into real geometry`, async () => {
        const made: FakeRenderer[] = []
        const { host, page } = await setup({
          create: recording(made),
          files: [fileDto({ name, sizeBytes: bytes.byteLength })],
          serve: () => Promise.resolve(servedAtOnce(bytes)),
        })

        expect(page.state()).toEqual({ status: 'ready' })
        const { scene } = drawn(rendererOf(host, made))
        expect(triangleCountIn(scene)).toBe(TRIANGLES.length)
      })
    }

    it('reports an extension no loader handles instead of crashing, and never fetches it', async () => {
      const { harness, host, page, fetch } = await setup({
        files: [
          fileDto({ name: 'sliced.gcode', kind: 'other' }),
          // Only here as the positive control below; the .gcode file is what is under test.
          fileDto({ id: 'f2', rawUrl: '/api/files/f2/raw' }),
        ],
      })

      expect(page.state()).toEqual({ status: 'unsupported', extension: '.gcode' })
      // Named, so the reader knows which file is the problem and what to do instead.
      const message = host.querySelector('[role="alert"]')?.textContent ?? ''
      expect(message).toContain('.gcode')
      // Every format the viewer can actually open, read off the loader table rather than
      // spelled out here — the message derives its list from the same place, so adding a
      // fourth loader cannot leave two locales advertising three.
      expect(SUPPORTED_FORMATS.length).toBeGreaterThan(0)
      for (const format of SUPPORTED_FORMATS) expect(message).toContain(format)
      // Decided before the network is touched at all. The size gate goes in the same place and
      // depends on this staying true.
      expect(fetch).not.toHaveBeenCalled()

      // The positive control that assertion lacked until fix round 1. A `fetch` spy that was
      // never installed on the global the component calls satisfies `not.toHaveBeenCalled()`
      // perfectly; navigating to a file the viewer *does* open proves this one is live.
      await harness.navigateByUrl('/projects/p1/view/f2', ViewerPage)
      await settle()
      expect(fetch.mock.calls.map(([url]) => url)).toEqual(['/api/files/f2/raw'])
    })

    it('names the whole file when there is no extension to name', async () => {
      const { host, page } = await setup({ files: [fileDto({ name: 'README', kind: 'other' })] })

      expect(page.state()).toEqual({ status: 'unsupported', extension: 'README' })
      // The message must never render an empty slot where the format should be.
      expect(host.querySelector('[role="alert"]')?.textContent).toContain('README')
    })
  })

  describe('the four states', () => {
    it('says a model is on its way while it is still downloading', async () => {
      const gated = paced(STL_BOX, 2)
      const { harness, host, page, fetch } = await setup({
        serve: () => Promise.resolve(gated.response),
        wait: false,
      })

      await vi.waitFor(() => {
        harness.detectChanges()
        expect(fetch).toHaveBeenCalled()
      })

      expect(page.state().status).toBe('loading')
      // A blank canvas is never acceptable, and "nothing yet" is a state of its own: a live
      // region says so rather than leaving the reader to guess.
      const status = host.querySelector('[role="status"] span')
      expect(status?.textContent).toContain(en.viewer.loading)
      // Nothing to describe yet, so the container must not claim to be a picture of a model.
      expect(host.querySelector('.spm-viewport')?.getAttribute('role')).toBeNull()

      gated.next()
      gated.next()
      await settle()
      harness.detectChanges()

      // The control that makes every assertion above falsifiable: it really does finish.
      expect(page.state()).toEqual({ status: 'ready' })
      expect(host.querySelector('[role="status"]')).toBeNull()
      expect(host.querySelector('.spm-viewport')?.getAttribute('role')).toBe('img')
    })

    it('reports how much has arrived once the size is known', async () => {
      const gated = paced(STL_BOX, 2)
      const { harness, host, page, fetch } = await setup({
        serve: () => Promise.resolve(gated.response),
        wait: false,
      })
      await vi.waitFor(() => {
        harness.detectChanges()
        expect(fetch).toHaveBeenCalled()
      })

      // Before a byte lands there is no fraction to report, so the bar is indeterminate...
      expect(page.state()).toEqual({ status: 'loading', progress: null })
      expect(host.querySelector('[role="status"] span')?.textContent).not.toMatch(/\d/)

      gated.next()

      // ...and after the first of two equal chunks it is exactly half. A 164 MB STL over a
      // home connection is minutes of this, and a bar that never moves reads as a hang.
      await vi.waitFor(() => {
        harness.detectChanges()
        expect(page.state()).toEqual({ status: 'loading', progress: 0.5 })
      })
      expect(host.querySelector('[role="status"] span')?.textContent).toContain('50')

      gated.next()
      await settle()
      expect(page.state()).toEqual({ status: 'ready' })
    })

    it('reports a network failure rather than sitting on an empty canvas', async () => {
      const { harness, host, page } = await setup({
        serve: () => Promise.reject(new Error('offline')),
        wait: false,
      })

      expect(await settledState(harness, page)).toEqual({
        status: 'failed',
        reason: 'fetch',
        extension: '.stl',
      })
      expect(host.querySelector('[role="alert"]')?.textContent).toBe(en.viewer.fetchFailed)
    })

    it('reports a rejected request the same way it reports a dropped connection', async () => {
      const { harness, host, page } = await setup({
        serve: () => Promise.resolve(fakeResponse(null, 503)),
        wait: false,
      })

      // A non-2xx resolves rather than rejecting, so a `try` around fetch alone would let it
      // through as a parse failure of zero bytes.
      expect(await settledState(harness, page)).toEqual({
        status: 'failed',
        reason: 'fetch',
        extension: '.stl',
      })
      expect(host.querySelector('[role="alert"]')?.textContent).toBe(en.viewer.fetchFailed)
    })

    it('reports a connection that drops part-way through the body', async () => {
      const { harness, host, page } = await setup({
        serve: () => Promise.resolve(truncatedResponse(STL_BOX, 100)),
        wait: false,
      })

      // The read loop, not the `fetch()` call: the request succeeded and a hundred bytes
      // arrived before the wifi blinked. Reporting that as a parse failure tells the user to
      // re-upload a perfectly healthy file, and over a home connection a 164 MB STL dropping
      // mid-stream is the likely failure rather than a corner case.
      expect(await settledState(harness, page)).toEqual({
        status: 'failed',
        reason: 'fetch',
        extension: '.stl',
      })
      expect(host.querySelector('[role="alert"]')?.textContent).toBe(en.viewer.fetchFailed)
    })

    it('loads a response that has no readable stream at all', async () => {
      const made: FakeRenderer[] = []
      const { host, page } = await setup({
        create: recording(made),
        serve: () => Promise.resolve(bodilessResponse(STL_BOX)),
      })

      // The `arrayBuffer()` fallback: a cache hit or a service worker's reply can arrive with
      // `body: null`, and it is the same path the reader cancellation was added to cope with.
      // No progress is reportable here, but the model still has to appear.
      expect(page.state()).toEqual({ status: 'ready' })
      expect(triangleCountIn(drawn(rendererOf(host, made)).scene)).toBe(TRIANGLES.length)
    })

    it('reports a bodyless response that will not yield its bytes', async () => {
      const { harness, host, page } = await setup({
        serve: () => Promise.resolve(bodilessResponse(null)),
        wait: false,
      })

      // The other half of the mid-stream-drop fix, on the branch that has no stream to drop:
      // `arrayBuffer()` rejects on a truncated or aborted transfer just as `read()` does, and
      // unguarded it would surface as "this file may be damaged, try uploading it again".
      expect(await settledState(harness, page)).toEqual({
        status: 'failed',
        reason: 'fetch',
        extension: '.stl',
      })
      expect(host.querySelector('[role="alert"]')?.textContent).toBe(en.viewer.fetchFailed)
    })

    it('reports a 404 on the file itself as a missing file, not as a bad connection', async () => {
      const { harness, host, page } = await setup({
        serve: () => Promise.resolve(fakeResponse(null, 404)),
        wait: false,
      })

      // The bytes are gone from disk or the id no longer resolves. "Check your connection" is
      // advice that cannot work; there is already a message that points back at the project.
      expect(await settledState(harness, page)).toEqual({
        status: 'failed',
        reason: 'missing',
        extension: '.stl',
      })
      expect(host.querySelector('[role="alert"]')?.textContent).toBe(en.viewer.missingFile)
    })

    it('reports a file that will not parse, and says which format it tried', async () => {
      const { harness, host, page } = await setup({
        files: [fileDto({ name: 'box.stl', sizeBytes: STL_TRUNCATED.byteLength })],
        serve: () => Promise.resolve(servedAtOnce(STL_TRUNCATED)),
        wait: false,
      })

      // The header promises twelve triangles and the file holds two — what a half-finished
      // upload looks like on disk.
      expect(await settledState(harness, page)).toEqual({
        status: 'failed',
        reason: 'parse',
        extension: '.stl',
      })
      expect(host.querySelector('[role="alert"]')?.textContent).toContain('.stl')
    })

    it('reports a model with no triangles instead of drawing nothing', async () => {
      const made: FakeRenderer[] = []
      const { harness, host, page } = await setup({
        create: recording(made),
        files: [fileDto({ sizeBytes: STL_EMPTY.byteLength })],
        serve: () => Promise.resolve(servedAtOnce(STL_EMPTY)),
        wait: false,
      })

      // It parses perfectly. It is simply blank — the one outcome indistinguishable from a
      // viewer that is broken, which is why it is a failure and not a success.
      expect(await settledState(harness, page)).toEqual({
        status: 'failed',
        reason: 'empty',
        extension: '.stl',
      })
      expect(host.querySelector('[role="alert"]')?.textContent).toBe(en.viewer.emptyModel)
      // And the empty geometry is not left in the scene pretending to be a model.
      expect(meshesIn(drawn(rendererOf(host, made)).scene)).toEqual([])
    })

    it('reports a file the project does not have', async () => {
      const { harness, host, page } = await setup({ url: '/projects/p1/view/gone', wait: false })

      expect(await settledState(harness, page)).toEqual({
        status: 'failed',
        reason: 'missing',
        extension: '',
      })
      expect(host.querySelector('[role="alert"]')?.textContent).toBe(en.viewer.missingFile)
    })

    it('distinguishes a project that could not be fetched from a file that is gone', async () => {
      const { harness, host, page } = await setup({
        get: () => Promise.reject(new Error('boom')),
        wait: false,
      })

      // Reading `Resource.value()` after a settled failure throws, so this also pins that the
      // component asks `hasValue()` first.
      expect((await settledState(harness, page)).status).toBe('failed')
      expect(host.querySelector('[role="alert"]')?.textContent).toBe(en.viewer.fetchFailed)
    })
  })

  describe('framing the model', () => {
    /** The camera that drew the last frame, and the model it drew. */
    async function framed(width: number, height: number, options: Options = {}) {
      const made: FakeRenderer[] = []
      const { host, observer, page } = await setup({ ...options, create: recording(made) })
      observer?.emit(width, height)
      const { scene, camera } = drawn(rendererOf(host, made))
      return { scene, camera, page }
    }

    it('frames the model as it loads, before the container has reported a size', async () => {
      const made: FakeRenderer[] = []
      // No `observer.emit` anywhere in this test: the ResizeObserver fires a frame after
      // `observe()`, and a model out of a warm cache can be on screen before it does. Framing
      // only from the resize path would show one unframed paint — the camera still at the
      // 4-unit placeholder, with a 110 mm model nowhere near the frustum.
      const { host } = await setup({ create: recording(made) })

      const { scene, camera } = drawn(rendererOf(host, made))
      const radius = new Box3().setFromObject(scene).getSize(new Vector3()).length() / 2
      expect(camera.position.length()).toBeGreaterThan(radius)
      expect(camera.position.length()).toBeLessThan(radius * 5)
    })

    it('centres the model on the origin so it orbits about itself', async () => {
      const { scene } = await framed(800, 600)

      // The fixture box sits at (10..30, 20..60, 30..130) — a model that came back centred by
      // accident could only do so by ignoring the file.
      const centre = new Box3().setFromObject(scene).getCenter(new Vector3())
      expect(centre.x).toBeCloseTo(0, 5)
      expect(centre.y).toBeCloseTo(0, 5)
      expect(centre.z).toBeCloseTo(0, 5)
    })

    it('pulls the camera back until the whole model is inside the frustum', async () => {
      const { scene, camera } = await framed(800, 600)

      camera.updateMatrixWorld()
      const frustum = new Frustum().setFromProjectionMatrix(
        new Matrix4().multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse),
      )
      const box = new Box3().setFromObject(scene)
      // Every corner, not just the box: a near-plane that clips the front of a 100 mm-deep
      // model is exactly the bug task 1's fixed 0.1/1000 pair would have produced.
      for (const [x, y, z] of [
        [box.min.x, box.min.y, box.min.z],
        [box.max.x, box.min.y, box.min.z],
        [box.min.x, box.max.y, box.min.z],
        [box.max.x, box.max.y, box.min.z],
        [box.min.x, box.min.y, box.max.z],
        [box.max.x, box.min.y, box.max.z],
        [box.min.x, box.max.y, box.max.z],
        [box.max.x, box.max.y, box.max.z],
      ]) {
        expect(frustum.containsPoint(new Vector3(x, y, z))).toBe(true)
      }
    })

    it('fills the view rather than merely fitting inside it', async () => {
      const { scene, camera } = await framed(800, 600)

      // The other half of a fit, and the half a "camera.position.set(0, 0, 10000)" would pass
      // the frustum test with: the model has to be big on screen. Its angular radius is
      // compared against the half-angle of the field of view, so this holds whatever the
      // model's absolute size is.
      const box = new Box3().setFromObject(scene)
      const radius = box.getSize(new Vector3()).length() / 2
      const angular = Math.asin(radius / camera.position.length())
      const halfFov = ((camera.fov / 2) * Math.PI) / 180
      expect(angular).toBeGreaterThan(halfFov * 0.75)
      // And not so big that the 6 % margin is gone.
      expect(angular).toBeLessThan(halfFov)
    })

    it('frames by the tighter axis when the viewport is portrait', async () => {
      const { scene, camera } = await framed(400, 900)

      // Fitting on the vertical field of view alone leaves a wide model cut off left and
      // right the moment the viewport is taller than it is wide.
      camera.updateMatrixWorld()
      const frustum = new Frustum().setFromProjectionMatrix(
        new Matrix4().multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse),
      )
      const box = new Box3().setFromObject(scene)
      expect(frustum.containsPoint(box.min.clone())).toBe(true)
      expect(frustum.containsPoint(box.max.clone())).toBe(true)
    })

    it('re-fits when the container changes shape', async () => {
      const made: FakeRenderer[] = []
      const { host, observer } = await setup({ create: recording(made) })
      const { camera } = drawn(rendererOf(host, made))

      observer?.emit(800, 600)
      const before = camera.position.length()
      observer?.emit(300, 900)

      // The fit depends on the aspect ratio, so a container dragged narrow needs a camera
      // further back or the model is cropped left and right. No frame is driven in between,
      // so nothing but the resize can have moved it.
      expect(camera.position.length()).toBeGreaterThan(before * 1.5)
    })

    it('leaves the camera alone once the user has taken hold of it', async () => {
      const made: FakeRenderer[] = []
      const { host, observer } = await setup({ create: recording(made) })
      const { camera } = drawn(rendererOf(host, made))

      observer?.emit(800, 600)
      const before = camera.position.length()
      const canvas = host.querySelector('canvas') as HTMLCanvasElement
      // jsdom implements no pointer capture at all, and OrbitControls takes it on the first
      // pointerdown — so without this the real controls throw before the component's own
      // listener on the same element is reached.
      canvas.setPointerCapture = () => {}
      canvas.dispatchEvent(new Event('pointerdown'))
      observer?.emit(300, 900)

      // The same resize as the test above, which is what makes this one falsifiable: after a
      // drag or a scroll the camera is the user's, and a window they happen to resize must
      // not throw their zoom away.
      expect(camera.position.length()).toBeCloseTo(before, 10)
    })

    /**
     * A viewer cannot know what unit a file is in: the same shape arrives as millimetres from a
     * slicer, as metres from a CAD export and as microns from a scanner. Task 1's fixed
     * 0.1 / 1000 pair happens to work across the middle of that range, which is exactly why a
     * test at one scale proves nothing — so all three are asserted.
     */
    for (const scale of [0.0001, 1, 1000]) {
      it(`brackets the model with its near and far planes at scale ${scale}`, async () => {
        const bytes = binaryStl(TRIANGLES, scale)
        const { scene, camera } = await framed(800, 600, {
          files: [fileDto({ sizeBytes: bytes.byteLength })],
          serve: () => Promise.resolve(servedAtOnce(bytes)),
        })

        const box = new Box3().setFromObject(scene)
        const radius = box.getSize(new Vector3()).length() / 2
        const distance = camera.position.length()
        expect(camera.near).toBeLessThan(distance - radius)
        expect(camera.far).toBeGreaterThan(distance + radius)
        // Depth precision is a ratio, not a difference — a near plane of 1e-6 against a far of
        // 10⁴ is z-fighting on every surface.
        expect(camera.far / camera.near).toBeLessThan(1e5)
      })
    }
  })

  describe('when the bytes and the recorded size disagree', () => {
    /**
     * The download is written straight into a buffer sized from `FileDto.sizeBytes`, because
     * collecting the chunks and concatenating them at the end holds a 164 MB STL twice. That
     * is only safe if a stale or simply wrong size still yields the bytes that arrived, so
     * both directions are pinned — and on the bytes themselves, not on the parse succeeding:
     * every one of the three loaders tolerates trailing padding, so "it still parsed" would
     * stay green with the buffer sized from the DTO.
     */
    for (const drift of [-40, 40]) {
      it(`hands the parser what arrived when the DTO is ${drift} bytes out`, async () => {
        const parse = vi.spyOn(STLLoader.prototype, 'parse')
        const made: FakeRenderer[] = []
        const { host, page } = await setup({
          create: recording(made),
          files: [fileDto({ sizeBytes: STL_BOX.byteLength + drift })],
        })

        expect(page.state()).toEqual({ status: 'ready' })
        const data = parse.mock.calls[0]?.[0]
        expect(data).toBeInstanceOf(ArrayBuffer)
        expect(new Uint8Array(data as ArrayBuffer)).toEqual(STL_BOX)
        expect(triangleCountIn(drawn(rendererOf(host, made)).scene)).toBe(TRIANGLES.length)
      })
    }
  })

  describe('the size gate', () => {
    /**
     * Every openable format, with the file the fixture serves once the gate is passed.
     *
     * All three, not one: the threshold is a peak-memory budget divided by a *per-format*
     * cost, so "the gate works" is three different numbers and a spec that checked STL alone
     * would say nothing about the two arms that are 4.3 and 17.9 times more expensive.
     */
    const formats: [string, string, Uint8Array][] = [
      ['box.stl', '.stl', STL_BOX],
      ['box.obj', '.obj', OBJ_BOX],
      ['box.3mf', '.3mf', THREEMF_BOX],
    ]

    for (const [name, extension, bytes] of formats) {
      it(`opens ${name} with no prompt at the last byte under its line`, async () => {
        const made: FakeRenderer[] = []
        const { host, page, fetch } = await setup({
          create: recording(made),
          files: [fileDto({ name, sizeBytes: justUnder(name) })],
          serve: () => Promise.resolve(servedAtOnce(bytes)),
        })

        // At one byte under the line the viewer behaves exactly as it did before the gate
        // existed. This is the control for the two negative assertions in the test below:
        // the same `gateButton` query that finds a button over the line finds none here...
        expect(gateButton(host)).toBeNull()
        // ...and the same `fetch` spy that must stay untouched over the line does fire under
        // it, so a spy that was never wired up cannot satisfy `not.toHaveBeenCalled()`.
        expect(fetch.mock.calls.map(([url]) => url)).toEqual(['/api/files/f1/raw'])
        expect(page.state()).toEqual({ status: 'ready' })
        expect(triangleCountIn(drawn(rendererOf(host, made)).scene)).toBe(TRIANGLES.length)
      })

      it(`asks before opening ${name} over its line and requests nothing until told to`, async () => {
        const made: FakeRenderer[] = []
        const sizeBytes = justOver(name)
        const { harness, host, page, fetch } = await setup({
          create: recording(made),
          files: [fileDto({ name, sizeBytes })],
          serve: () => Promise.resolve(servedAtOnce(bytes)),
        })

        expect(page.state()).toEqual({ status: 'oversized', extension, sizeBytes })
        // Not fetched-and-discarded and not fetched-and-paused: a gate that opens the
        // connection has already spent the download it exists to ask about, which on the file
        // this is really for is 164 MB over whatever connection the user is on.
        expect(fetch).not.toHaveBeenCalled()
        // Named, and in the same shape the project page printed beside the file — a gate that
        // quoted a different number than the page it was reached from reads as a bug.
        const message = host.querySelector('[role="alert"]')?.textContent ?? ''
        expect(message).toContain(formatBytes(sizeBytes))
        expect(gateButton(host)).not.toBeNull()

        gateButton(host)?.click()
        await settle()
        harness.detectChanges()

        // The positive control for `not.toHaveBeenCalled()` above: the same spy, in the same
        // test, firing exactly once as soon as the user says yes.
        expect(fetch.mock.calls.map(([url]) => url)).toEqual(['/api/files/f1/raw'])
        expect(page.state()).toEqual({ status: 'ready' })
        expect(gateButton(host)).toBeNull()
        // And it is the real model, not merely a state change: confirming has to load.
        expect(triangleCountIn(drawn(rendererOf(host, made)).scene)).toBe(TRIANGLES.length)
      })
    }

    it('refuses a slicer project on its kind, whatever its extension says', async () => {
      // The library holds 374 slicer-project .3mf files against 28 plain meshes, and the two
      // are one extension over entirely different things. `FileDto.kind` is on the object
      // `load` already holds and is the same predicate project-detail.page.ts uses to decide
      // which files get a viewer link, so reading it here makes the two agree rather than
      // merely coincide. Sized well over the 3MF line so this cannot pass by being small.
      const { harness, host, page, fetch } = await setup({
        files: [
          fileDto({ name: 'plate_1.3mf', kind: 'slicer_project', sizeBytes: 96_000_000 }),
          fileDto({ id: 'f2', rawUrl: '/api/files/f2/raw' }),
        ],
      })

      expect(page.state()).toEqual({ status: 'slicerProject' })
      // Not the size gate: there is no "load it anyway" for a file with no single mesh in it,
      // and offering one would be offering ~2.5 GB of peak memory to render nothing useful.
      expect(gateButton(host)).toBeNull()
      expect(host.querySelector('[role="alert"]')?.textContent).toBe(en.viewer.slicerProject)
      expect(fetch).not.toHaveBeenCalled()

      // The positive control. Fix round 1 declared `f2` here and then never navigated to it, so
      // this negative was the one assertion in the block that stayed green when the `fetch` spy
      // was unwired from the global — and the round-1 report claimed a control that was not
      // there. Navigating on proves the spy is live in this test, not merely in its siblings.
      await harness.navigateByUrl('/projects/p1/view/f2', ViewerPage)
      await settle()
      expect(fetch.mock.calls.map(([url]) => url)).toEqual(['/api/files/f2/raw'])
    })

    it('does not fetch a file the server could not read as a model', async () => {
      const { harness, page, fetch } = await setup({
        // `classifyFile` gives .stl and .obj `kind: 'model'` unconditionally, so in practice
        // this is a .3mf whose zip is damaged. The parse-failure message is exactly the right
        // advice for it, and it now costs no download to give.
        files: [
          fileDto({ name: 'broken.3mf', kind: 'other', sizeBytes: 1_000 }),
          fileDto({ id: 'f2', rawUrl: '/api/files/f2/raw' }),
        ],
      })

      expect(page.state()).toEqual({ status: 'failed', reason: 'parse', extension: '.3mf' })
      expect(fetch).not.toHaveBeenCalled()

      // The positive control: the same spy fires for a file the viewer does open.
      await harness.navigateByUrl('/projects/p1/view/f2', ViewerPage)
      await settle()
      expect(fetch.mock.calls.map(([url]) => url)).toEqual(['/api/files/f2/raw'])
    })

    it('moves focus to the progress region when the gate is confirmed', async () => {
      // Confirming destroys the @case arm holding the button that was pressed, so without this
      // focus falls to <body>: a keyboard user is dumped at the top of the document and a
      // screen-reader user is told nothing at all, on the one kind of load slow enough that
      // silence is indistinguishable from a dead button.
      const gated = paced(STL_BOX, 2)
      const { harness, host, page } = await setup({
        files: [fileDto({ sizeBytes: justOver('box.stl') })],
        serve: () => Promise.resolve(gated.response),
      })
      expect(page.state().status).toBe('oversized')

      const button = gateButton(host)
      button?.focus()
      expect(document.activeElement).toBe(button)

      button?.click()
      await vi.waitFor(() => {
        harness.detectChanges()
        expect(page.state().status).toBe('loading')
      })

      // Not merely "focus left the button": it landed somewhere that says what is happening.
      const region = host.querySelector('[role="status"]')
      expect(region).not.toBeNull()
      expect(document.activeElement).toBe(region)

      gated.next()
      gated.next()
      await settle()
    })

    it('refuses a peakCost that would silently switch the gate off', () => {
      // The argument for putting the cost inside FORMATS beside the parser is that a separate
      // table would let a new loader read as "no gate". `peakCost: 0` typechecks and divides to
      // Infinity, which is that same hole by another spelling.
      const parse = () => new Mesh()
      expect(() => limitOf('.xyz', { parse, peakCost: 0 })).toThrow(/peakCost/)
      expect(() => limitOf('.xyz', { parse, peakCost: -1 })).toThrow(/peakCost/)
      expect(() => limitOf('.xyz', { parse, peakCost: Number.NaN })).toThrow(/peakCost/)
      // The control: a real cost yields a real limit through the very same call, so the three
      // assertions above are about the guard and not about `limitOf` throwing unconditionally.
      expect(limitOf('.xyz', { parse, peakCost: 8 })).toBeGreaterThan(0)
      expect(Number.isFinite(limitOf('.xyz', { parse, peakCost: 8 }))).toBe(true)
      // And an extension with no loader still answers "no limit" rather than throwing, which is
      // what lets `limitFor` in this spec tell "ungated format" from "no such format" apart.
      expect(sizeLimitFor('sliced.gcode')).toBeUndefined()
    })

    it('puts every line in a gap between two real library files, not near one', () => {
      // Every other test in this block derives its sizes from `sizeLimitFor`, which makes them
      // immune to the threshold being retuned — and equally blind to it being retuned to
      // nonsense. A budget of ten gigabytes, or of one byte, leaves all of them green. This is
      // where the numbers come from outside the code instead: each pair is the largest file of
      // that format the reference library holds that must open without a word, and the smallest
      // it holds that must be asked about. Sizes from a rescan taken when the costs were last
      // measured.
      //
      // The pairs are wide, and the width is the point. `.3mf` opens at 0.54 MB and asks at
      // 7.65 MB, so that line can sit anywhere across a fourteen-fold range and behave the same.
      // This test therefore pins what the gate *does* rather than an abstraction about what it
      // should: the previous version asserted that a 3.9 MB model — the 90th percentile over all
      // 1,725 models of every format — opens in every format, which sounds like a guarantee but
      // multiplies a percentile over one population by a multiplier that only applies to another.
      // No 3.9 MB plain-mesh 3MF exists, or needs to. See `PEAK_BUDGET_BYTES`.
      //
      //   format  largest that opens                        smallest that is gated
      const brackets: [string, number, string, number][] = [
        ['IMG_1585...NS.stl', 35_939_484, 'Köln5...NS (3).stl', 41_987_684],
        ['HannosRing.obj', 5_526_573, 'Baby_Yoda.obj', 137_788_855],
        ['Uno.3mf', 539_936, 'right.3mf', 7_647_338],
      ]

      for (const [openName, openBytes, gatedName, gatedBytes] of brackets) {
        expect({ [openName]: openBytes > limitFor(openName) }).toEqual({ [openName]: false })
        expect({ [gatedName]: gatedBytes > limitFor(gatedName) }).toEqual({ [gatedName]: true })
      }

      // And the file the whole gate exists for: the library's largest, a 164.8 MB binary STL.
      expect(164_791_684).toBeGreaterThan(limitFor('Body_high_detail.stl'))
    })

    it('gates every real library file that is measured over the budget', () => {
      // The files fix round 1 was opened for. Each is a real file in the reference library, each
      // passed the round-0 gate, and each was *measured* to blow through the 256 MB budget. This
      // is the only test that pins the `peakCost` numbers to anything outside the code: every
      // other test in this block derives its sizes from `sizeLimitFor` and therefore moves with
      // whatever the costs happen to be.
      //
      // The peaks are in this comment and not in the table, because a measurement is not an
      // assertion and putting one in the compared object only made it look like one — it was
      // being compared against itself, so the row could never fail on the number. Two harnesses,
      // both reported as peak RSS over an idle baseline:
      //
      //   name                             on disk   Node    Chromium
      //   Waving_Groot_15.5cm.stl         100.05 MB   321 MB   321 MB   binary, COLOR= header
      //   Head_with_brim_high_detail.stl   99.52 MB   319 MB     —      binary, COLOR= header
      //   Octopus_full_v5.5.stl            62.90 MB   419 MB   331 MB   ASCII
      //   iron-man-base-2.stl              46.55 MB   284 MB   220 MB   ASCII
      //   left.3mf                          7.75 MB   278 MB   746 MB   plain mesh
      //   right.3mf                         7.65 MB   274 MB     —      plain mesh
      //
      // Node was `process.resourceUsage().maxRSS` per process; Chromium is WorkingSet64 summed
      // across the browser's processes while the parse runs, sampled about every 100–150 ms,
      // which is the same quantity in the engine that will actually run it. The binary STL
      // reproduces exactly, which is what makes the two columns comparable on the binary path;
      // the ASCII rows disagree by about 1.4x, and the 3MF rows by 2.7x because Node never built
      // the DOM at all — see the `.3mf` row in `viewer.page.ts`.
      const overBudget: [string, number][] = [
        ['Waving_Groot_15.5cm.stl', 100_050_000],
        ['Head_with_brim_high_detail.stl', 99_520_000],
        ['Octopus_full_v5.5.stl', 62_900_000],
        ['iron-man-base-2.stl', 46_550_000],
        ['left.3mf', 7_750_000],
        ['right.3mf', 7_650_000],
      ]

      for (const [name, sizeBytes] of overBudget) {
        expect({ name, gated: sizeBytes > limitFor(name) }).toEqual({ name, gated: true })
      }
    })

    it('prices the three formats in the order they were measured to cost', () => {
      // 3MF is dearest per byte (a zip that inflates, decodes and then becomes a DOM), OBJ next
      // (no binary form, plus OBJLoader's intermediate number[]s), STL cheapest. Any table that
      // gets that order wrong is not a measurement of these loaders.
      expect(limitFor('a.3mf')).toBeLessThan(limitFor('a.obj'))
      expect(limitFor('a.obj')).toBeLessThan(limitFor('a.stl'))
    })

    it('holds a 3MF and an STL of identical size to different lines', async () => {
      // A 3MF is a zip, and three's loader inflates every entry at once, decodes the model
      // part to a JS string and builds a DOM over that — so the same number of bytes on disk
      // costs the tab roughly eighteen times what an STL of it does — 120.95 against 6.75. The
      // sibling test above proves a 3MF of exactly this size prompts; this proves an STL of it
      // does not, and together they are the pair no single flat threshold can satisfy in either
      // direction.
      const sizeBytes = justOver('box.3mf')
      expect(sizeBytes).toBeLessThan(limitFor('box.stl'))

      const { host, page, fetch } = await setup({
        files: [fileDto({ name: 'box.stl', sizeBytes })],
      })

      expect(page.state()).toEqual({ status: 'ready' })
      expect(gateButton(host)).toBeNull()
      expect(fetch.mock.calls.map(([url]) => url)).toEqual(['/api/files/f1/raw'])
    })

    it('asks again for the next file, however the last one was answered', async () => {
      const { harness, page, fetch } = await setup({
        files: [
          fileDto({ name: 'one.stl', sizeBytes: justOver('one.stl') }),
          fileDto({
            id: 'f2',
            name: 'two.stl',
            sizeBytes: justOver('two.stl'),
            rawUrl: '/api/files/f2/raw',
          }),
        ],
      })
      expect(page.state().status).toBe('oversized')

      gateButton(harness.routeNativeElement as HTMLElement)?.click()
      await settle()
      harness.detectChanges()
      expect(page.state()).toEqual({ status: 'ready' })

      const next = await harness.navigateByUrl('/projects/p1/view/f2', ViewerPage)
      await settle()
      harness.detectChanges()

      // The whole point of the answer being an argument to one call rather than a field: an
      // accidental "yes" on a 164 MB model buys that one model and nothing else. The router
      // reuses the instance across a `:fileId` change, so a remembered answer would sit right
      // here on the very same object.
      expect(next).toBe(page)
      expect(page.state().status).toBe('oversized')
      expect(gateButton(harness.routeNativeElement as HTMLElement)).not.toBeNull()
      // Negative and positive in one assertion, so it cannot pass for want of a wired spy:
      // f2's bytes were never requested, and f1's — the file that *was* confirmed — were.
      expect(fetch.mock.calls.map(([url]) => url)).toEqual(['/api/files/f1/raw'])
    })

    it('ignores a confirmation that arrives when nothing is gated', async () => {
      const { page, fetch } = await setup()
      // The control for the assertion below: this spy demonstrably fires on a real load, so
      // "it was not called a second time" is a statement about the guard and not about wiring.
      expect(page.state()).toEqual({ status: 'ready' })
      expect(fetch).toHaveBeenCalledTimes(1)

      // Defensive, and reachable only through a seam because the button renders only while the
      // state is 'oversized'. Pinned rather than trusted, on the same rule as `setContent`'s
      // no-scene arm: without the guard a stray confirmation re-downloads the model, and the
      // models this code path exists for are the ones a needless second download hurts most.
      seam(page).loadAnyway()
      await settle()

      expect(fetch).toHaveBeenCalledTimes(1)
      expect(page.state()).toEqual({ status: 'ready' })
    })

    it('reports a format it cannot open as unsupported however large the file is', async () => {
      const { host, page } = await setup({
        files: [fileDto({ name: 'sliced.gcode', kind: 'other', sizeBytes: 500_000_000 })],
      })

      // The gate sits *behind* the unsupported arm, not in front of it. The other order offers
      // to load a .gcode anyway — an offer the viewer cannot honour, on a file it would then
      // download half a gigabyte of in order to fail on.
      expect(page.state()).toEqual({ status: 'unsupported', extension: '.gcode' })
      expect(gateButton(host)).toBeNull()
    })
  })

  describe('opening on the thumbnail’s camera', () => {
    it('builds exactly the basis the server rasterizes with', async () => {
      const made: FakeRenderer[] = []
      const { host, observer } = await setup({ create: recording(made) })
      observer?.emit(800, 600)
      const { camera } = drawn(rendererOf(host, made))
      camera.updateMatrixWorld()

      const [right, up, view] = cameraBasis(camera)
      // Component against transcript, and the transcript is the point: a viewer on a camera of
      // its own would open the model somewhere else than the picture the user clicked. Every
      // component of all three vectors, so no axis can be right by accident while another is
      // flipped — a mirrored basis passes any test that only checks the view direction.
      expectVectorClose(right, RASTER_BASIS.right)
      expectVectorClose(up, RASTER_BASIS.up)
      expectVectorClose(view, RASTER_BASIS.view)
    })

    it('holds that basis whatever the model and whatever the viewport', async () => {
      // The control for the test above, which a camera hard-coded to one distance for one box
      // would also pass. The basis is a *direction*, so it must survive both a different fit
      // and a different aspect ratio while the position does not.
      const made: FakeRenderer[] = []
      const { host, observer } = await setup({
        create: recording(made),
        files: [fileDto({ name: 'wedge.stl', sizeBytes: STL_WEDGE.byteLength })],
        serve: () => Promise.resolve(servedAtOnce(STL_WEDGE)),
      })
      observer?.emit(800, 600)
      const { camera } = drawn(rendererOf(host, made))
      const wide = camera.position.clone()
      camera.updateMatrixWorld()
      const [right] = cameraBasis(camera)

      observer?.emit(300, 900)
      camera.updateMatrixWorld()
      const [rightAgain, upAgain, viewAgain] = cameraBasis(camera)

      expect(camera.position.distanceTo(wide)).toBeGreaterThan(1)
      expectVectorClose(right, RASTER_BASIS.right)
      expectVectorClose(rightAgain, RASTER_BASIS.right)
      expectVectorClose(upAgain, RASTER_BASIS.up)
      expectVectorClose(viewAgain, RASTER_BASIS.view)
    })

    it('orbits about the bed normal, not about three.js’s default up', async () => {
      // What the basis buys the user, stated as behaviour rather than as a vector. Dragging
      // sideways has to spin a printed part about the axis it was printed along; with three's
      // default Y-up it tips instead. OrbitControls snapshots `camera.up` in its constructor,
      // so this is also the only assertion that would catch the up being set too late.
      const made: FakeRenderer[] = []
      const { host, observer, page } = await setup({ create: recording(made) })
      observer?.emit(800, 600)
      const { camera } = drawn(rendererOf(host, made))
      const before = camera.position.clone()

      controlsOf(page).rotateLeft(Math.PI / 2)
      settleCamera(rendererOf(host, made))

      // A quarter turn about +Z leaves the height alone and swaps the two ground axes.
      expect(camera.position.z).toBeCloseTo(before.z, 6)
      expect(camera.position.length()).toBeCloseTo(before.length(), 6)
      expect(camera.position.x).not.toBeCloseTo(before.x, 3)
    })
  })

  describe('one material, whatever the file was', () => {
    /**
     * The defect three reviews carried: the same object looked different by format. STL got a
     * `MeshStandardMaterial` the app built, an `.obj` with no `.mtl` got three's default
     * `MeshPhongMaterial` (white and specular), and a `.3mf` got the 3MF loader's own grey.
     *
     * Asserted as agreement between the formats first and against a literal second. The
     * agreement is the requirement; the literal only pins which of the three won.
     */
    async function materialsOfFormat(name: string, bytes: Uint8Array) {
      restart()
      // Which loader really ran. Without this the test's whole claim — that three *different*
      // formats agree — would survive a helper that quietly loaded the same STL three times,
      // and "they all look alike" would be true for the wrong reason. Confirmed by mutation:
      // pinning the name to 'box.stl' inside this helper leaves the suite green without it.
      const parsers = {
        '.stl': vi.spyOn(STLLoader.prototype, 'parse'),
        '.obj': vi.spyOn(OBJLoader.prototype, 'parse'),
        '.3mf': vi.spyOn(ThreeMFLoader.prototype, 'parse'),
      }
      const made: FakeRenderer[] = []
      const { host } = await setup({
        create: recording(made),
        files: [fileDto({ name, sizeBytes: bytes.byteLength })],
        serve: () => Promise.resolve(servedAtOnce(bytes)),
      })
      const expected = name.slice(name.lastIndexOf('.')).toLowerCase()
      expect(
        Object.entries(parsers)
          .filter(([, spy]) => spy.mock.calls.length > 0)
          .map(([extension]) => extension),
      ).toEqual([expected])
      for (const spy of Object.values(parsers)) spy.mockRestore()

      const { scene } = drawn(rendererOf(host, made))
      const meshes = meshesIn(scene)
      expect(meshes.length).toBeGreaterThan(0)
      return meshes.map((mesh) => mesh.material as Material)
    }

    it('draws STL, OBJ and 3MF in the same material', async () => {
      const stl = await materialsOfFormat('box.stl', STL_BOX)
      const obj = await materialsOfFormat('box.obj', OBJ_BOX)
      const threeMf = await materialsOfFormat('box.3mf', THREEMF_BOX)

      const shape = (materials: Material[]) =>
        materials.map((material) => ({
          type: material.type,
          colour: (material as MeshLambertMaterial).color.getHexString(),
          flat: (material as MeshLambertMaterial).flatShading,
          side: material.side,
        }))

      // Same box, three containers, one look. Before this the three lines below read
      // MeshStandardMaterial/ffffff, MeshPhongMaterial/ffffff and MeshPhongMaterial/ffffff with
      // three different shading models behind them.
      expect(shape(obj)).toEqual(shape(stl))
      expect(shape(threeMf)).toEqual(shape(stl))
      expect(shape(stl)).toEqual([
        { type: 'MeshLambertMaterial', colour: 'efdcc6', flat: true, side: DoubleSide },
      ])
    })

    it('gives each mesh its own material instance, so disposal stays one per mesh', async () => {
      // Two meshes sharing one material would be disposed twice, and the whole disposal matrix
      // counts. The 3MF fixture is a single mesh, so this is asserted where more than one
      // exists: an OBJ with two named objects.
      const twoObjects = utf8(
        [
          'o first',
          ...CORNERS.map(([x, y, z]) => `v ${x} ${y} ${z}`),
          ...TRIANGLES.map(([a, b, c]) => `f ${a + 1} ${b + 1} ${c + 1}`),
          'o second',
          ...CORNERS.map(([x, y, z]) => `v ${x + 200} ${y} ${z}`),
          ...TRIANGLES.map(([a, b, c]) => `f ${a + 9} ${b + 9} ${c + 9}`),
        ].join('\n') + '\n',
      )
      const materials = await materialsOfFormat('two.obj', twoObjects)

      expect(materials.length).toBe(2)
      expect(materials[0]).not.toBe(materials[1])
      // The control: they are distinct *instances* but not distinct *looks*.
      expect(materials[0]?.type).toBe(materials[1]?.type)
    })
  })

  describe('the lights', () => {
    /**
     * What a surface facing `normal` receives, summed over the scene's own lights and divided
     * by π the way three.js's `BRDF_Lambert` does — so 1 means the material's full base colour
     * reaches the eye and 0 means black.
     *
     * Computed from the lights that are actually in the scene rather than asserting on their
     * count or their intensities. A test that read back `AMBIENT_SHARE * Math.PI` would be the
     * source restated; this one fails if a light is dropped, if the pair stops being opposed,
     * or if an intensity is written without its π.
     */
    function irradiance(scene: Scene, normal: Vector3): number {
      let total = 0
      scene.traverse((node) => {
        const light = node as Partial<Light> & { position?: Vector3 }
        if ((light as Partial<AmbientLight>).isAmbientLight === true) {
          total += (light.intensity ?? 0) / Math.PI
        } else if ((light as Partial<DirectionalLight>).isDirectionalLight === true) {
          // A DirectionalLight's target defaults to the origin, so its position is the
          // direction the light comes *from* — which is what a surface normal dots against.
          const towards = light.position!.clone().normalize()
          total += (Math.max(0, normal.dot(towards)) * (light.intensity ?? 0)) / Math.PI
        }
      })
      return total
    }

    /**
     * The rasterizer's light direction, and the floor the viewer settled on. The direction is
     * copied from `raster.ts`; the floor is not — see the trade table on `AMBIENT_SHARE`.
     */
    const LIGHT = new Vector3(-0.3, -0.55, 0.78).normalize()
    const FLOOR = 0.2

    it('reproduces AMBIENT + (1 - AMBIENT) · |N·L| for every direction', async () => {
      const made: FakeRenderer[] = []
      const { host } = await setup({ create: recording(made) })
      const { scene } = drawn(rendererOf(host, made))

      // Sampled over a spiral covering the whole sphere, not the handful of directions that
      // happen to be easy: a single mis-signed light passes at the pole and fails at the
      // equator, and the reverse.
      for (let i = 0; i < 200; i++) {
        const z = 1 - (2 * (i + 0.5)) / 200
        const r = Math.sqrt(Math.max(0, 1 - z * z))
        const phi = i * 2.399963
        const normal = new Vector3(r * Math.cos(phi), r * Math.sin(phi), z)
        const expected = FLOOR + (1 - FLOOR) * Math.abs(normal.dot(LIGHT))
        expect(irradiance(scene, normal)).toBeCloseTo(expected, 6)
      }
    })

    it('never lets a face go dark, and never lets one clip', async () => {
      // The two properties the formula above exists for, spelled out so a reader does not have
      // to evaluate it: no surface is ever black, whichever way the user has orbited, and no
      // surface ever exceeds the base colour, so the model's own tone is what reaches the eye.
      const made: FakeRenderer[] = []
      const { host } = await setup({ create: recording(made) })
      const { scene } = drawn(rendererOf(host, made))

      // Edge-on to the light is the darkest a face can be...
      const edgeOn = new Vector3(1, 0, 0).cross(LIGHT).normalize()
      expect(irradiance(scene, edgeOn)).toBeCloseTo(FLOOR, 6)
      // ...and square on to it is the brightest, in both directions.
      expect(irradiance(scene, LIGHT)).toBeCloseTo(1, 6)
      expect(irradiance(scene, LIGHT.clone().negate())).toBeCloseTo(1, 6)
    })

    it('keeps a box’s three faces far enough apart to read as a box', async () => {
      // The property the floor was lowered for, and the one nothing else here would catch: a
      // raised floor leaves every assertion above true (the formula still holds, no face is
      // black, nothing clips) while flattening an axis-aligned part into a silhouette. B1 spent
      // several rounds on "three obviously different tones is what tells the eye it is a box",
      // and most of a print library is boxy.
      //
      // The bound is asserted on the shade ratio rather than on rendered pixels because that is
      // what caps the contrast a viewer can ever show: two lit faces cannot differ by more than
      // their irradiances do. Measured on the built page, these ratios come out as 1.26:1 and
      // 1.39:1 of WCAG contrast, against 1.22:1 and 1.32:1 before the floor moved.
      const made: FakeRenderer[] = []
      const { host } = await setup({ create: recording(made) })
      const { scene } = drawn(rendererOf(host, made))

      const top = irradiance(scene, new Vector3(0, 0, 1))
      const front = irradiance(scene, new Vector3(0, -1, 0))
      const rightEnd = irradiance(scene, new Vector3(1, 0, 0))

      // Ordered the way a printed part on a bed is lit, and separated by a margin the previous
      // 0.28 floor did not clear — it gave 1.2449 and 1.3628, against 1.2871 and 1.4545 now, so
      // these two bounds are red at the old value and green at the new one.
      expect(top).toBeGreaterThan(front)
      expect(front).toBeGreaterThan(rightEnd)
      expect(top / front).toBeGreaterThan(1.27)
      expect(front / rightEnd).toBeGreaterThan(1.42)

      // And the same knob's other end, so this test cannot be satisfied by dropping the floor
      // to nothing: the darkest possible face still receives a fifth of the base colour.
      const edgeOn = new Vector3(1, 0, 0).cross(LIGHT).normalize()
      expect(irradiance(scene, edgeOn)).toBeGreaterThan(0.19)
    })
  })

  describe('getting back to the opening view', () => {
    /** Opens a model, then moves the camera the way a drag does. */
    async function orbited() {
      const made: FakeRenderer[] = []
      const { harness, host, observer, page } = await setup({ create: recording(made) })
      observer?.emit(800, 600)
      const { camera } = drawn(rendererOf(host, made))
      const opened = camera.position.clone()

      // The same event the component listens for, so the "the camera is the user's now" flag
      // is set exactly as a real drag sets it. jsdom implements no pointer capture, and the
      // real OrbitControls takes it on the first pointerdown, so it is stubbed here the same
      // way the framing suite already stubs it.
      const canvas = host.querySelector('canvas') as HTMLCanvasElement
      canvas.setPointerCapture = () => {}
      canvas.dispatchEvent(new Event('pointerdown'))
      controlsOf(page).rotateLeft(1.1)
      controlsOf(page).dollyOut(0.5)
      settleCamera(rendererOf(host, made))
      harness.detectChanges()

      expect(camera.position.distanceTo(opened)).toBeGreaterThan(1)
      return { harness, host, observer, camera, opened, renderer: rendererOf(host, made) }
    }

    /**
     * The same drag, caught while it is still coasting.
     *
     * `orbited()` above settles the camera so that its precondition is deterministic. That is
     * the right call for what it tests and the wrong one for what this tests: settling is
     * exactly what drains OrbitControls' damping residue, so a suite built only on `orbited()`
     * can never see a reset that has residue to contend with — which is the reset a real user
     * performs, since damping coasts for about a second after every drag.
     *
     * Eight ticks rather than five hundred: enough that the camera has visibly moved, few enough
     * that about two thirds of the rotation delta is still unspent. The test directly below pins
     * that "still unspent" property, so putting a settle back in here reddens something.
     */
    async function orbitedMidCoast() {
      const made: FakeRenderer[] = []
      const { harness, host, observer, page } = await setup({ create: recording(made) })
      observer?.emit(800, 600)
      const renderer = rendererOf(host, made)
      const { camera } = drawn(renderer)
      const opened = camera.position.clone()

      const canvas = host.querySelector('canvas') as HTMLCanvasElement
      canvas.setPointerCapture = () => {}
      canvas.dispatchEvent(new Event('pointerdown'))
      controlsOf(page).rotateLeft(1.1)
      controlsOf(page).dollyOut(0.5)
      for (let index = 0; index < 8; index++) renderer.tick()
      harness.detectChanges()

      expect(camera.position.distanceTo(opened)).toBeGreaterThan(1)
      const viewport = host.querySelector('.spm-viewport') as HTMLElement
      return { harness, host, observer, camera, opened, renderer, viewport }
    }

    it('leaves the drag coasting, which is the whole point of the mid-coast helper', async () => {
      // A control on the helper rather than on the component. If a future edit adds a settle to
      // `orbitedMidCoast()` — the natural thing to do when a test built on it looks flaky — the
      // two resets below quietly stop testing anything and this reddens instead.
      const { camera, renderer } = await orbitedMidCoast()

      const before = camera.position.clone()
      renderer.tick()

      expect(camera.position.distanceTo(before)).toBeGreaterThan(1e-3)
    })

    it('offers the control only once there is a view to reset', async () => {
      const { host } = await setup({
        files: [fileDto({ name: 'sliced.gcode', kind: 'other' })],
      })
      expect(resetButton(host)).toBeNull()

      // The control, and the reason this test is not vacuous: the same query does find it on a
      // page that loaded a model.
      restart()
      const ready = await setup({})
      expect(resetButton(ready.host)).not.toBeNull()
    })

    it('puts the camera back where the model opened', async () => {
      const { harness, host, camera, opened, renderer } = await orbited()

      resetButton(host)!.click()
      harness.detectChanges()
      settleCamera(renderer)

      expect(camera.position.distanceTo(opened)).toBeLessThan(1e-6)
    })

    it('puts the camera back while the drag is still coasting', async () => {
      // The case the test above structurally cannot reach, and the one that shipped broken.
      //
      // `orbited()` settles the camera before it asserts, so that its "the camera really moved"
      // precondition is deterministic — and settling is precisely what drains OrbitControls'
      // damping residue. So the only reset the suite could ever see was one with nothing left to
      // coast. Measured in a browser, a reset pressed mid-coast used to leave about half the
      // drag in place, permanently, because the animation loop went on spending the residue on
      // top of the reset camera. Damping runs for about a second after every drag, so that is
      // the normal case rather than a corner.
      //
      // The precondition that made the other assertion deterministic was the same one that
      // removed the bug. This variant therefore does the opposite: it ticks just enough for the
      // camera to have visibly moved and leaves the rest of the residue alive.
      const { harness, host, camera, opened, renderer } = await orbitedMidCoast()

      resetButton(host)!.click()
      harness.detectChanges()
      // Long enough that any surviving residue would have been spent by now.
      settleCamera(renderer)

      expect(camera.position.distanceTo(opened)).toBeLessThan(1e-6)
    })

    it('puts the camera back while the drag is still coasting, from the keyboard', async () => {
      // `0` goes through the same `resetView`, but it is the path a keyboard user has and the
      // one with no button to press twice if the first press half-works.
      const { harness, camera, opened, renderer, viewport } = await orbitedMidCoast()

      viewport.dispatchEvent(new KeyboardEvent('keydown', { key: '0' }))
      harness.detectChanges()
      settleCamera(renderer)

      expect(camera.position.distanceTo(opened)).toBeLessThan(1e-6)
    })

    it('hands the automatic re-fit back, so a later resize frames the model again', async () => {
      // The half of the reset that is invisible in a screenshot. Re-framing without clearing
      // the flag leaves the camera correct now and frozen forever after, which is the same bug
      // in slow motion.
      const { harness, host, observer, camera, renderer } = await orbited()

      resetButton(host)!.click()
      harness.detectChanges()
      settleCamera(renderer)
      const afterReset = camera.position.length()

      observer?.emit(300, 900)

      expect(camera.position.length()).toBeGreaterThan(afterReset * 1.5)
    })

    it('does not re-fit on resize while the camera is still the user’s', async () => {
      // The control for the test above: without it, "a resize re-frames" would pass whether or
      // not the reset had cleared anything.
      const { observer, camera } = await orbited()
      const before = camera.position.clone()

      observer?.emit(300, 900)

      expect(camera.position.distanceTo(before)).toBeLessThan(1e-6)
    })
  })

  describe('the keyboard path', () => {
    async function focusable() {
      const made: FakeRenderer[] = []
      const { harness, host, observer } = await setup({ create: recording(made) })
      observer?.emit(800, 600)
      const renderer = rendererOf(host, made)
      const { camera } = drawn(renderer)
      const viewport = host.querySelector('.spm-viewport') as HTMLElement
      /**
       * One key press, all the way through the damping.
       *
       * The settle is not decoration. A press hands OrbitControls a delta it spends 5 % of
       * per frame, so an assertion taken straight afterwards reads a twentieth of the
       * movement — enough for "it moved" and useless for "the opposite key undoes it".
       */
      const press = (key: string, init: KeyboardEventInit = {}): boolean => {
        const event = new KeyboardEvent('keydown', {
          key,
          bubbles: true,
          cancelable: true,
          ...init,
        })
        viewport.dispatchEvent(event)
        settleCamera(renderer)
        return event.defaultPrevented
      }
      return { harness, host, observer, viewport, camera, renderer, press }
    }

    it('is reachable by tab only while there is a model to orbit', async () => {
      const { viewport } = await focusable()
      expect(viewport.getAttribute('tabindex')).toBe('0')

      // The control. A focus stop on an empty panel is a trap with nothing behind it.
      restart()
      const { host } = await setup({ files: [fileDto({ name: 'sliced.gcode', kind: 'other' })] })
      expect(host.querySelector('.spm-viewport')?.getAttribute('tabindex')).toBeNull()
    })

    it('orbits left and right about the bed normal', async () => {
      const { camera, press } = await focusable()
      const before = camera.position.clone()

      expect(press('ArrowRight')).toBe(true)

      // Turned, at constant radius and constant height — the same axis a drag uses.
      expect(camera.position.length()).toBeCloseTo(before.length(), 6)
      expect(camera.position.z).toBeCloseTo(before.z, 6)
      expect(camera.position.x).not.toBeCloseTo(before.x, 6)

      // And the opposite key really is the opposite: back to the start, not twice as far.
      press('ArrowLeft')
      expect(camera.position.distanceTo(before)).toBeLessThan(1e-6)
    })

    it('raises and lowers the camera', async () => {
      const { camera, press } = await focusable()
      const before = camera.position.clone()

      press('ArrowUp')
      expect(camera.position.z).toBeGreaterThan(before.z)

      press('ArrowDown')
      expect(camera.position.z).toBeCloseTo(before.z, 6)
    })

    it('zooms the way the sign says, which is not the way OrbitControls names it', async () => {
      // The assertion that earned its place: `dollyIn` multiplies the orbit radius, so the
      // obvious spelling zooms *out*. Driving the real page is what caught it — `-` made the
      // model bigger. Asserted on the distance, which is the thing the user sees.
      const { camera, press } = await focusable()
      const before = camera.position.length()

      press('+')
      const closer = camera.position.length()
      expect(closer).toBeLessThan(before)

      press('-')
      expect(camera.position.length()).toBeCloseTo(before, 6)

      // '=' is the same key unshifted, and must do the same thing rather than nothing.
      press('=')
      expect(camera.position.length()).toBeCloseTo(closer, 6)
    })

    it('resets on 0, and hands the automatic re-fit back with it', async () => {
      const { observer, camera, press } = await focusable()
      const opened = camera.position.clone()
      for (let i = 0; i < 6; i++) press('ArrowRight')
      expect(camera.position.distanceTo(opened)).toBeGreaterThan(1)

      expect(press('0')).toBe(true)
      expect(camera.position.distanceTo(opened)).toBeLessThan(1e-6)

      // Keyboard orbiting takes the camera exactly as a drag does, so 0 has to give it back
      // exactly as the button does.
      const afterReset = camera.position.length()
      observer?.emit(300, 900)
      expect(camera.position.length()).toBeGreaterThan(afterReset * 1.5)
    })

    it('leaves chords and unclaimed keys to the browser', async () => {
      const { camera, press } = await focusable()
      const before = camera.position.clone()

      // Ctrl+Right is "next word" and Shift+Right is a selection; Tab is the way out of here.
      // Swallowing any of them would be a worse accessibility bug than having no keys at all.
      expect(press('ArrowRight', { ctrlKey: true })).toBe(false)
      expect(press('ArrowRight', { shiftKey: true })).toBe(false)
      expect(press('ArrowRight', { altKey: true })).toBe(false)
      expect(press('ArrowRight', { metaKey: true })).toBe(false)
      expect(press('Tab')).toBe(false)
      expect(press('a')).toBe(false)
      expect(camera.position.distanceTo(before)).toBeLessThan(1e-9)

      // The control: the very same helper, on the very same element, does move the camera and
      // does claim the event when the key is one of ours.
      expect(press('ArrowRight')).toBe(true)
      expect(camera.position.distanceTo(before)).toBeGreaterThan(0)
    })
  })

  describe('the stage', () => {
    /**
     * Looked at in a browser, every non-drawing outcome sat above an empty panel three quarters
     * of the viewport tall — a viewer that had visibly failed rather than one that had
     * deliberately not started. Most visible on the size gate, which owns none of the CSS and
     * had never been seen.
     */
    const collapsed = (host: HTMLElement) =>
      host.querySelector('.spm-viewport')?.classList.contains('spm-viewport--collapsed')

    it('keeps the stage for a model, and for one on its way', async () => {
      const { host } = await setup({})
      expect(collapsed(host)).toBe(false)

      restart()
      const gated = paced(STL_BOX, 2)
      const loading = await setup({
        serve: () => Promise.resolve(gated.response),
        wait: false,
      })
      await vi.waitFor(() => {
        loading.harness.detectChanges()
        expect(loading.page.state().status).toBe('loading')
      })
      expect(collapsed(loading.host)).toBe(false)
    })

    it('gives the room back when there is nothing to draw', async () => {
      const oversized = await setup({
        files: [fileDto({ name: 'huge.stl', sizeBytes: Math.ceil(sizeLimitFor('huge.stl')!) + 1 })],
      })
      expect(oversized.page.state().status).toBe('oversized')
      expect(collapsed(oversized.host)).toBe(true)

      restart()
      const unsupported = await setup({
        files: [fileDto({ name: 'sliced.gcode', kind: 'other' })],
      })
      expect(collapsed(unsupported.host)).toBe(true)

      restart()
      const noWebgl = await setup({
        create: () => {
          throw new Error('WebGL unavailable')
        },
      })
      expect(collapsed(noWebgl.host)).toBe(true)
    })
  })

  describe('on navigating away', () => {
    /**
     * The point of the whole task. A WebGL context is not freed on the garbage collector's
     * schedule, and Chrome keeps only 16 alive per page before it starts killing the oldest —
     * so a viewer that leaks one per navigation bricks the tab after a handful of models,
     * silently. Every assertion below covers exactly one release, and each one has been
     * checked to go red on its own when its call is removed.
     */
    async function open(options: Options = {}): Promise<{
      harness: RouterTestingHarness
      host: HTMLElement
      page: ViewerPage
      renderer: FakeRenderer
      observer: FakeResizeObserver | undefined
      spies: Spies
    }> {
      const spies = spyOnDisposals()
      const made: FakeRenderer[] = []
      const { harness, host, page, observer } = await setup({ ...options, create: recording(made) })
      return { harness, host, page, renderer: rendererOf(host, made), observer, spies }
    }

    it('stops the frame loop before anything it draws with is freed', async () => {
      const { harness, renderer } = await open()
      renderer.tick()
      const before = renderer.render.mock.calls.length

      await harness.navigateByUrl('/blank')

      expect(renderer.animationLoop).toBeNull()
      // Not merely "the handle was cleared": a frame after teardown would draw with a
      // disposed scene into a lost context.
      renderer.tick()
      expect(renderer.render.mock.calls.length).toBe(before)
      expect(callOrder(renderer.setAnimationLoop, 1)).toBeLessThan(callOrder(renderer.dispose, 0))
    })

    it('disposes the geometry', async () => {
      const { harness, spies } = await open()
      expect(spies.geometry).not.toHaveBeenCalled()

      await harness.navigateByUrl('/blank')

      expect(spies.geometry).toHaveBeenCalledTimes(1)
    })

    it('disposes the material', async () => {
      const { harness, spies } = await open()
      await harness.navigateByUrl('/blank')
      expect(spies.material).toHaveBeenCalledTimes(1)
    })

    it('disposes the texture the material holds', async () => {
      const { harness, page, spies } = await open()
      // Neither STLLoader nor OBJLoader produces a texture, and a 3MF's are optional, so the
      // textured model is placed through the same seam a finished load goes through. Textures
      // are the largest thing a model drags onto the GPU and the easiest to miss: disposing a
      // material does not touch its maps.
      seam(page).setContent(strayModel())
      spies.texture.mockClear()

      await harness.navigateByUrl('/blank')

      expect(spies.texture).toHaveBeenCalledTimes(1)
    })

    it('disposes the controls', async () => {
      const { harness, spies } = await open()
      await harness.navigateByUrl('/blank')
      // OrbitControls holds pointer listeners on the canvas, which keep the canvas — and
      // through it the context — reachable.
      expect(spies.controls).toHaveBeenCalledTimes(1)
    })

    it('disposes the renderer', async () => {
      const { harness, renderer } = await open()
      await harness.navigateByUrl('/blank')
      expect(renderer.dispose).toHaveBeenCalledTimes(1)
    })

    it('forces the context loss, because dispose() alone does not release it', async () => {
      const { harness, renderer } = await open()
      await harness.navigateByUrl('/blank')
      expect(renderer.forceContextLoss).toHaveBeenCalledTimes(1)
    })

    it('drops the canvas element', async () => {
      const { harness, host } = await open()
      // The container, held onto deliberately: Angular detaches the whole host subtree on
      // navigation, so `isConnected` goes false whether the component drops the canvas or
      // not. Asking the (now detached) viewport whether it still owns a canvas is the only
      // form of this assertion that can tell the two apart.
      const viewport = host.querySelector('.spm-viewport')
      expect(viewport?.querySelector('canvas')).not.toBeNull()

      await harness.navigateByUrl('/blank')

      expect(viewport?.querySelector('canvas')).toBeNull()
    })

    it('disconnects the resize observer', async () => {
      const { harness, observer } = await open()
      await harness.navigateByUrl('/blank')
      expect(observer?.disconnected).toBe(true)
    })

    it('disposes a model that arrives after the scene is gone', async () => {
      const { harness, page, spies } = await open()

      await harness.navigateByUrl('/blank')
      // The loaded model's own teardown, already counted. What is under test is what happens
      // next.
      spies.geometry.mockClear()
      spies.material.mockClear()
      spies.texture.mockClear()

      // The unit form of the case below: a fully parsed model handed to the component with no
      // scene left to put it in. Dropping it on the floor would strand its buffers on the GPU.
      seam(page).setContent(strayModel())

      expect(spies.geometry).toHaveBeenCalledTimes(1)
      expect(spies.material).toHaveBeenCalledTimes(1)
      expect(spies.texture).toHaveBeenCalledTimes(1)
    })

    it('abandons the download when the page goes away', async () => {
      const parse = vi.spyOn(STLLoader.prototype, 'parse')
      const gated = paced(STL_BOX, 2)
      const { harness, page, fetch } = await setup({
        serve: () => Promise.resolve(gated.response),
        wait: false,
      })
      await vi.waitFor(() => expect(fetch).toHaveBeenCalled())
      gated.next()
      await vi.waitFor(() => expect(page.state()).toEqual({ status: 'loading', progress: 0.5 }))

      const signal = fetch.mock.calls[0]?.[1]?.signal
      expect(signal?.aborted).toBe(false)
      expect(gated.cancelled()).toBe(false)
      // Captured by identity: nothing may write to a destroyed component's state, and a new
      // state object is how that would show.
      const before = page.state()

      await harness.navigateByUrl('/blank')

      // Cut off, not merely ignored. Left running, a 164 MB STL over a home connection goes on
      // arriving for minutes: its buffer stays resident, the server's stream stays open, and it
      // finally parses itself on whatever page the user went to, purely to be disposed.
      expect(signal?.aborted).toBe(true)
      expect(gated.cancelled()).toBe(true)

      // Releasing the rest changes nothing, because nobody is reading any more.
      gated.next()
      await flush()
      expect(parse).not.toHaveBeenCalled()
      expect(page.state()).toBe(before)
    })

    it('abandons the earlier download when the route moves to another file', async () => {
      const first = paced(STL_BOX, 2)
      const { harness, page, fetch } = await setup({
        files: [
          fileDto(),
          fileDto({ id: 'f2', rawUrl: '/api/files/f2/raw', sizeBytes: STL_WEDGE.byteLength }),
        ],
        serve: (url) =>
          Promise.resolve(url === '/api/files/f1/raw' ? first.response : servedAtOnce(STL_WEDGE)),
        wait: false,
      })
      await vi.waitFor(() => expect(fetch).toHaveBeenCalled())
      first.next()
      await vi.waitFor(() => expect(page.state()).toEqual({ status: 'loading', progress: 0.5 }))

      await harness.navigateByUrl('/projects/p1/view/f2', ViewerPage)
      await settle()

      // Half of f1 was still on the wire when the route moved on. Those bytes are of no use to
      // anyone, and on this connection the second file would have queued behind the first.
      expect(first.cancelled()).toBe(true)
      expect(page.state()).toEqual({ status: 'ready' })
      // `whenStable()` resolves at all only because the abandoned load really did settle — with
      // f1 left running it is a pending task and the application never goes stable again.
    })

    it('takes every listener back off the canvas', async () => {
      const add = vi.spyOn(HTMLCanvasElement.prototype, 'addEventListener')
      const remove = vi.spyOn(HTMLCanvasElement.prototype, 'removeEventListener')
      const { harness, host } = await open()
      const canvas = host.querySelector('canvas') as HTMLCanvasElement

      // The control, and the reason this is not vacuous: they really are on there first. Three
      // are the component's own, and the other five are OrbitControls' — which this test covers
      // too, so `controls.dispose()` is pinned twice over.
      const before = leakedListeners(add, remove, canvas)
      expect(before).toContain('webglcontextlost')
      expect(before).toContain('pointerdown')
      expect(before).toContain('wheel')
      // Two types only OrbitControls registers, so its listeners are demonstrably in scope
      // here as well. Named rather than counted: a three.js upgrade may add or drop one.
      expect(before).toContain('contextmenu')
      expect(before).toContain('pointercancel')

      await harness.navigateByUrl('/blank')

      // Every one of them, paired by handler identity. A listener left on a detached canvas is
      // a closure over the component, and through it over the WebGL context — and the
      // per-listener form of this test is exactly what B1 forgot to write.
      expect(leakedListeners(add, remove, canvas)).toEqual([])
    })

    it('stops listening for context loss', async () => {
      const { harness, host, page } = await open()
      const canvas = host.querySelector('canvas')

      await harness.navigateByUrl('/blank')
      // Detached, but a listener still on it would still fire — and the handler is a closure
      // over `this`, so it keeps the component and the canvas reachable.
      canvas?.dispatchEvent(new Event('webglcontextlost'))

      expect(page.initError()).toBeNull()
    })
  })

  /**
   * The other half of "a parsed model nobody will install must be released, not dropped".
   *
   * A supersession normally cuts the older transfer off long before it finishes parsing (see
   * "abandons the earlier download…"), so this branch — like `setContent`'s — is now reached
   * through a seam rather than from a live path. It is kept because the unreachability is a
   * property of today's await topology and not of the design: the only awaits between the abort
   * point and the install are network reads, and moving the parse of a 164 MB STL into a Worker
   * puts one back that no signal covers.
   *
   * The seam pokes the load token, which is precisely what a supersession does to it. Everything
   * else — the fetch, the chunked read, the real STLLoader — is the production pipeline.
   */
  it('releases a model whose load was superseded while it was parsing', async () => {
    const spies = spyOnDisposals()
    const gated = paced(STL_BOX, 2)
    const made: FakeRenderer[] = []
    const { harness, host, page, fetch } = await setup({
      create: recording(made),
      serve: () => Promise.resolve(gated.response),
      wait: false,
    })
    await vi.waitFor(() => expect(fetch).toHaveBeenCalled())
    gated.next()
    await vi.waitFor(() => expect(page.state()).toEqual({ status: 'loading', progress: 0.5 }))
    expect(spies.geometry).not.toHaveBeenCalled()

    // Superseded, without the abort that would normally accompany it.
    stale(page)

    gated.next()
    await vi.waitFor(() => expect(spies.geometry).toHaveBeenCalledTimes(1))

    // f1 parsed into a real scene graph and was released rather than installed: its geometry
    // and its material are both gone, and nothing was ever added to the scene.
    expect(spies.material).toHaveBeenCalledTimes(1)
    harness.detectChanges()
    expect(meshesIn(drawn(rendererOf(host, made)).scene)).toEqual([])
  })
})
