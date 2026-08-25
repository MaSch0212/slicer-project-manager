import { signal } from '@angular/core'
import { TestBed } from '@angular/core/testing'
import { Router, provideRouter, withComponentInputBinding } from '@angular/router'
import { RouterTestingHarness } from '@angular/router/testing'
import {
  BoxGeometry,
  BufferGeometry,
  DataTexture,
  Material,
  Mesh,
  MeshStandardMaterial,
  PerspectiveCamera,
  Texture,
  type Object3D,
  type WebGLRenderer,
} from 'three'
import { OrbitControls } from 'three/addons/controls/OrbitControls.js'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Capabilities } from '@spm/contract/dtos.ts'
import { AuthStore } from '../../core/auth.store'
import { CapabilitiesStore } from '../../core/capabilities.store'
import { authGuard } from '../../core/guards'
import { TranslateService } from '../../core/i18n/translate.service'
import en from '../../core/i18n/locales/en.json'
import { sharedRoutes } from '../../routes.shared'
import { provideJigForTests } from '../../../testing/jig'
import { VIEWER_RENDERER_FACTORY, ViewerPage } from './viewer.page'

const CAPABILITIES: Capabilities = {
  requiresAuth: true,
  canManageUsers: false,
  canPickLocalFolder: false,
  canLaunchSlicer: false,
  canConfigureSlicers: false,
  canBrowseModelSites: false,
}

const VIEW_URL = '/projects/p1/view/f1'

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
    render: vi.fn(),
    dispose: vi.fn(),
    forceContextLoss: vi.fn(),
    /** Drives one frame the way the browser would, so "the loop stopped" is observable. */
    tick: () => fake.animationLoop?.(),
  }
  return fake
}

type FakeRenderer = ReturnType<typeof fakeRenderer>

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

/** The TestBed, with the real route table but nothing navigated yet. */
async function configure(
  create: (canvas: HTMLCanvasElement) => WebGLRenderer,
  authenticated: boolean,
): Promise<void> {
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
        useValue: { isAuthenticated: signal(authenticated), isAdmin: signal(false) },
      },
      { provide: VIEWER_RENDERER_FACTORY, useValue: create },
    ],
  })
  await TestBed.inject(TranslateService).ready
}

async function setup(
  create: (canvas: HTMLCanvasElement) => WebGLRenderer = (canvas) =>
    fakeRenderer(canvas) as unknown as WebGLRenderer,
): Promise<{
  harness: RouterTestingHarness
  page: ViewerPage
  host: HTMLElement
  observer: FakeResizeObserver | undefined
}> {
  await configure(create, true)

  const harness = await RouterTestingHarness.create()
  const page = await harness.navigateByUrl(VIEW_URL, ViewerPage)
  harness.detectChanges()

  return {
    harness,
    page,
    host: harness.routeNativeElement as HTMLElement,
    observer: FakeResizeObserver.instances.at(-1),
  }
}

/**
 * Reaches `setContent` past its `private` modifier, which TypeScript only enforces at compile
 * time.
 *
 * There is no precedent for this idiom elsewhere in the codebase, so: the "content arrives when
 * there is no scene left to hold it" branch is unreachable through the public surface until
 * task 2 makes loading async, and an untested disposal path is precisely what this task exists
 * to prevent. The alternative was a production seam nothing else needs, invented on a guess
 * about task 2's design.
 */
