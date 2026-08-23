import { AppError } from '@spm/contract/errors.ts'
import type { Mesh } from './mesh/mesh.ts'

/** Spec §7.2: preview tiles are square 256px thumbnails in the projects grid. */
export const DEFAULT_SIZE = 256

/**
 * An upper bound on `size`, not a product requirement.
 *
 * The frame buffers are the only allocation that scales with it (`size² * 3` bytes of RGB
 * plus `size² * 4` bytes of depth), so 4096 caps a single render at ~118 MB. Anything larger
 * is a caller mistake worth failing loudly on rather than an OOM in the preview worker.
 */
const MAX_SIZE = 4096

/** Fraction of the frame left blank on each side, so tiles do not touch their grid cell. */
const MARGIN_FRACTION = 0.06

// --- Camera ------------------------------------------------------------------------------
//
// A fixed three-quarter view: world +Z is up, the camera sits at the isometric elevation
// (atan(1/√2) ≈ 35.26° above the ground plane) and 32° round from the model's front. Z-up
// matches how slicers and printers treat a model — the bed is the XY plane — so the three
// visible faces of a box are its top, its front and its right.
//
// 32° rather than a perfectly diagonal 45°. Exact isometric looks down (1,-1,1), and any face
// whose normal is perpendicular to that — (1,1,0), (0,1,1), (1,0,-1), i.e. every 45° wall or
// chamfer — projects to a line and vanishes; a box rotated 45° to fit the plate is a routine
// orientation, and under an exact isometric it collapses into a flat two-tone rectangle. Of
// 45°, 57° and 32°, the user picked 32° from renders: it weights the view towards the front
// face, which is the one models usually carry their detail on.
//
// Be clear about what that does and does not buy, because it is a trade, not a fix. Every
// fixed camera flattens *some* one-parameter family of orientations, and moving the camera
// only moves the family. At this azimuth the flattened family is a box rotated **32°** about
// Z, not 45°: measured as the third face's share of the visible area, 45° is healthy at 11.8%
// and 60° at 22.8%, but 30° gives 2.0%, 31° gives 1.0% and 32° gives 0.0% — a full collapse,
// with anything inside roughly 32°±0.6° reading as flat. 30° is not an obscure angle. This is
// a known and accepted cost of the chosen view, recorded here so nobody rediscovers it as a
// bug.
//
// The other cost is that an axis-aligned cube is no longer a symmetric hexagon — it reads as a
// box photographed from slightly off-centre, which is if anything the more natural picture.
//
// Retuning: edit the two angle constants, run `pnpm test:core:node`, and paste the nine
// literals the camera test prints. Setting the azimuth back to -45 reproduces the sqrt-derived
// isometric basis to within four ulps (the worst is UP_Y; most components are exact) — close
// but not bit-for-bit, because the components come from Math.cos/Math.sin of the angle here
// where they used to come from Math.sqrt.
//
// Two warnings for whoever retunes this, both learned the hard way.
//
// First, pasting the literals is necessary but not always sufficient. Two tests are anchored to
// *this* camera and fail after an otherwise correct retune at roughly half the angles tried:
//
//   - `the depth buffer, not triangle order, decides which surface is visible` names the pixel
//     (42,42), which has to sit inside both triangles' outlines. Measured: fine at -58 and -75,
//     red at -45, -33 and -20. As written today it would be red at the -33 this camera used to
//     be, which is the same trap in mirror image.
//   - `geometry too thin to reach a sample point` depends on where the sample grid falls
//     across a sliver. Measured: red at -59, a single degree away.
//
// Re-anchor those two from the renders; do not weaken them. Everything else survived a sweep of
// -75, -59, -45, -33 and -20, including the light-sign test. One apparent failure is not one at
// all: `a box rotated 45° about Z still reads as a box` is red at azimuth -45, because that
// camera genuinely does flatten a 45° box. That is the test doing its job.
//
// Second, the light below is fixed in *world* space, and the palette's tone separation was
// tuned against this specific azimuth, so changing AZIMUTH_DEGREES shifts the relationships
// between the face tones as well as the geometry — and the tests will still pass. Look at the
// renders. This is exactly the trap 57° walked into: a box's darkest face became its largest,
// and no assertion noticed.

