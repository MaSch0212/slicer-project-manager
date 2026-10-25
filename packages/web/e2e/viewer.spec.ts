import { expect, test, type Locator, type Page } from '@playwright/test'
import { binaryStl, cube, obj, paddedObj, stepStub, threeMf, cylinder } from './fixtures'
import { seedLibrary, type SeededProject, type SeedProject } from './seed'
import { asAdmin, expectHeading, open, useServer } from './support'

/**
 * The viewer, in a real browser: pixels reach the screen, the three formats draw, the stage reads
 * in both themes, the size gate comes back, a model opens where its thumbnail was taken from, and
 * leaving the viewer gives its WebGL context back. Ported from the Angular app's viewer.spec.ts.
 *
 * jsdom has no WebGL, so no unit test can make the first assertion. Playwright's Chromium has none
 * in hardware either, but it has a real WebGL2 (ANGLE over SwiftShader), so what it composites is
 * what a browser would. Hence pixels, not the presence of a `<canvas>`: an element with a context
 * that never drew, a camera pointed away from the model and a model that failed to parse all give
 * the same DOM.
 */

const MODELS = 'Viewer Models'
const OVERSIZED = 'Viewer Oversized'
const ODDS = 'Viewer Odd Files'

/**
 * Big enough to trip the viewer's size gate, and no bigger: the gate refuses a `.obj` past
 * `PEAK_BUDGET_BYTES / peakCost` = 256,000,000 / 28.93 = 8,849,637 bytes (`viewer/model-kind.ts`).
 * The padding is comment lines the loader skips, so a fixture 2 MB clear of the line costs the same
 * parse as one 0.1 MB clear of it. Not imported, so this file does not pull three.js in: if `.obj`'s
 * cost is re-measured below about 23.3 the line moves past this fixture and the gate stops
 * appearing, which shows up as this test failing on a missing prompt.
 */
const OVERSIZED_BYTES = 11_000_000

const PLAN: SeedProject[] = [
  {
    name: MODELS,
    files: [
      { name: 'cube.stl', bytes: binaryStl(cube(20)) },
      { name: 'cube.obj', bytes: obj(cube(20)) },
      { name: 'cube.3mf', bytes: threeMf(cube(20)) },
    ],
  },
  { name: OVERSIZED, files: [{ name: 'big.obj', bytes: paddedObj(cube(20), OVERSIZED_BYTES) }] },
  {
    name: ODDS,
    files: [
      { name: 'hinge.step', bytes: stepStub() },
      { name: 'notes.txt', bytes: new TextEncoder().encode('not a model\n') },
      { name: 'broken.stl', bytes: new TextEncoder().encode('solid broken\nendsolid broken\n') },
      { name: 'pin.stl', bytes: binaryStl(cylinder(3, 12)) },
    ],
  },
]

const state = useServer((server) => seedLibrary(server, PLAN))
const project = (name: string): SeededProject => state.seeded[name]!

test.beforeEach(async ({ page }) => {
  await state.server.request('PUT', '/api/account/settings', { theme: 'system' })
  await asAdmin(page, state.server)
})

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
  return Number(((light + 0.05) / (dark + 0.05)).toFixed(2))
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
   * least a twentieth of it: multisampling blends the two faces along every internal edge, so a
   * cube comes back as three broad tones plus hairline ones, and only the broad ones are a fact
   * about the lighting.
   */
  faceTones: Rgb[]
}

/**
 * What is actually on the stage, read back as pixels. A screenshot rather than
 * `canvas.toDataURL()`: the renderer is built without `preserveDrawingBuffer`, so the drawing
 * buffer's contents are not guaranteed outside the animation loop, and the canvas clears
 * transparent onto the stage's CSS background, so only a composite has both the model and the
 * stage it has to be legible against.
 *
 * Model pixels are told from stage pixels by hue: the model colour is warm (red well above blue at
 * every shade the lighting makes) while the stage is neutral grey. Only interior pixels count (a
 * pixel and its four neighbours all warm), so the antialiased outline does not supply arbitrarily
 * dark "model" pixels.
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
 * Share of pixels that differ between two shots of the stage: the camera sitting somewhere it
 * should not. A rotation leaves the model's tones, area and the stage colour unchanged, so every
 * summary in `Frame` is blind to it; a whole-frame comparison is not. The renderer is
 * bit-deterministic here (idle against idle is 0), which is what makes a threshold near zero
 * meaningful.
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
 * The stage's own colour, as the browser resolves it. Painted into a 1x1 canvas and read back
 * rather than parsed out of the string: the theme tokens resolve to `oklch(...)` or `color(...)`,
 * and reading the digits out of those reads the wrong colour. It is also the like-for-like
 * comparison: the screenshot pixels it is measured against went through the same conversion.
 */
