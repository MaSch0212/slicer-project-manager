import { expect, test, type Locator, type Page } from '@playwright/test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { binaryStlCube, dropModelIntoLibrary, paddedObjCube, signIn } from './fixtures'

/**
 * Names nothing else in the suite uses. Every spec drives the same server against the same
 * library on disk (see the note in playwright.config.ts), so a shared name would make two
 * specs' assertions depend on the order they happen to run in.
 */
const PROJECT = 'Viewer Cube'
const MODEL = 'viewer-cube.stl'
const OVERSIZED = 'viewer-oversized.obj'

/**
 * Big enough to trip the viewer's size gate, and no bigger.
 *
 * The gate refuses a `.obj` past `PEAK_BUDGET_BYTES / peakCost` = 256,000,000 / 28.93 =
 * 8,849,637 bytes (`viewer.page.ts`). This is that line plus about 24 %.
 *
 * The margin is wide because it is free: the padding is comment lines the loader skips, so a
 * fixture 2 MB clear of the line costs the same parse as one 0.1 MB clear of it, and only the
 * write and the localhost download scale. It was 6 % over the line the day it was written and
 * became 24 % when `.obj` was re-measured from 24.6 to 28.93 — kept at 11 MB rather than trimmed,
 * because a fixture that has to be re-derived every time a cost moves is a fixture that will one
 * day not be.
 *
 * The constant is not imported — reaching into the app module from here would pull three.js and
 * the whole Angular graph into the test process — so if `.obj`'s `peakCost` is ever re-measured
 * below about **23.3** the line moves past this file and the gate stops appearing. That shows up
 * as this test failing on a missing prompt, which is the right way for it to break.
 */
const OVERSIZED_BYTES = 11_000_000

const CANVAS_LABEL = /^3D view of the model/
const BACK = 'Back to the project'

type Rgb = [number, number, number]

/** WCAG relative luminance of an opaque sRGB colour. */
function luminance([r, g, b]: Rgb): number {
  const channel = (value: number): number => {
    const srgb = value / 255
    return srgb <= 0.03928 ? srgb / 12.92 : ((srgb + 0.055) / 1.055) ** 2.4
  }
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b)
}

/** WCAG contrast ratio, always >= 1 whichever way round the two colours are given. */
function contrast(a: Rgb, b: Rgb): number {
  const [dark, light] = [luminance(a), luminance(b)].sort((x, y) => x - y) as [number, number]
  return Number((((light + 0.05) / (dark + 0.05)) as number).toFixed(2))
}

type Frame = {
  width: number
  height: number
  /** The colour of the most pixels, which for a framed model is the stage behind it. */
  background: Rgb
  backgroundShare: number
  /** Share of the frame covered by model pixels away from the model's own outline. */
  modelShare: number
  /**
   * The flat tones the model is drawn in, brightest first, counting only those that cover at
   * least a twentieth of it.
   *
   * The threshold is what separates a face from an edge. Multisampling blends the two faces
   * along every internal edge, so a cube comes back as three broad tones plus eight hairline
   * ones; only the three are a fact about the lighting, and a count that included the blends
   * would be a count of how many pixels the edges happen to be wide.
   */
  faceTones: Rgb[]
}