/** Camera azimuth in degrees, measured from +X. -58 is 32° round from the model's front. */
export const AZIMUTH_DEGREES = -58

/** Camera elevation in degrees above the bed. atan(1/√2), the isometric elevation. */
export const ELEVATION_DEGREES = 35.26438968275465

// The basis, written out as literals so that no transcendental function runs in the render
// path at all.
//
// IEEE 754 pins Math.sqrt to a correctly rounded result on every engine, but says nothing
// about Math.cos and Math.sin — those are implementation-defined to the last bit. Deriving
// these at load time would make "the same mesh renders the same bytes on Node and on Deno"
// true by coincidence rather than by construction. Every value is the shortest decimal that
// round-trips to exactly the double its expression produces, so this is a substitution, not an
// approximation. The camera test regenerates and checks all nine, and prints replacements.
//
// RIGHT maps to +X on screen, UP to +Y on screen (flipped when writing rows, which run
// downwards), and VIEW points from the model towards the camera, so a larger dot product is
// nearer. RIGHT × UP = VIEW: right-handed.
const RIGHT_X = 0.8480480961564261
const RIGHT_Y = 0.5299192642332049
const RIGHT_Z = 0

const UP_X = -0.3059490298538092
const UP_Y = 0.4896207966016621
const UP_Z = 0.8164965809277261

const VIEW_X = 0.4326772674141481
const VIEW_Y = -0.6924283709739895
const VIEW_Z = 0.5773502691896256

/**
 * The basis, exposed so a test can check the literals against the two angles above.
 *
 * Worth exporting because nothing else can catch a mistyped digit. A wrong digit in the eighth
 * place moves a 256px render by two hundred-thousandths of a pixel — no rendering test will
 * ever see it, and it would sit there being subtly not the documented camera. Built once at
 * module load; the render path reads the scalars, not this.
 */
export const CAMERA_BASIS = {
  right: [RIGHT_X, RIGHT_Y, RIGHT_Z],
  up: [UP_X, UP_Y, UP_Z],
  view: [VIEW_X, VIEW_Y, VIEW_Z],
} as const

// --- Light and palette -------------------------------------------------------------------
//
// One directional light, fixed in world space, coming from above and from the viewer's
// front-left. Its three components are deliberately well separated (0.30 / 0.55 / 0.78)
// because a tile is read at a glance: the three faces of an axis-aligned box must land on
// three obviously different tones, which is what tells the eye it is looking at a box and not
// a hexagon. Even components would collapse two of them into one.
//
// World space, not the camera frame, and that is the considered choice rather than the
// default. Printed models sit axis-aligned on a bed, so pinning the light to the world axes is
// what guarantees a box's top, front and right never converge. Carrying the light round with
// the camera was tried at this azimuth and rejected: it renders a box's front and right at
// (138,85,37) and (130,80,35), a difference nobody can see.
//
// Math.sqrt only, so these stay bit-identical on every engine (see the camera note above).
const LIGHT_LENGTH = Math.sqrt(0.3 * 0.3 + 0.55 * 0.55 + 0.78 * 0.78)
const LIGHT_X = -0.3 / LIGHT_LENGTH
const LIGHT_Y = -0.55 / LIGHT_LENGTH
const LIGHT_Z = 0.78 / LIGHT_LENGTH

/**
 * Floor on the shading term.
 *
 * Set high (0.28) so a face turned away from the light still separates from the background,
 * because at 256px in a grid the silhouette carries more information than the shading does.
 *
 * Be precise about what that separation is, though, because it is not lightness. The worst
 * shade, (63,39,17), is a WCAG contrast ratio of 1.13:1 against the background — effectively
 * none. What the eye picks up is *hue*: warm brown against cool slate. Measured over real
 * renders, 6% of silhouette-edge pixels on curved models fall below 1.3:1 and read only by
 * hue. (An axis-aligned cube never gets that dark: its darkest face is 1.89:1.) It works
 * against this dark background; it would need raising to ≈0.35 if the grid is ever lightened.
 */
const AMBIENT = 0.28