async function readStageColour(stage: Locator): Promise<Rgb> {
  // The element with the background is the stage frame around the drawing host.
  return stage.locator('xpath=..').evaluate((element: HTMLElement) => {
    const swatch = document.createElement('canvas')
    swatch.width = 1
    swatch.height = 1
    const context = swatch.getContext('2d')
    if (!context) throw new Error('no 2d context to resolve the theme colours with')
    context.fillStyle = getComputedStyle(element).backgroundColor
    context.fillRect(0, 0, 1, 1)
    const pixel = context.getImageData(0, 0, 1, 1).data
    return [pixel[0]!, pixel[1]!, pixel[2]!] as [number, number, number]
  })
}

const viewerUrl = (name: string, file: string) =>
  `/projects/${project(name).id}/view/${project(name).fileIds[file]}`

/** Opens one file in the viewer and waits for a model to be on the stage. */
async function openInViewer(page: Page, name: string, file: string): Promise<Locator> {
  await open(page, state.server, viewerUrl(name, file))
  const stage = page.getByRole('img', { name: CANVAS_LABEL })
  // role="img" is set only in the 'ready' state, so this is "a model is on screen" and not "the
  // page has rendered": every failure arm drops the attribute again.
  await expect(stage).toBeVisible({ timeout: 30_000 })
  return stage
}

test('the viewer draws the model rather than an empty stage', async ({ page }) => {
  const stage = await openInViewer(page, MODELS, 'cube.stl')
  await expectHeading(page, 'cube.stl')

  // The drawing buffer is the panel, not the 1x1 the resize clamp falls back to when the container
  // has no box.
  const buffer = await stage.locator('canvas').evaluate((canvas: HTMLCanvasElement) => ({
    width: canvas.width,
    height: canvas.height,
  }))
  expect(buffer.width).toBeGreaterThan(600)
  expect(buffer.height).toBeGreaterThan(300)

  const frame = await readFrame(page, stage)
  const stageColour = await readStageColour(stage)
  // Most of the panel is the stage, and the stage is the colour the stylesheet says it is: the
  // canvas really clears transparent onto the CSS background rather than painting one of its own.
  expect(frame.background).toEqual(stageColour)
  expect(frame.backgroundShare).toBeGreaterThan(0.4)
  // And a substantial part of it is not. This is the assertion that fails on a blank canvas.
  expect(frame.modelShare).toBeGreaterThan(0.05)

  // A cube shows the isometric camera exactly three faces, and a world-fixed key light puts each
  // on its own flat tone: the model is lit and solid rather than a flat silhouette.
  expect(frame.faceTones).toHaveLength(3)
  const { lit, shadowed } = litAndShadowed(frame)
  expect(contrast(lit, shadowed)).toBeGreaterThan(1.3)
})

for (const [file, format] of [
  ['cube.stl', 'STL'],
  ['cube.obj', 'OBJ'],
  ['cube.3mf', '3MF'],
] as const) {
  test(`${format} models are fetched, parsed and drawn`, async ({ page }) => {
    const stage = await openInViewer(page, MODELS, file)
    const frame = await readFrame(page, stage)
    expect(frame.modelShare).toBeGreaterThan(0.05)
    expect(frame.faceTones).toHaveLength(3)
    // The page offers the file for download and the way back, with the file's own name as title.
    await expectHeading(page, file)
    await expect(page.getByRole('link', { name: 'Download' })).toHaveAttribute(
      'href',
      new RegExp(`^/api/files/${project(MODELS).fileIds[file]}/raw$`),
    )
    await expect(page.getByRole('link', { name: BACK })).toBeVisible()
  })
}