/**
 * What is actually on the stage, read back as pixels.
 *
 * A screenshot rather than `canvas.toDataURL()`, for two reasons. The renderer is built without
 * `preserveDrawingBuffer`, so the drawing buffer's contents are not guaranteed to anything
 * outside the animation loop — `toDataURL` is entitled to hand back a cleared one, and a test
 * that depends on when the compositor happened to run is a test that will flake on a slower
 * machine. And the screenshot is composited: the canvas clears *transparent* and the background
 * is `.spm-viewport`'s CSS, so only a composite has both the model and the stage it has to be
 * legible against in it.
 *
 * Model pixels are told from stage pixels by hue, not by brightness: `MODEL_COLOUR` is a warm
 * neutral whose red channel is well above its blue at every shade the lighting produces, while
 * both the stage (`rgb(21,25,30)`) and the border (`rgb(103,123,152)`) are blue-dominant. So
 * "warm" is the discriminator, and it keeps working when the model is nearly as dark as the
 * stage — which is exactly the case the contrast assertions care about.
 *
 * Only interior pixels count: a pixel is model if it and its four neighbours all are. Without
 * that erosion the antialiased outline — model blended towards the stage in every proportion —
 * is a supply of arbitrarily dark "model" pixels, and the shadowed end of `faceTones` would be
 * a measurement of the edge filter rather than of the shading.
 */
async function readFrame(page: Page, viewport: Locator): Promise<Frame> {
  const png = await viewport.screenshot()
  return page.evaluate(
    async (dataUrl: string): Promise<Frame> => {
      const image = new Image()
      image.src = dataUrl
      await image.decode()

      const canvas = document.createElement('canvas')
      canvas.width = image.naturalWidth
      canvas.height = image.naturalHeight
      const context = canvas.getContext('2d')
      if (!context) throw new Error('no 2d context to decode the screenshot with')
      context.drawImage(image, 0, 0)
      const { data, width, height } = context.getImageData(0, 0, canvas.width, canvas.height)

      const at = (x: number, y: number): number => (y * width + x) * 4
      const warm = (i: number): boolean => data[i]! > data[i + 2]! + 12

      const counts = new Map<number, number>()
      const modelCounts = new Map<number, number>()
      let modelPixels = 0

      for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
          const i = at(x, y)
          const key = (data[i]! << 16) | (data[i + 1]! << 8) | data[i + 2]!
          counts.set(key, (counts.get(key) ?? 0) + 1)

          if (x === 0 || y === 0 || x === width - 1 || y === height - 1) continue
          const interior =
            warm(i) &&
            warm(at(x - 1, y)) &&
            warm(at(x + 1, y)) &&
            warm(at(x, y - 1)) &&
            warm(at(x, y + 1))
          if (!interior) continue

          modelPixels++
          modelCounts.set(key, (modelCounts.get(key) ?? 0) + 1)
        }
      }

      const unpack = (key: number): [number, number, number] => [
        (key >> 16) & 255,
        (key >> 8) & 255,
        key & 255,
      ]
      // Ordered on the same weights WCAG uses, before the gamma curve — monotone in it, which
      // is all that is needed to put the tones in order.
      const value = ([r, g, b]: [number, number, number]): number =>
        0.2126 * r + 0.7152 * g + 0.0722 * b

      let background = 0
      let backgroundCount = 0
      for (const [key, count] of counts) {
        if (count <= backgroundCount) continue
        ;[backgroundCount, background] = [count, key]
      }

      return {
        width,
        height,
        background: unpack(background),
        backgroundShare: backgroundCount / (width * height),
        modelShare: modelPixels / (width * height),
        faceTones: [...modelCounts]
          .filter(([, count]) => count / modelPixels >= 0.05)
          .map(([key]) => unpack(key))
          .sort((a, b) => value(b) - value(a)),
      }
    },
    `data:image/png;base64,${png.toString('base64')}`,
  )
}

/**
 * Share of pixels that differ between two shots of the stage.
 *
 * A whole-frame comparison rather than anything derived, because what it has to detect is the
 * camera sitting somewhere it should not: the model's tones, its area and the stage colour are
 * all unchanged by a rotation, so every summary in `Frame` is blind to it. Measured idle against
 * idle this is 0.00000 — the renderer is bit-deterministic here — which is what makes a
 * threshold near zero meaningful rather than optimistic.
 *
 * The 2/255 tolerance per channel is not needed today and costs nothing; it keeps the test from
 * turning into a bit-exactness assertion about SwiftShader, which is not what it is for.
 */