/** Filament amber; light enough at full shade to stay legible against the background. */
const BASE_R = 224
const BASE_G = 138
const BASE_B = 60

/** Flat dark slate. Opaque, since the PNG encoder writes truecolour with no alpha channel. */
const BACKGROUND_R = 31
const BACKGROUND_G = 35
const BACKGROUND_B = 42

// --- Per-triangle scratch ------------------------------------------------------------------
//
// `prepareTriangle` is the single definition of what one triangle is and whether it can put
// ink on the canvas. Both passes over the mesh call it with the same operands, so they cannot
// disagree about which triangles exist — the fit is never sized for geometry the fill then
// declines to draw.
//
// Its results land in module-level scratch rather than an object, because the alternative is
// one allocation per triangle and meshes run to ~600k of them. `renderMesh` is synchronous
// and never yields, so nothing can interleave between a call and its read.
let normalX = 0
let normalY = 0
let normalZ = 0
let normalLength = 0
let screenX0 = 0
let screenY0 = 0
let screenDepth0 = 0
let screenX1 = 0
let screenY1 = 0
let screenDepth1 = 0
let screenX2 = 0
let screenY2 = 0
let screenDepth2 = 0
let screenArea = 0

/**
 * Projects one triangle into the camera's screen plane and reports whether it is drawable.
 *
 * Drawable means two independent things, and both are exact-zero tests rather than
 * tolerances — "nearly degenerate" is a threshold nobody can defend:
 *
 * - a non-zero face normal. Zero means three collinear or coincident vertices: no area, no
 *   meaningful normal, and dividing by it would smear NaN across both buffers.
 * - a non-zero *screen* area. Zero means the triangle is exactly edge-on, its plane holding
 *   the view direction, so it projects to a line and covers nothing.
 *
 * The screen coordinates here are unscaled — the fit has not happened yet when pass one calls
 * this. Pixel coordinates are an affine map of them, so `screenArea` being zero is a property
 * of the camera and the triangle alone, which is exactly what lets both passes share it.
 *
 * Neither test can be made to change a rendered pixel, and both stay anyway:
 *
 * - the zero-normal test. Without it a degenerate triangle divides by zero and shades to NaN,
 *   but it can never paint: the three barycentric numerators sum identically to the screen
 *   area, so for a triangle collapsed onto a line, a sample genuinely off that line drives at
 *   least one of them strictly negative and the coverage test rejects it, while a sample that
 *   *is* on the line is the coincidence that makes the area exactly zero, which the other
 *   test then catches. (Empirically too: over three million exactly-degenerate triangles the
 *   largest projected area surviving rounding was 1.3e-11 px², and none covered a sample.)
 * - the zero-area test. It guards the division below, and it is why the fit and the fill
 *   cannot frame for different geometry. Under the previous exact-isometric camera it fired
 *   constantly — every 45° wall was exactly edge-on. Under this one it appears unreachable:
 *   400k triangles with two vertices on one line of sight, and every triangle on a ±2 integer
 *   grid, produced no exact zero — the closest approach on the integer grid is a relative
 *   area of 6.6e-6, re-measured at this camera.
 */
function prepareTriangle(positions: Float32Array, o: number): boolean {
  const ax = positions[o]!
  const ay = positions[o + 1]!
  const az = positions[o + 2]!
  const bx = positions[o + 3]!
  const by = positions[o + 4]!
  const bz = positions[o + 5]!
  const cx = positions[o + 6]!
  const cy = positions[o + 7]!
  const cz = positions[o + 8]!

  const e1x = bx - ax
  const e1y = by - ay
  const e1z = bz - az
  const e2x = cx - ax
  const e2y = cy - ay
  const e2z = cz - az
  normalX = e1y * e2z - e1z * e2y
  normalY = e1z * e2x - e1x * e2z
  normalZ = e1x * e2y - e1y * e2x
  normalLength = Math.sqrt(normalX * normalX + normalY * normalY + normalZ * normalZ)

  screenX0 = ax * RIGHT_X + ay * RIGHT_Y + az * RIGHT_Z
  screenY0 = ax * UP_X + ay * UP_Y + az * UP_Z
  screenDepth0 = ax * VIEW_X + ay * VIEW_Y + az * VIEW_Z
  screenX1 = bx * RIGHT_X + by * RIGHT_Y + bz * RIGHT_Z
  screenY1 = bx * UP_X + by * UP_Y + bz * UP_Z
  screenDepth1 = bx * VIEW_X + by * VIEW_Y + bz * VIEW_Z
  screenX2 = cx * RIGHT_X + cy * RIGHT_Y + cz * RIGHT_Z
  screenY2 = cx * UP_X + cy * UP_Y + cz * UP_Z
  screenDepth2 = cx * VIEW_X + cy * VIEW_Y + cz * VIEW_Z

  screenArea =
    (screenX1 - screenX0) * (screenY2 - screenY0) - (screenY1 - screenY0) * (screenX2 - screenX0)

  return normalLength !== 0 && screenArea !== 0
}