// The stage is pinned to a dark ground in both themes (`--color-stage`): a WebGL material cannot
// follow a CSS theme, and the model's warm tones need a dark ground to read against. On the light
// surface the lit face measured 1.4:1 against the stage and the shadowed one 2.5:1; on the dark one
// 10.4:1 and 5.9:1, which is what these thresholds hold it to (WCAG asks 3:1 for non-text).
//
// Dark is read first, and the order is what makes the waiting sound: with the page already light, a
// light wait is satisfied by its first poll and returns before the switch has been processed at
// all; going dark first makes each wait a real transition, so both reads are pinned to a state the
// app has actually reached. It matters more here than it looks, because every quantity asserted is
// theme-invariant by design: a read that raced its switch would come back with the other theme's
// figures and the comparison would pass.
test('the stage and the model read the same in both themes, and the model is legible on it', async ({
  page,
}) => {
  await page.emulateMedia({ colorScheme: 'dark' })
  const stage = await openInViewer(page, MODELS, 'cube.stl')
  await expect(page.locator('body')).toHaveCSS('background-color', 'rgb(12, 13, 15)')
  const dark = { stage: await readStageColour(stage), frame: await readFrame(page, stage) }

  await page.emulateMedia({ colorScheme: 'light' })
  await expect(page.locator('body')).toHaveCSS('background-color', 'rgb(247, 247, 248)')
  const light = { stage: await readStageColour(stage), frame: await readFrame(page, stage) }

  expect(light.stage).toEqual(dark.stage)
  expect(light.frame.faceTones).toEqual(dark.frame.faceTones)
  for (const theme of [light, dark]) {
    expect(theme.frame.background).toEqual(theme.stage)
    const { lit, shadowed } = litAndShadowed(theme.frame)
    expect(contrast(lit, theme.stage), 'the lit face against the stage').toBeGreaterThan(7)
    expect(contrast(shadowed, theme.stage), 'the shadowed face against the stage').toBeGreaterThan(
      3,
    )
  }
})

test('the size gate asks first, and the stage comes back at full size after pressing through', async ({
  page,
}) => {
  const fetched: string[] = []
  page.on('request', (request) => {
    if (request.url().endsWith('/raw')) fetched.push(request.url())
  })
  await open(page, state.server, viewerUrl(OVERSIZED, 'big.obj'))

  const prompt = page.getByRole('status').filter({ hasText: 'Opening a .obj file' })
  await expect(prompt).toContainText('can take many times its own size')
  // Nothing has been fetched, and nothing is pretending to draw.
  await expect(page.getByRole('img', { name: CANVAS_LABEL })).toHaveCount(0)
  expect(fetched).toEqual([])

  // While the prompt is up there is no renderer at all (the stage is hidden and nothing has been
  // fetched), so there is no canvas to be left at the wrong size. Once pressed through, the stage
  // that appears must be the full-size panel and not the 1x1 a renderer created inside a hidden
  // box would clamp to; jsdom neither applies display: none nor runs a ResizeObserver, so only a
  // browser can see it.
  const canvas = page.locator('canvas')
  const size = async (): Promise<[number, number]> =>
    canvas.evaluate((element: HTMLCanvasElement) => [element.width, element.height])
  await expect(canvas).toHaveCount(0)

  await page.getByRole('button', { name: 'Load it anyway' }).click()
  const stage = page.getByRole('img', { name: CANVAS_LABEL })
  await expect(stage).toBeVisible({ timeout: 30_000 })
  const [width, height] = await size()
  expect(width).toBeGreaterThan(600)
  expect(height).toBeGreaterThan(300)
  // And the model that arrived is drawn into it.
  expect((await readFrame(page, stage)).modelShare).toBeGreaterThan(0.05)
})