async function changedShare(page: Page, before: Buffer, after: Buffer): Promise<number> {
  const urls = [before, after].map((png) => `data:image/png;base64,${png.toString('base64')}`)
  return page.evaluate(async ([one, two]: string[]) => {
    const decode = async (url: string): Promise<ImageData> => {
      const image = new Image()
      image.src = url
      await image.decode()
      const canvas = document.createElement('canvas')
      canvas.width = image.naturalWidth
      canvas.height = image.naturalHeight
      const context = canvas.getContext('2d')
      if (!context) throw new Error('no 2d context to decode the screenshot with')
      context.drawImage(image, 0, 0)
      return context.getImageData(0, 0, canvas.width, canvas.height)
    }
    const a = await decode(one!)
    const b = await decode(two!)
    let changed = 0
    for (let i = 0; i < a.data.length; i += 4) {
      const off =
        Math.abs(a.data[i]! - b.data[i]!) > 2 ||
        Math.abs(a.data[i + 1]! - b.data[i + 1]!) > 2 ||
        Math.abs(a.data[i + 2]! - b.data[i + 2]!) > 2
      if (off) changed++
    }
    return changed / (a.width * a.height)
  }, urls)
}

/** Drags across the stage the way a user spins a model, and lets go. */
async function dragAcross(page: Page, stage: Locator): Promise<void> {
  const box = await stage.boundingBox()
  if (!box) throw new Error('the stage has no box to drag across')
  const x = box.x + box.width / 2
  const y = box.y + box.height / 2
  await page.mouse.move(x, y)
  await page.mouse.down()
  // Many small steps rather than one jump: OrbitControls integrates pointermove deltas, and a
  // single move is one delta, which damping then spends in a couple of frames.
  for (let step = 1; step <= 40; step++) await page.mouse.move(x + step * 4, y + step * 1.5)
  await page.mouse.up()
}

/** The model's lit face and its dimmest one, which is what the contrast assertions read. */
function litAndShadowed(frame: Frame): { lit: Rgb; shadowed: Rgb } {
  const lit = frame.faceTones[0]
  const shadowed = frame.faceTones.at(-1)
  if (!lit || !shadowed) throw new Error('no model on the stage: the frame holds no face tones')
  return { lit, shadowed }
}

/**
 * The panel's own colours, as the browser resolves them — jsdom cannot resolve `var()` at all,
 * which is why nothing in the unit suite can look at these.
 *
 * Each one is painted into a 1x1 canvas and read back rather than parsed out of the string.
 * jig's theme engine emits `color(srgb 0.0806818 0.0965909 0.119318)`, not `rgb(21, 25, 30)`,
 * and a regex over the digits in that reads the stage as very nearly black — which happens to
 * make every contrast ratio come out at about 1:1, so the assertions would have passed for
 * exactly the wrong reason. Painting it is also the like-for-like comparison: the screenshot
 * pixels these are measured against went through the same conversion.
 */
async function readPanelColours(viewport: Locator): Promise<{ stage: Rgb; border: Rgb }> {
  return viewport.evaluate((element: HTMLElement) => {
    const style = getComputedStyle(element)
    const swatch = document.createElement('canvas')
    swatch.width = 1
    swatch.height = 1
    const context = swatch.getContext('2d')
    if (!context) throw new Error('no 2d context to resolve the theme colours with')
    const resolve = (colour: string): [number, number, number] => {
      context.fillStyle = colour
      context.fillRect(0, 0, 1, 1)
      const pixel = context.getImageData(0, 0, 1, 1).data
      return [pixel[0]!, pixel[1]!, pixel[2]!]
    }
    return { stage: resolve(style.backgroundColor), border: resolve(style.borderTopColor) }
  })
}