function seam(page: ViewerPage): { setContent(next: Object3D | null): void } {
  return page as unknown as { setContent(next: Object3D | null): void }
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
    // withComponentInputBinding: both route params reach the component, which is what task 2
    // needs in order to fetch anything at all.
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
    await configure((canvas) => fakeRenderer(canvas) as unknown as WebGLRenderer, false)
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
    const { host } = await setup((canvas) => {
      const fake = fakeRenderer(canvas)
      made.push(fake)
      return fake as unknown as WebGLRenderer
    })

    const canvas = host.querySelector('canvas')
    expect(canvas).not.toBeNull()

    const renderer = rendererOf(host, made)
    expect(renderer.animationLoop).toBeTypeOf('function')
    renderer.tick()
    expect(renderer.render).toHaveBeenCalled()
  })

  it('clears transparently so the themed container behind it shows through', async () => {
    const made: FakeRenderer[] = []
    const { host } = await setup((canvas) => {
      const fake = fakeRenderer(canvas)
      made.push(fake)
      return fake as unknown as WebGLRenderer
    })

    // A hardcoded clear colour would be illegible in one of the two themes. Alpha 0 hands the
    // background to CSS, which tracks the light/dark switch with no JS at all.
    expect(rendererOf(host, made).clearAlpha).toBe(0)
  })

  it('says so in words when a WebGL context cannot be created', async () => {
    const { host, page } = await setup(() => {
      throw new Error('WebGL unavailable')
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
  })

  it('says so in words when the browser takes the context back at runtime', async () => {
    const made: FakeRenderer[] = []
    const { harness, host, page } = await setup((canvas) => {
      const fake = fakeRenderer(canvas)
      made.push(fake)
      return fake as unknown as WebGLRenderer
    })
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

  it('swaps the model when the router reuses it for another file', async () => {
    const spies = spyOnDisposals()
    const made: FakeRenderer[] = []
    const { harness, page } = await setup((canvas) => {
      const fake = fakeRenderer(canvas)
      made.push(fake)
      return fake as unknown as WebGLRenderer
    })

    const next = await harness.navigateByUrl('/projects/p1/view/f2', ViewerPage)

    // Angular's default reuse strategy keeps the instance and swaps only the input, so
    // ngAfterViewInit does not re-run — the trap project-detail.page.ts documents for `:id`.
    // Without a reactive trigger the viewer would sit there showing the previous model.
    expect(next).toBe(page)
    expect(next.fileId()).toBe('f2')
    // The previous cube was released rather than merely detached...
    expect(spies.geometry).toHaveBeenCalledTimes(1)
    expect(spies.material).toHaveBeenCalledTimes(1)
    expect(spies.texture).toHaveBeenCalledTimes(1)
    // ...and the context was reused, not rebuilt, which is the whole reason reuse is safe.
    expect(made.length).toBe(1)
    expect(made[0]?.dispose).not.toHaveBeenCalled()
  })

  it('follows its container with a ResizeObserver rather than the window', async () => {
    const made: FakeRenderer[] = []
    const aspect = vi.spyOn(PerspectiveCamera.prototype, 'updateProjectionMatrix')
    const { host, observer } = await setup((canvas) => {
      const fake = fakeRenderer(canvas)
      made.push(fake)
      return fake as unknown as WebGLRenderer
    })

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

  describe('on navigating away', () => {
    /**
     * The point of the whole task. A WebGL context is not freed on the garbage collector's
     * schedule, and Chrome keeps only 16 alive per page before it starts killing the oldest —
     * so a viewer that leaks one per navigation bricks the tab after a handful of models,
     * silently. Every assertion below covers exactly one release, and each one has been
     * checked to go red on its own when its call is removed.
     */
    async function open(): Promise<{
      harness: RouterTestingHarness
      host: HTMLElement
      page: ViewerPage
      renderer: FakeRenderer
      observer: FakeResizeObserver | undefined
      spies: Spies
    }> {
      const spies = spyOnDisposals()
      const made: FakeRenderer[] = []
      const { harness, host, page, observer } = await setup((canvas) => {
        const fake = fakeRenderer(canvas)
        made.push(fake)
        return fake as unknown as WebGLRenderer
      })
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
      const { harness, spies } = await open()
      await harness.navigateByUrl('/blank')
      // Textures are the largest thing a model drags onto the GPU and the easiest to miss:
      // disposing a material does not touch its maps.
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
      // The cube's own teardown, already counted. What is under test is what happens next.
      spies.geometry.mockClear()
      spies.material.mockClear()
      spies.texture.mockClear()

      // Task 2 makes createContent() async: navigate away mid-fetch and the parsed model
      // lands here with no scene left to put it in. Dropping it on the floor would strand its
      // buffers on the GPU — the same leak, arriving by a different door.
      seam(page).setContent(strayModel())

      expect(spies.geometry).toHaveBeenCalledTimes(1)
      expect(spies.material).toHaveBeenCalledTimes(1)
      expect(spies.texture).toHaveBeenCalledTimes(1)
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
})