/**
 * A model opens in the thumbnail's basis even if the stage was being spun while it downloaded.
 * The stage is up and orbitable while the bytes arrive, so a user can spin the empty stage on a
 * first load, and the damping from that drag is still coasting when the model is framed: it used to
 * land on top of the fit and leave the model a few degrees off the basis its thumbnail was made from.
 *
 * The response is held open rather than delayed by a fixed time, for two reasons: a localhost
 * fetch of a 684-byte cube is far quicker than a drag, so without holding it there is no window to
 * drag inside at all; and damping decays about 5 % a frame, so a fixed delay lets most of the
 * residue evaporate before the model lands. Releasing the bytes the instant the drag ends puts the
 * residue at its maximum, which is both the honest worst case and the reproducible one.
 */
test('a model opens in the opening view even if the stage was dragged while it loaded', async ({
  page,
}) => {
  // The reference: what this file's opening view looks like when nothing interferes.
  const clean = await openInViewer(page, MODELS, 'cube.stl')
  const opening = await clean.screenshot()

  let release = (): void => {}
  const held = new Promise<void>((resolve) => {
    release = resolve
  })
  await page.route('**/api/files/*/raw', async (route) => {
    await held
    await route.continue()
  })
  await page.getByRole('link', { name: BACK }).click()
  await expectHeading(page, MODELS)
  await page.getByRole('link', { name: 'View in 3D: cube.stl' }).click()

  // The stage is up and live before the model is: that is the window this test exists for.
  await expect(page.locator('canvas')).toBeVisible()
  await expect(page.getByRole('img', { name: CANVAS_LABEL })).toHaveCount(0)
  await dragAcross(page, page.locator('canvas'))
  release()

  const stage = page.getByRole('img', { name: CANVAS_LABEL })
  await expect(stage).toBeVisible()
  // Any surviving residue is spent on top of the fit within the damping time and is permanent
  // after that, so the view either converges on the opening one or never does.
  await expect
    .poll(async () => changedShare(page, opening, await stage.screenshot()), { timeout: 15_000 })
    .toBeLessThan(0.005)
})

// Reset put the model back, pressed the way a user presses it: straight after letting go. The view
// keeps coasting for about a second after every drag, so "immediately after a drag" is what
// pressing the button looks like. It used to leave about half the drag in place permanently,
// because the loop went on spending the surviving rotation on top of the reset.
test('reset puts the model back when it is pressed while the drag is still coasting', async ({
  page,
}) => {
  const stage = await openInViewer(page, MODELS, 'cube.stl')
  const opening = await stage.screenshot()
  // The renderer is deterministic frame to frame, so anything above zero below is the camera.
  expect(await changedShare(page, opening, await stage.screenshot())).toBe(0)

  await dragAcross(page, stage)
  // The drag really moved the view, so the assertion below is not passing on a no-op.
  await expect
    .poll(async () => changedShare(page, opening, await stage.screenshot()))
    .toBeGreaterThan(0.02)

  // No settling: the button is pressed with the coast still running, which is the whole point.
  await page.getByRole('button', { name: 'Reset view' }).click()
  await expect
    .poll(async () => changedShare(page, opening, await stage.screenshot()), { timeout: 15_000 })
    .toBeLessThan(0.005)
})

test('the keyboard orbits the focused stage and 0 puts the view back', async ({ page }) => {
  const stage = await openInViewer(page, MODELS, 'cube.stl')
  const opening = await stage.screenshot()
  await stage.focus()
  await page.keyboard.press('ArrowRight')
  await page.keyboard.press('ArrowRight')
  await expect
    .poll(async () => changedShare(page, opening, await stage.screenshot()))
    .toBeGreaterThan(0.01)
  await page.keyboard.press('0')
  await expect
    .poll(async () => changedShare(page, opening, await stage.screenshot()), { timeout: 15_000 })
    .toBeLessThan(0.005)
})