/** Signs in, makes sure the fixtures are indexed, and lands on the project's page. */
async function openProject(page: Page): Promise<void> {
  await page.goto('/projects')
  await expect(page.getByRole('heading', { name: 'Projects' })).toBeVisible()
  await page.getByRole('button', { name: 'Rescan library' }).click()
  await page.getByRole('heading', { name: PROJECT }).click()
  await expect(page.getByRole('heading', { name: PROJECT, level: 1 })).toBeVisible()
}

/** Opens one file in the viewer and waits for a model to be on the stage. */
async function openInViewer(page: Page, fileName: string): Promise<Locator> {
  await page.getByRole('link', { name: `View in 3D ${fileName}` }).click()
  const stage = page.getByRole('img', { name: CANVAS_LABEL })
  // role="img" is set only in the 'ready' state, so this is "a model is on screen" and not
  // "the page has rendered": every failure arm drops the attribute again.
  await expect(stage).toBeVisible()
  return stage
}

/**
 * One sign-in for this whole file, replayed into each test's context as a cookie.
 *
 * Not a micro-optimisation. `/api/auth` is rate-limited to ten attempts a minute per client
 * address (`AUTH_RATE_LIMIT` in `packages/server/src/routes/auth.ts`), the whole suite runs
 * serially against one server from one address, and it takes about thirty seconds — so the
 * per-test sign-ins are all inside one window. At ten specs the suite sat exactly on the limit;
 * adding the reset test made the eleventh login the one that got throttled, and a throttled login
 * is indistinguishable from a wrong password on the page ("Username or password is not correct"),
 * so it surfaced as a baffling auth failure in an unrelated test.
 *
 * Reusing a session is also simply what a browser does, and it takes this file from five logins
 * to one, leaving the suite headroom instead of a tripwire at exactly ten.
 */
const AUTH_STATE = join(mkdtempSync(join(tmpdir(), 'spm-e2e-auth-')), 'viewer.json')
test.use({ storageState: AUTH_STATE })

test.beforeAll(async ({ browser }) => {
  dropModelIntoLibrary(PROJECT, MODEL, binaryStlCube())
  dropModelIntoLibrary(PROJECT, OVERSIZED, paddedObjCube(OVERSIZED_BYTES))

  // A context of its own with an explicitly empty storage state — this is the one place that has
  // to start signed out. An empty state rather than no option at all: the `browser` fixture
  // applies the `test.use` default to `newContext()` too, so omitting it makes this line try to
  // read the very file it is about to write.
  const context = await browser.newContext({ storageState: { cookies: [], origins: [] } })
  const page = await context.newPage()
  await signIn(page)
  await context.storageState({ path: AUTH_STATE })
  await context.close()
})

/**
 * The assertion the whole subsystem rests on, and the one no unit test can make: that pixels
 * of the model reach the screen.
 *
 * jsdom has no WebGL, so `viewer.page.spec.ts` runs against a stand-in renderer and can only
 * prove the calls were made in the right order. Playwright's Chromium has no GPU either, but it
 * has a real WebGL2 implementation behind it — ANGLE over SwiftShader — so what it composites
 * is what a browser would. Hence pixels, not the presence of a `<canvas>`: an element with a
 * context that never drew, a camera pointed away from the model, a near plane in front of it and
 * a model that failed to parse all produce exactly the same DOM.
 */