/**
 * Renders a mesh to a square RGB tile with a fixed three-quarter camera and flat shading.
 *
 * The result is `width * height * 3` bytes, row-major, three bytes per pixel — exactly what
 * `encodePng` consumes. This function does not encode; the caller does.
 *
 * Shading uses `abs(dot(normal, light))`, so winding order is irrelevant: STLs in the wild
 * are routinely inconsistent about it, and a signed dot would render half of such a model
 * black. There is no back-face culling for the same reason — the depth buffer already
 * resolves which surface is visible, and culling on an untrustworthy winding would punch
 * holes in the silhouette.
 *
 * Deterministic: pure arithmetic over the input in triangle order, no clock, no randomness,
 * no iteration over an unordered collection. The same mesh at a different absolute scale
 * renders the same silhouette, though normalising a bounding box computed from much larger
 * floats can leave a shade a single step apart.
 *
 * Never returns a blank tile. Anything that would produce one — no triangles, no drawable
 * triangle, geometry too thin to reach a single sample point — is an `AppError('Validation')`,
 * because the preview queue can record an error but cannot tell an empty image from a good
 * one.
 */
export function renderMesh(
  mesh: Mesh,
  opts?: { size?: number },
): { rgb: Uint8Array; width: number; height: number } {
  const size = opts?.size ?? DEFAULT_SIZE
  if (!Number.isInteger(size) || size < 1 || size > MAX_SIZE) {
    throw new AppError('Validation', `preview size must be an integer in 1..${MAX_SIZE}`, { size })
  }

  const { positions, triangleCount } = mesh
  // `tsc` rejects a Mesh without positions, so this only fires when the type was bypassed —
  // but the alternative is a bare TypeError out of `positions.length`, and every failure from
  // this module is supposed to be an AppError.
  if (!(positions instanceof Float32Array)) {
    throw new AppError('Validation', 'mesh positions must be a Float32Array')
  }
  if (!Number.isInteger(triangleCount) || triangleCount < 1) {
    throw new AppError('Validation', 'cannot render a mesh with no triangles', { triangleCount })
  }
  if (positions.length !== triangleCount * 9) {
    throw new AppError('Validation', 'mesh positions length does not match triangleCount * 9', {
      triangleCount,
      length: positions.length,
    })
  }

  // Pass one: the projected bounding box of every drawable triangle.
  //
  // Measured from vertices, not from the eight corners of the world-space box: projecting the
  // box only bounds the mesh from outside, so a sphere inside its own bounding box would
  // render noticeably short of the frame it was meant to fill.
  //
  // Restricted to drawable triangles because framing for something invisible is indefensible
  // — one stray degenerate or edge-on triangle reaching past the model would otherwise shrink
  // the whole render to a speck.
  //
  // Known boundary, deliberately not chased: *drawable* is not the same question as *paints*.
  // A triangle with a real normal and a real projected area still contributes nothing if it is
  // thinner than the sample grid, and it steers the fit anyway — a cube plus a 1e-4-thick
  // sliver reaching out to 13.5 collapses the silhouette from 192x224 to 16x18, with no error,
  // because the sliver is legitimately drawable and simply misses every sample point. Closing
  // it would mean fitting to coverage, which needs the scale the fit is trying to compute.
  // Across all 1,311 models in the reference library it happens zero times, and the blank-tile
  // guard still catches the case where *nothing* paints.
  let minX = Infinity
  let maxX = -Infinity
  let minY = Infinity
  let maxY = -Infinity
  let minDepth = Infinity
  let drawable = 0
  for (let t = 0; t < triangleCount; t++) {
    if (!prepareTriangle(positions, t * 9)) continue
    if (!Number.isFinite(normalLength)) {
      // Any NaN or infinite coordinate poisons at least two of the three cross-product terms,
      // so one check per triangle catches all of them — and it has to be a check, because
      // `if (sx < minX)` is false for NaN, so bad vertices would otherwise slip past the
      // bounds untouched and the render would come back blank rather than failing. The cross
      // product cannot overflow on its own: Float32 inputs square to at most 1.2e77.
      throw new AppError('Validation', 'mesh contains a non-finite vertex coordinate', {
        triangleIndex: t,
      })
    }
    drawable++
    if (screenX0 < minX) minX = screenX0
    if (screenX0 > maxX) maxX = screenX0
    if (screenX1 < minX) minX = screenX1
    if (screenX1 > maxX) maxX = screenX1
    if (screenX2 < minX) minX = screenX2
    if (screenX2 > maxX) maxX = screenX2
    if (screenY0 < minY) minY = screenY0
    if (screenY0 > maxY) maxY = screenY0
    if (screenY1 < minY) minY = screenY1
    if (screenY1 > maxY) maxY = screenY1
    if (screenY2 < minY) minY = screenY2
    if (screenY2 > maxY) maxY = screenY2
    if (screenDepth0 < minDepth) minDepth = screenDepth0
    if (screenDepth1 < minDepth) minDepth = screenDepth1
    if (screenDepth2 < minDepth) minDepth = screenDepth2
  }

  if (drawable === 0) {
    // Checked before the extent, so that a mesh of nothing but degenerate or edge-on
    // triangles reports what is actually wrong with it instead of tripping over the untouched
    // `Infinity` bounds below.
    throw new AppError('Validation', 'mesh has no triangle that covers any area in this view', {
      triangleCount,
    })
  }

  const extentX = maxX - minX
  const extentY = maxY - minY
  const extent = extentX > extentY ? extentX : extentY
  if (!(extent > 0)) {
    // A backstop, not a case anyone has produced: a drawable triangle has non-zero screen
    // area, which forces a non-zero extent on both axes. It stays because the alternative
    // failure is silent — dividing by zero here scales every vertex to NaN, every pixel loop
    // runs zero times, and the caller gets a plausible-looking blank tile instead of an error.
    throw new AppError('Validation', 'mesh has zero extent in the projected view', {
      triangleCount,
    })
  }

  // The larger projected axis fills the frame minus the margin; the shorter one is centred.
  const scale = (size * (1 - 2 * MARGIN_FRACTION)) / extent
  const centreX = (minX + maxX) / 2
  const centreY = (minY + maxY) / 2
  const half = size / 2

  const rgb = new Uint8Array(size * size * 3)
  for (let i = 0; i < rgb.length; i += 3) {
    rgb[i] = BACKGROUND_R
    rgb[i + 1] = BACKGROUND_G
    rgb[i + 2] = BACKGROUND_B
  }
  const depthBuffer = new Float32Array(size * size).fill(-Infinity)

  // Everything from here to the end of the loop is scalar locals: with meshes of ~600k
  // triangles, one allocation per triangle is 600k allocations per thumbnail.
  let painted = 0
  for (let t = 0; t < triangleCount; t++) {
    // Same call, same operands, same result as pass one — that identity is the whole reason
    // the fit and the fill cannot frame for different geometry.
    if (!prepareTriangle(positions, t * 9)) continue

    // Clamped because rounding can push a unit dot product a hair past 1, and a shade above
    // 1 would overflow a colour byte and wrap round to near-black.
    let lambert = (normalX * LIGHT_X + normalY * LIGHT_Y + normalZ * LIGHT_Z) / normalLength
    if (lambert < 0) lambert = -lambert
    if (lambert > 1) lambert = 1
    const shade = AMBIENT + (1 - AMBIENT) * lambert
    const faceR = Math.round(BASE_R * shade)
    const faceG = Math.round(BASE_G * shade)
    const faceB = Math.round(BASE_B * shade)

    const p0x = (screenX0 - centreX) * scale + half
    const p0y = half - (screenY0 - centreY) * scale
    const p0z = (screenDepth0 - minDepth) * scale
    const p1x = (screenX1 - centreX) * scale + half
    const p1y = half - (screenY1 - centreY) * scale
    const p1z = (screenDepth1 - minDepth) * scale
    const p2x = (screenX2 - centreX) * scale + half
    const p2y = half - (screenY2 - centreY) * scale
    const p2z = (screenDepth2 - minDepth) * scale

    // Pixel space is the screen plane scaled by `scale` and flipped in Y, so its signed area
    // is `-scale²` times the screen area. Derived rather than recomputed from the pixel
    // coordinates: recomputing could round to zero for a triangle pass one accepted, and then
    // the fill would silently skip geometry the frame was sized around. Signed, so dividing
    // the edge functions by it normalises both windings to positive barycentrics and the
    // coverage test needs no per-triangle orientation branch.
    const area = -screenArea * scale * scale
    const invArea = 1 / area

    let loX = p0x < p1x ? p0x : p1x
    if (p2x < loX) loX = p2x
    let hiX = p0x > p1x ? p0x : p1x
    if (p2x > hiX) hiX = p2x
    let loY = p0y < p1y ? p0y : p1y
    if (p2y < loY) loY = p2y
    let hiY = p0y > p1y ? p0y : p1y
    if (p2y > hiY) hiY = p2y

    // The fit already places every vertex inside the margin, so these clamps never fire in
    // practice. They stay because "never writes outside the frame" should hold even if a
    // future camera change makes the fit less than exact.
    let x0 = Math.floor(loX)
    let x1 = Math.ceil(hiX)
    let y0 = Math.floor(loY)
    let y1 = Math.ceil(hiY)
    if (x0 < 0) x0 = 0
    if (y0 < 0) y0 = 0
    if (x1 > size - 1) x1 = size - 1
    if (y1 > size - 1) y1 = size - 1

    for (let py = y0; py <= y1; py++) {
      const sampleY = py + 0.5
      const rowBase = py * size
      for (let px = x0; px <= x1; px++) {
        const sampleX = px + 0.5
        const w0 = ((p1x - sampleX) * (p2y - sampleY) - (p1y - sampleY) * (p2x - sampleX)) * invArea
        if (w0 < 0) continue
        const w1 = ((p2x - sampleX) * (p0y - sampleY) - (p2y - sampleY) * (p0x - sampleX)) * invArea
        if (w1 < 0) continue
        const w2 = ((p0x - sampleX) * (p1y - sampleY) - (p0y - sampleY) * (p1x - sampleX)) * invArea
        if (w2 < 0) continue

        // Orthographic projection is affine, so depth interpolates linearly in screen space
        // — no perspective-correct division needed.
        const depth = w0 * p0z + w1 * p1z + w2 * p2z
        const index = rowBase + px
        if (depth <= depthBuffer[index]!) continue
        depthBuffer[index] = depth
        const at = index * 3
        rgb[at] = faceR
        rgb[at + 1] = faceG
        rgb[at + 2] = faceB
        painted++
      }
    }
  }

  if (painted === 0) {
    // Counted at the point of writing, not at the point of trying: a triangle can be drawable
    // and still miss every sample point. Anything whose projection is thinner than about a
    // thousandth of its length does exactly that — after the fit stretches the long axis to
    // 226px, the short one lands under a pixel and falls between the sample grid. Returning
    // the resulting all-background image would report a broken thumbnail as a working one.
    //
    // Because it is point sampling, the outcome is not monotonic in `size`: a 1000:1 sheet
    // renders at size 1, throws at size 2 and renders again at size 4, purely on where the
    // sample points happen to fall. Only reachable at absurd sizes — at 256px the sample grid
    // is dense enough that the behaviour is stable.
    throw new AppError('Validation', 'mesh rendered no pixels: too thin to show at this size', {
      triangleCount,
      size,
    })
  }

  return { rgb, width: size, height: size }
}