// A STEP file is a model the library lists and keeps and the viewer has no kernel for: it says so
// instead of fetching bytes it could not use, and so for the other files it cannot draw.
test('files the viewer cannot draw say why, and nothing is fetched or rendered for them', async ({
  page,
}) => {
  const fetched: string[] = []
  page.on('request', (request) => {
    if (request.url().endsWith('/raw')) fetched.push(request.url())
  })
  const cases: [string, RegExp][] = [
    ['hinge.step', /There is no preview for STEP files/],
    ['notes.txt', /cannot open a \.txt file/],
  ]
  for (const [file, message] of cases) {
    await open(page, state.server, viewerUrl(ODDS, file))
    await expectHeading(page, file)
    await expect(page.getByRole('status').filter({ hasText: message })).toBeVisible()
    await expect(page.getByRole('img', { name: CANVAS_LABEL })).toHaveCount(0)
    await expect(page.getByRole('button', { name: 'Reset view' })).toHaveCount(0)
    // The page still offers the way back and the file itself.
    await expect(page.getByRole('link', { name: BACK })).toBeVisible()
    await expect(page.getByRole('link', { name: 'Download' })).toBeVisible()
  }
  expect(fetched).toEqual([])
})

test('a file that cannot be read as a model says so, and a missing file says it is gone', async ({
  page,
}) => {
  await open(page, state.server, viewerUrl(ODDS, 'broken.stl'))
  await expect(page.getByRole('alert')).toContainText(/no triangles|could not be read/)
  await expect(page.getByRole('img', { name: CANVAS_LABEL })).toHaveCount(0)

  await open(page, state.server, `/projects/${project(ODDS).id}/view/00000000-no-such-file`)
  await expect(page.getByRole('alert')).toContainText('This file is not part of this project')
})

test('the viewer is reached from a model card and returns to its project', async ({ page }) => {
  await open(page, state.server, `/projects/${project(MODELS).id}`)
  await expectHeading(page, MODELS)
  await page.getByRole('link', { name: 'View in 3D: cube.obj' }).click()
  await expect(page.getByRole('img', { name: CANVAS_LABEL })).toBeVisible({ timeout: 30_000 })
  await expectHeading(page, 'cube.obj')
  await page.getByRole('link', { name: BACK }).click()
  await expectHeading(page, MODELS)
})

/**
 * Twenty trips in and out of the viewer, and twenty contexts given back.
 *
 * This is the only proof that the disposal the viewer does actually frees anything: jsdom's
 * renderer is a stand-in, so a unit test can assert `forceContextLoss()` was called but not that a
 * context stopped existing. Chrome keeps sixteen WebGL contexts alive per page and, past that,
 * drops the oldest rather than refusing the newest, so a viewer that leaks one per navigation does
 * not fail on the seventeenth trip: it silently kills the first ones, and the user finds out later.
 * Twenty is over that line.
 *
 * Both halves are asserted because each alone is weak: the counters prove every context was
 * explicitly released, the console proves the browser never had to reclaim one behind the app's
 * back. Navigation is by link rather than `page.goto`, which is load-bearing: a reload would reset
 * the counters and destroy the contexts for free, the opposite of what is being tested.
 */
test('twenty trips through the viewer do not accumulate WebGL contexts', async ({ page }) => {
  test.setTimeout(180_000)
  const TRIPS = 20

  await page.addInitScript(() => {
    const tally = { created: 0, released: 0 }
    ;(window as unknown as { __spmWebgl: typeof tally }).__spmWebgl = tally
    const counted = new WeakSet<HTMLCanvasElement>()
    const original = HTMLCanvasElement.prototype.getContext
    // Wrapped rather than hooked into the app: the app must not know it is being watched.
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

  await open(page, state.server, `/projects/${project(MODELS).id}`)
  await expectHeading(page, MODELS)
  for (let trip = 0; trip < TRIPS; trip++) {
    await page.getByRole('link', { name: 'View in 3D: cube.stl' }).click()
    await expect(page.getByRole('img', { name: CANVAS_LABEL })).toBeVisible({ timeout: 30_000 })
    await page.getByRole('link', { name: BACK }).click()
    await expectHeading(page, MODELS)
  }

  // Released as well as created, and the last one too: leaving the viewer is what releases it, and
  // the loop ends outside the viewer.
  await expect
    .poll(() => page.evaluate(() => (window as unknown as { __spmWebgl: unknown }).__spmWebgl))
    .toEqual({ created: TRIPS, released: TRIPS })
  expect(evicted).toEqual([])
})