test('the viewer draws the model rather than an empty stage', async ({ page }) => {
  await openProject(page)
  const stage = await openInViewer(page, MODEL)

  // The drawing buffer is the panel, not the 1x1 the resize clamp falls back to when the
  // container has no box.
  const buffer = await stage.locator('canvas').evaluate((canvas: HTMLCanvasElement) => ({
    width: canvas.width,
    height: canvas.height,
  }))
  expect(buffer.width).toBeGreaterThan(600)
  expect(buffer.height).toBeGreaterThan(300)

  const frame = await readFrame(page, stage)
  const { stage: stageColour } = await readPanelColours(stage)

  // Most of the panel is the stage, and the stage is the colour the stylesheet says it is —
  // so the canvas really is clearing transparent onto the CSS background rather than painting
  // one of its own.
  expect(frame.background).toEqual(stageColour)
  expect(frame.backgroundShare).toBeGreaterThan(0.4)

  // And a substantial part of it is not. This is the assertion that fails on a blank canvas.
  expect(frame.modelShare).toBeGreaterThan(0.05)

  // A cube shows the isometric camera exactly three faces, and a world-fixed key light puts
  // each on its own flat tone — measured (219,202,182), (196,180,162) and (166,152,137), which
  // is 1.76:1 end to end. That is the assertion that the model is lit and solid rather than a
  // flat silhouette, which is what a light rig welded to the camera draws.
  expect(frame.faceTones).toHaveLength(3)
  const { lit, shadowed } = litAndShadowed(frame)
  expect(contrast(lit, shadowed)).toBeGreaterThan(1.5)

  // Legible against the stage at both ends of its own range: measured 11.04:1 and 6.28:1, well
  // clear of the 3:1 WCAG non-text threshold. Neither is the worst the viewer can produce — a
  // cube's dimmest face is nowhere near edge-on to the light, and a model that has one measures
  // 3.32:1 there (see AMBIENT_SHARE) — so these thresholds are set to what a cube guarantees.
  expect(contrast(lit, stageColour)).toBeGreaterThan(7)
  expect(contrast(shadowed, stageColour)).toBeGreaterThan(3)
})

/**
 * The stage is pinned to the dark end of jig's surface ramp in *both* themes, and the border to
 * the one rung that resolves to the same colour in both (see the note above `.spm-viewport` in
 * styles.css). Nothing in the unit suite can see any of it: jsdom does not resolve `var()`, so
 * the theme tokens are unevaluated strings there.
 *
 * The defect this is aimed at is specific and has shipped once. In the light theme
 * `--jig-color-border` resolves to exactly `--jig-color-surface-100`, which was the stage
 * colour, so the panel's border was a measured no-op — an invisible edge that the CSS still
 * declared. A contrast ratio catches that; reading the declaration back cannot.
 *
 * The theme is switched by emulating `prefers-color-scheme` rather than through the settings
 * page, because the default theme is 'system' and `ColorSchemeService` tracks the media query
 * live. That keeps the assertion off the server's per-user settings, which every later test in
 * the suite would otherwise inherit.
 */
test('the stage, its border and the model read the same in both themes', async ({ page }) => {
  await openProject(page)
  const stage = await openInViewer(page, MODEL)

  // Dark is read first, and the order is the whole of what makes the waiting sound.
  //
  // The class jig toggles on `<html>` is what carries the theme, so each read waits for that
  // rather than for the media query — the two are a JavaScript hop apart. But an absence is only
  // worth waiting on if it starts out present: with the page already light, `toHaveCount(0)` is
  // satisfied by the very first poll and returns before the switch has been processed at all,
  // which is not a wait. Going dark first makes the light wait a real transition, so both reads
  // are pinned to a state the app has actually reached.
  //
  // It matters more here than it looks, because every quantity this test asserts is
  // theme-invariant by design: a read that raced its switch would come back with the *other*
  // theme's figures, and the comparison would pass. This is the one failure mode that cannot be
  // caught by asserting harder, only by waiting correctly.
  await page.emulateMedia({ colorScheme: 'dark' })
  await expect(page.locator('html.dark')).toHaveCount(1)
  const dark = { ...(await readPanelColours(stage)), frame: await readFrame(page, stage) }

  await page.emulateMedia({ colorScheme: 'light' })
  await expect(page.locator('html.dark')).toHaveCount(0)
  const light = { ...(await readPanelColours(stage)), frame: await readFrame(page, stage) }

  // Identical, which is the design: a WebGL material cannot follow a CSS theme, so the stage
  // does not move under it.
  expect(dark.stage).toEqual(light.stage)
  expect(dark.border).toEqual(light.border)
  expect(dark.frame.faceTones).toEqual(light.frame.faceTones)

  for (const theme of [light, dark]) {
    // The panel has an edge. Below 3:1 the border is decoration; at 1:1 it is the shipped bug.
    expect(contrast(theme.border, theme.stage)).toBeGreaterThan(3)
    const { lit, shadowed } = litAndShadowed(theme.frame)
    expect(contrast(lit, theme.stage)).toBeGreaterThan(7)
    expect(contrast(shadowed, theme.stage)).toBeGreaterThan(3)
  }
})

/**
 * The size gate hides the stage, and what matters is that it comes back.
 *
 * `.spm-viewport--collapsed` is `display: none`, so while the prompt is up the container has no
 * box, the ResizeObserver reports 0x0 and `resize` clamps the drawing buffer to 1x1. A renderer
 * left at 1x1 after the user presses through would draw a one-pixel model into a full-size
 * panel — and the unit suite cannot see any of this, because jsdom neither applies `display:
 * none` nor runs a ResizeObserver.
 */
/**
 * Reset put the model back, pressed the way a user presses it — straight after letting go.
 *
 * `enableDamping` keeps the view coasting for about a second after every drag, so "immediately
 * after a drag" is not an edge case, it is what pressing the button looks like. It used to leave
 * about half the drag in place permanently: `frame()` repositioned the camera, and the animation
 * loop then went on spending OrbitControls' surviving `_sphericalDelta` on top of the reset. The
 * fix drains the residue first; see `resetView`.
 *
 * The unit suite could not have found this and still cannot reach it convincingly. Its drag
 * helper settled the camera to make "the camera moved" deterministic, and settling is exactly
 * what drains the residue — so the only reset it could see was one with nothing left to coast.
 * There is now a mid-coast variant there too, but this is the one that presses a real button
 * after a real pointer drag and looks at pixels.
 */
test('reset puts the model back when it is pressed while the drag is still coasting', async ({
  page,
}) => {
  await openProject(page)
  const stage = await openInViewer(page, MODEL)
  const opening = await stage.screenshot()

  // The renderer is deterministic frame to frame, so anything above zero below is the camera.
  expect(await changedShare(page, opening, await stage.screenshot())).toBe(0)

  await dragAcross(page, stage)
  // No settle: the button is pressed with the coast still running, which is the whole point.
  await page.getByRole('button', { name: 'Reset view' }).click()

  // Long enough for any surviving residue to have been spent — damping is ~1 s, and a wrong
  // reset is permanent rather than slow, so this cannot pass by being read too early.
  await page.waitForTimeout(2_000)
  const afterReset = await changedShare(page, opening, await stage.screenshot())

  // Measured: 0.00000 with the drain, 0.05929 without it, against a 0.11907 drag. The threshold
  // is an order of magnitude below the defect and well above a deterministic zero.
  expect(afterReset).toBeLessThan(0.005)

  // And the drag really did move the view, so the assertion above is not passing on a no-op.
  await dragAcross(page, stage)
  await page.waitForTimeout(1_500)
  expect(await changedShare(page, opening, await stage.screenshot())).toBeGreaterThan(0.02)
})

test('the stage comes back at full size after the user presses through the size gate', async ({
  page,
}) => {
  await openProject(page)
  await page.getByRole('link', { name: `View in 3D ${OVERSIZED}` }).click()

  const prompt = page.getByRole('alert')
  await expect(prompt).toContainText('Opening a .obj file can take many times its own size')
  // Nothing has been fetched, and nothing is pretending to draw.
  await expect(page.getByRole('img', { name: CANVAS_LABEL })).toHaveCount(0)

  const canvas = page.locator('.spm-viewport canvas')
  const size = async (): Promise<[number, number]> =>
    canvas.evaluate(
      (element: HTMLCanvasElement) => [element.width, element.height] as [number, number],
    )
  // Polled: the observer delivers the collapse on the next frame, not synchronously.
  await expect.poll(size).toEqual([1, 1])

  await page.getByRole('button', { name: 'Load it anyway' }).click()

  const stage = page.getByRole('img', { name: CANVAS_LABEL })
  await expect(stage).toBeVisible()
  const [width, height] = await size()
  expect(width).toBeGreaterThan(600)
  expect(height).toBeGreaterThan(300)

  // And the model that arrived is drawn into it.
  const frame = await readFrame(page, stage)
  expect(frame.modelShare).toBeGreaterThan(0.05)
})

/**
 * Twenty trips in and out of the viewer, and twenty contexts given back.
 *
 * This is the only proof in the project that the disposal matrix `viewer.page.spec.ts` covers
 * actually frees anything. jsdom's renderer is a stand-in: the spec can assert `dispose()` and
 * `forceContextLoss()` were called, in that order, on teardown — it cannot show that a context
 * stopped existing, because there was never a context.
 *
 * Chrome keeps sixteen WebGL contexts alive per page and, past that, drops the *oldest* rather
 * than refusing the newest. So a viewer that leaks one per navigation does not fail on the
 * seventeenth trip: it silently kills the first ones, and the user finds out later, on a page
 * they had left open. Twenty is chosen to be over that line, and it is: with the release removed
 * from `ngOnDestroy` this run comes back "created 20, released 4" — sixteen still live, four
 * taken back by Chrome — with four "Too many active WebGL contexts" warnings in the console.
 *
 * Both halves are asserted because each one alone is weak. The counters prove every context was
 * explicitly released (`forceContextLoss` is what dispatches `webglcontextlost`); the console
 * proves the browser never had to reclaim one behind the app's back.
 *
 * Navigation is by link rather than `page.goto`, and that is load-bearing: a reload would re-run
 * the init script and reset the counters, and would also destroy the contexts for free, which is
 * the opposite of what is being tested.
 */
test('twenty trips through the viewer do not accumulate WebGL contexts', async ({ page }) => {
  const TRIPS = 20

  await page.addInitScript(() => {
    const tally = { created: 0, released: 0 }
    ;(window as unknown as { __spmWebgl: typeof tally }).__spmWebgl = tally
    const counted = new WeakSet<HTMLCanvasElement>()
    const original = HTMLCanvasElement.prototype.getContext
    // Wrapped rather than hooked into the app: the app must not know it is being watched, or
    // this measures the instrumentation. `getContext` returns the same context for repeat
    // calls on one canvas, hence the WeakSet.
    HTMLCanvasElement.prototype.getContext = function (
      this: HTMLCanvasElement,
      ...args: Parameters<HTMLCanvasElement['getContext']>
    ) {
      const context = original.apply(this, args)
      const kind = String(args[0])
      if (context && (kind === 'webgl' || kind === 'webgl2') && !counted.has(this)) {
        counted.add(this)
        tally.created++
        this.addEventListener('webglcontextlost', () => void tally.released++)
      }
      return context
    } as HTMLCanvasElement['getContext']
  })

  const evicted: string[] = []
  page.on('console', (message) => {
    if (/too many active webgl contexts/i.test(message.text())) evicted.push(message.text())
  })

  await openProject(page)
  for (let trip = 0; trip < TRIPS; trip++) {
    await openInViewer(page, MODEL)
    await page.getByRole('link', { name: BACK }).click()
    await expect(page.getByRole('heading', { name: PROJECT, level: 1 })).toBeVisible()
  }

  // Released as well as created, and the last one too: leaving the viewer is what releases it,
  // and the loop ends outside the viewer.
  await expect
    .poll(() => page.evaluate(() => (window as unknown as { __spmWebgl: unknown }).__spmWebgl))
    .toEqual({ created: TRIPS, released: TRIPS })

  expect(evicted).toEqual([])
})
