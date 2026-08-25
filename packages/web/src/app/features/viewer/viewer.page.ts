import {
  ChangeDetectionStrategy,
  Component,
  DOCUMENT,
  InjectionToken,
  Injector,
  PendingTasks,
  afterNextRender,
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
  AmbientLight,
  Box3,
  DirectionalLight,
  DoubleSide,
  MathUtils,
  Mesh,
  MeshLambertMaterial,
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
import { formatBytes } from '../../core/format-bytes'
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
 * "failed, 60 % done" — and every one of the outcomes has to be distinguishable.
 *
 * `extension` is the token the message names. It is the lowercased extension where there is
 * one and the whole file name where there is not, so no message can ever render a hole.
 */
export type LoadFailure = 'missing' | 'fetch' | 'parse' | 'empty'

export type ViewerState =
  | { status: 'loading'; progress: number | null }
  | { status: 'ready' }
  | { status: 'unsupported'; extension: string }
  // A `.3mf` the server classified as a slicer project rather than a mesh. Distinct from
  // 'unsupported' because the advice is different — 3MF *is* a format this viewer opens, and
  // "cannot open a .3mf file" would be a lie. Carries nothing: the message names no file.
  | { status: 'slicerProject' }
  // Nothing has been fetched. `sizeBytes` is carried rather than looked up again when the
  // message is built, so what the user is told is the size the decision was actually made on.
  | { status: 'oversized'; extension: string; sizeBytes: number }
  | { status: 'failed'; reason: LoadFailure; extension: string }

/** Shared so that re-entering the loading state does not notify: signals compare by identity. */
const LOADING: ViewerState = { status: 'loading', progress: null }

/**
 * How much of the frame is left empty around the model, per side.
 *
 * The same 6 % the thumbnail rasterizer leaves — `MARGIN_FRACTION` in
 * `packages/core/src/previews/raster.ts` — so the two pictures are framed to the same house
 * rule. Only the margin is shared, not the whole fit: the rasterizer scales the model's
 * *projected extent* to the frame, where `frame()` below fits its bounding sphere. The viewer
 * therefore opens smaller than the thumbnail, and deliberately so (see `frame`).
 */
const MARGIN_FRACTION = 0.06

/**
 * Where the camera sits, as a direction only — the distance along it is the fit.
 *
 * **Copied, not re-derived.** These are `VIEW_X`/`VIEW_Y`/`VIEW_Z` from
 * `packages/core/src/previews/raster.ts`, the basis the server's thumbnail rasterizer renders
 * with: azimuth -58° (32° round from the model's front) at the isometric elevation
 * `atan(1/√2)` ≈ 35.264°, in a **Z-up** world, because that is how a slicer and a printer
 * treat a model. Transcribed rather than imported because `packages/web` must not reach into
 * `packages/core`, and re-derived by nobody because that camera cost subsystem B1 several
 * rounds of argument and is pinned there by a test. If those literals ever move, move these.
 *
 * Task 1's `(2.5, 2, 3)` was a plausible three-quarter view and nothing more. It differs from
 * the thumbnail's by about 20° of azimuth *and* — far more visibly — assumes three.js's
 * default Y-up, so every printable model opened lying on its side. A 3DBenchy came up as an
 * unrecognisable bracket next to a thumbnail of a boat.
 */
const VIEW_DIRECTION = new Vector3(
  0.4326772674141481,
  -0.6924283709739895,
  0.5773502691896256,
).normalize()

/**
 * Which way is up, for the camera and therefore for the orbit pole.
 *
 * `+Z`, matching the rasterizer's world. With `VIEW_DIRECTION` above and three's `lookAt`
 * convention this reproduces the rasterizer's `CAMERA_BASIS` exactly — `right` comes out as
 * (0.8480, 0.5299, 0) and `up` as (-0.3059, 0.4896, 0.8165), which are its `RIGHT_*` and
 * `UP_*` literals to every digit they publish. So the opening frame is the thumbnail's frame,
 * not merely a similar one.
 *
 * It also fixes the orbit. `OrbitControls` reads `camera.up` **in its constructor** to build
 * the quaternion its whole spherical model is expressed in, so this has to be set before the
 * controls exist; with it, dragging sideways spins the model about the bed normal, which is
 * the gesture every slicer has trained the user on.
 */
const WORLD_UP = new Vector3(0, 0, 1)

/**
 * The direction the key light comes from, and how much light reaches a face that is edge-on
 * to it.
 *
 * Copied from `raster.ts` in the same spirit as the camera: `LIGHT_X/Y/Z` there is
 * `normalize(-0.3, -0.55, 0.78)`, above and to the viewer's front-left, and fixed in **world**
 * space rather than carried around with the camera. World-fixed is what keeps a box's top,
 * front and right on three separate tones — a light welded to the camera renders two of them
 * within a couple of levels of each other, which the rasterizer's own note records having
 * tried and rejected.
 *
 * The shading model is the rasterizer's — `AMBIENT + (1 - AMBIENT) * |N·L|` — and the
 * absolute-value part matters more here than it does there, because it is what stops a face
 * going black when the user orbits behind the model. It is reproduced with **two opposed
 * directional lights**, since exactly one of a pair can have a positive `N·L` and their sum
 * is `|N·L|`.
 *
 * ## Why the floor is 0.20 and not the rasterizer's 0.28
 *
 * This is the one number here that is *not* copied, and it is a trade with one knob and two
 * properties pulling against each other. The rasterizer multiplies its base colour by `shade`
 * in **sRGB** space; three.js multiplies in **linear** space and encodes on the way out, so the
 * same floor buys a much darker shadow here and a much flatter set of lit faces.
 *
 * Concretely, for the three faces of an axis-aligned box under this light —
 * `|N·L|` is 0.7797 on the top, 0.5497 on the front and 0.2999 on the right end — the WCAG
 * contrast between two lit faces is bounded above by their shade ratio, which depends only on
 * the floor. Measured on the built page against the same figures computed:
 *
 *     floor   top : front   front : right   darkest face vs stage
 *     0.28      1.22 : 1       1.32 : 1          4.32 : 1
 *     0.20      1.26 : 1       1.39 : 1          3.32 : 1
 *     0.00      1.42 : 1       1.75 : 1          1.00 : 1  (black)
 *
 * The thumbnail's own tile measures 1.39–1.45 : 1 on the same pair, which is roughly what a
 * *zero* floor gives here — so matching it exactly is not available while any floor remains,
 * and chasing it would trade a readable shadow side for a slightly crisper box. 0.20 takes most
 * of the separation that is on offer and leaves the darkest face at 3.32 : 1, clear of the 3 : 1
 * non-text threshold with room to spare. Below about 0.17 the floor stops clearing it.
 *
 * The other half of why the viewer can afford a lower floor than a 256 px tile: `raster.ts`
 * raised its own to 0.28 because at that size "the silhouette carries more information than the
 * shading does". In a panel this size the shading is what the user is reading.
 */
const KEY_LIGHT_DIRECTION = new Vector3(-0.3, -0.55, 0.78).normalize()
const AMBIENT_SHARE = 0.2

/**
 * The one colour every model is drawn in, whatever file it arrived in. See `materialise`.
 *
 * The thumbnail's hue family — its `BASE_R/G/B` is filament amber `#E08A3C` — carried up to a
 * light tint. Not the amber itself: against this panel's `rgb(21,25,30)` stage, full amber
 * reaches only 6.75:1 and at the 0.20 floor falls to **2.04:1**, under the 3:1 non-text
 * threshold, and no floor that leaves the shading intact lifts it clear. The light warm neutral
 * keeps the cast that ties the two pictures together and measures 13.22:1 lit against 3.32:1
 * shadowed — both measured off the canvas. Value contrast beat hue identity, and the
 * screenshots in the task report are the argument.
 */
const MODEL_COLOUR = 0xefdcc6

/**
 * How far one arrow-key press turns the model, and how far one `+`/`-` press zooms.
 *
 * 5° is a compromise measured against the two ends it has to serve: at 1° a quarter turn is
 * 90 presses, and at 15° a model with a feature on one face can be stepped straight past it.
 * 72 presses for a full revolution, and a face-on view of a box is four presses from the
 * opening three-quarter view.
 *
 * A constant angle, not a constant screen distance — unlike the drag gesture, which scales with
 * the panel because a drag is measured in pixels. A key press is not.
 */
const ORBIT_STEP = MathUtils.degToRad(5)

/**
 * The factor `dollyIn` multiplies the orbit radius by, so **below one is closer**.
 *
 * Below one despite the name, and that is not a guess: `_dollyIn` does `_scale *= dollyScale`
 * and `update()` does `radius = clamp(radius * _scale)` (`OrbitControls.js:1038` and `:776`),
 * so a factor above one pushes the camera away. The wheel path settles it — scrolling towards
 * the model calls `_dollyIn(pow(0.95, …))`, which is always less than one.
 *
 * Caught by driving the real page: `-` made the model bigger. 1/1.1 is about eight presses to
 * halve the distance, which matches a few notches of a wheel.
 */
const DOLLY_STEP = 1 / 1.1

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
 * One openable format: how to read it, and what reading it costs.
 *
 * The two sit in one record deliberately rather than in a parser table beside a cost table.
 * `peakCost` is the whole of what stands between the user and a tab that swaps or dies, and a
 * fourth loader added to one table and not the other would read as "no gate" — the quietest
 * possible way for this to stop working. `limitOf` refuses a cost that cannot bound anything,
 * so the same hole cannot be reopened by writing `0`.
 */
export type ModelFormat = {
  parse: ModelParser
  /**
   * Peak bytes held in the tab per byte of file, while a model of this format is opened.
   * Spent against `PEAK_BUDGET_BYTES`. Must be finite and greater than zero.
   */
  peakCost: number
}

/**
 * Exactly the three formats the server rasterizes, so the viewer opens precisely what the
 * project page shows a thumbnail for and nothing else pretends to be viewable.
 *
 * Keys are lowercase because every lookup goes through `extensionOf`, which folds case.
 *
 * ## Where the `peakCost` numbers come from
 *
 * A Node harness loads a real file from the reference library through the app's own three.js
 * 0.185 loader, one file per process, exactly as `fetchModel` → `parse` does, and reports
 * `process.resourceUsage().maxRSS` above an idle process that has already imported the loader.
 * Round 0 of this task reasoned the numbers out from the file formats instead and got all three
 * wrong in the direction that kills a tab — by 1.3x, 5.5x and 2.7x. Arithmetic misses what the
 * loaders actually allocate. If a cost here is ever changed, re-run the harness.
 *
 * **What is measured and where.** `.stl` and `.obj` are measured in that Node harness, end to
 * end. `.3mf` could not be: the DOM that `3MFLoader.js:215` builds is Blink's C++ allocation,
 * which Node cannot size and jsdom mis-sizes by an order of magnitude — so it shipped as a
 * measured 20.65x plus an *estimated* ~31x for the DOM. That estimate has since been settled
 * against the real engine, and the same probe re-measured all three formats as peak resident set
 * in Chromium, which is the quantity the Node harness reported. Read the `.3mf` row before
 * relying on any number in this table: two of the three are known to be off, and one of them is
 * off by a factor of 2.3 in the direction that kills a tab.
 *
 *     format  shipped   Chromium peak RSS, on the file that sets the cost
 *     .stl      6.75    3.21x binary / 4.56–5.26x ASCII — shipped figure is conservative, kept
 *     .obj      24.6    28.7–28.9x on UBO.obj — shipped figure is ~17 % under
 *     .3mf      51.9    117.75x on the file it came from — shipped figure is 2.3x under
 *
 * Neither correction is applied yet: both need `PEAK_BUDGET_BYTES` re-derived with them, and that
 * tolerance is shared by all three rows. Neither changes which library files are gated today.
 *
 * The multiplier is **not constant across file size**: every loader has a fixed cost of a few
 * megabytes, so a small file's ratio is much worse than a large one's while its absolute peak
 * is trivial. Each cost below is therefore the worst multiplier measured on a file at or above
 * a tenth of the line that cost implies — small enough to be near the decision, large enough
 * that fixed overheads are not the whole of it. The rule is checked the only way that matters:
 * **no file in the library that this gate lets through exceeds the budget**, verified per file
 * against the measured multiplier for its exact shape. The worst that gets through is a
 * 27.46 MB ASCII STL at 254 MB, 99 % of budget.
 */
const FORMATS: Readonly<Record<string, ModelFormat>> = {
  '.stl': {
    // No material here, and none in the other two arms either: `materialise` gives every mesh
    // the same one. The `Mesh` constructor's default `MeshBasicMaterial` is replaced before the
    // content is ever added to the scene.
    parse: (bytes) => new Mesh(new STLLoader().parse(bytes)),
    // Three different code paths hide behind one extension, and `sizeBytes` cannot tell them
    // apart — `isBinary` and the `COLOR=` sniff both need the first 84 bytes, which the gate
    // does not have and must not fetch. So the cost is the dearest of the three:
    //
    //   plain binary  2.47–2.48x   701 of 1,311 library STLs
    //   binary COLOR= 3.19–3.21x   549 of them — `STLLoader.js:186` allocates a *third*
    //                              Float32Array when the 80-byte header says COLOR=, which is
    //                              44 % of the library, not an edge case
    //   ASCII         5.66–9.25x    61 of them — `parseASCII` holds the ArrayBuffer, the
    //                              decoded string, and `vertices`/`normals` as plain number[]
    //                              at 8 bytes a float before copying to Float32BufferAttribute
    //
    // So the ASCII path sets the cost. Which *number* off that path is the question, and the
    // answer is not its worst ratio anywhere: **a multiplier only governs near the line**. Every
    // loader has a fixed cost of a few megabytes, which is the whole of why a small file's ratio
    // is bad — `CubeGears2-3.stl` measures 9.25x at 4.32 MB and peaks at 40 MB, a sixth of the
    // budget, and no constant taken from it describes a 35 MB file. The nine ASCII STLs at or
    // above 27 MB, which are the ones that can actually approach the budget, all measure 6.73x
    // or less. 6.75 covers them with a little over.
    //
    // Verified rather than argued: priced at its own measured peak, no file this line lets
    // through exceeds the budget, and the worst that gets through is `EiffelTower.STL` at
    // 35.30 MB → 218 MB, 85 %.
    //
    // Re-measured in Chromium as peak RSS, this is the one row that comes back *cheaper* than it
    // ships: `Waving_Groot_15.5cm.stl` (binary, COLOR=) 3.21x — identical to the Node harness to
    // the megabyte, which is what validates the Chromium method for the other two rows — and the
    // ASCII path 4.56x on `EiffelTower.STL`, 4.72x on `iron-man-base-2.stl`, 5.26x on
    // `Octopus_full_v5.5.stl`. V8 in Chromium handles `parseASCII`'s intermediate number[]s better
    // than Node's allocator did. 6.75 is kept rather than lowered: lowering a `peakCost` loosens
    // the gate, and being conservative on the format that is 97 % of the library is free.
    //
    // Pricing all three paths at the dearest still prompts on cheap files — of the 25 STLs
    // gated, 16 are plain binary and would have cost about 104 MB. That is the right way to be
    // wrong when the alternative is a 46 MB ASCII STL taking 284 MB silently, but it is a real
    // cost, and it is what the user-facing message has to be honest about: it must not claim
    // this particular file is expensive, only that the viewer cannot tell.
    peakCost: 6.75,
  },
  '.obj': {
    // OBJ has no binary form, so the whole file is decoded to a JS string before the loader sees
    // it, and a large OBJ is large precisely because it is text.
    parse: (bytes) => new OBJLoader().parse(new TextDecoder().decode(bytes)),
    // By far the dearest per byte after 3MF, and round 0 priced it at 4.5 by counting only the
    // copies that are easy to see. `OBJLoader.parse` also does `text.replace(/\r\n/g, '\n')`
    // (a second full-size string while the first is live), `text.split('\n')` (millions of
    // slices plus their backing array, each pinning the source string for the whole parse), and
    // `state.colors.push(undefined, undefined, undefined)` per vertex whether the file has
    // colours or not.
    //
    // Measured: 13.19x on `Baby_Yoda.obj` (137.79 MB → 1,817 MB — it needs more V8 old space by
    // itself than a phone has), 16.91x at 5.53 MB, 24.61x at 3.83 MB. 24.61 is the worst at or
    // above a tenth of the line it implies. The library's other eleven OBJs are all under
    // 5.6 MB and peak at 93 MB or less, so this costs no extra prompt at all.
    //
    // **Re-measured in Chromium and found ~17 % low.** Peak RSS on the same two files that are at
    // or above a tenth of the line: `UBO.obj` 3.83 MB → 110.9 MB, **28.9x** (28.70 / 28.73 / 28.93
    // over three runs), and `HannosRing.obj` 5.53 MB → 108.2 MB, 19.57x, against the Node
    // harness's 24.61x and 16.91x. `Baby_Yoda.obj` was not re-measured: at ~1.8 GB it is as likely
    // to kill the renderer as to report, the gate refuses it by a factor of thirteen either way,
    // and its multiplier is far below UBO's, so it cannot govern.
    //
    // Not corrected here for the same reason as `.3mf`: 28.9 moves the line to 8.86 MB, which is
    // a change to a number `PEAK_BUDGET_BYTES` is derived against, and the budget is shared. It
    // is outcome-neutral in the library — the next OBJ below `Baby_Yoda.obj` is 5.53 MB, so the
    // same one file is gated at 10.41 MB or at 8.86 MB — but it is under-priced, and a 9 MB OBJ
    // dropped into a library tomorrow would open silently at ~260 MB.
    peakCost: 24.6,
  },
  '.3mf': {
    parse: (bytes) => new ThreeMFLoader().parse(bytes),
    // An order of magnitude dearer than either, and the reason this table is per-format.
    //
    // A 3MF is a zip, so its size on disk says almost nothing about what opening it holds.
    // `ThreeMFLoader` calls fflate's `unzipSync`, which inflates *every* entry at once; decodes
    // the model part to a JS string; and only then builds a DOM over that string with
    // `DOMParser` (`3MFLoader.js:215`, where `zip`, `fileText` and `xmlData` are all live).
    //
    // Round 0 counted the first two terms and called the DOM "on top and uncounted". It is not a
    // rounding term, it is the largest one — and it is now measured rather than argued.
    //
    // ## The measurement
    //
    // `performance.measureUserAgentSpecificMemory()`, in a headed Chromium served from a
    // cross-origin-isolated origin, over the repo's own three.js. It is the only API that reports
    // Blink's C++ DOM allocation alongside the JS heap, which is the whole of what Node could not
    // see. A synchronous parse cannot be sampled from an async API, so the peak is taken by
    // holding every intermediate `3MFLoader.js:215` has live — the inflated zip, the decoded
    // model text and the document over it — and measuring with nothing released.
    //
    //   file                        on disk   elements   attributes   DOM      total    x
    //   pla_lith_mum_dad_e3.3mf    13.24 MB  2,218,656    6,655,951  426 MB   686.6 MB  51.87
    //   left.3mf (Beat Saber)       7.75 MB    891,398    2,674,138  171 MB   281.6 MB  36.34
    //   Uno.3mf                     0.54 MB     44,944      134,810  8.7 MB    14.1 MB  26.12
    //
    // The estimate was 51.5x against a measured 51.87x on the very file it was derived from, and
    // its DOM term was 408 MB against a measured 426 MB — the real Blink floor is about
    // 96 B/element rather than the 88 B assumed, and 32 B/attribute is right. So the cost moves
    // to 51.9 and stops being an estimate. Nothing about which files are gated changes: at 51.5
    // the line was 4.97 MB and at 51.9 it is 4.93 MB, and the library holds no 3MF between them.
    //
    // ## 51.9 IS NOT THE PEAK. IT IS 2.3x UNDER IT, KNOWINGLY.
    //
    // Read the paragraph above carefully: it prices the point the *estimate* priced, and that
    // point is not the peak. `parseModelNode` keeps the document reachable through
    // `modelData['xml']` for the whole of the geometry build, so the DOM, the zip, the decoded
    // text and the loader's plain-JS vertex and triangle arrays are all live together — and none
    // of that is in the 51.9.
    //
    // Measured end to end, as peak resident set: WorkingSet64 summed across Chromium's processes
    // every 20 ms while the parse runs on the main thread. That is the same quantity
    // `process.resourceUsage().maxRSS` gave the Node harness for `.stl` and `.obj`, so for the
    // first time all three rows can be compared with one method. Reproducible to three
    // significant figures across runs:
    //
    //   pla_lith_mum_dad_e3.3mf  13.24 MB → 1558.5 MB peak   117.75x
    //   left.3mf                  7.75 MB →  745.8 MB peak    96.22x
    //   Uno.3mf                   0.54 MB →   65.3 MB peak   120.95x
    //
    // The method is validated where it can be: `Waving_Groot_15.5cm.stl`, a 100 MB binary STL,
    // measures 321 MB in Chromium and 321 MB in the Node harness — identical. The 3MF rows differ
    // by 2.3x because Node never built the DOM at all.
    //
    // It is **not** priced here, and that is a deferral awaiting a decision rather than an
    // oversight. Pricing it means re-deriving `PEAK_BUDGET_BYTES`, because 117.75x against the
    // 3.95 MB 90th percentile that budget is derived from wants ~478 MB, and the same re-derivation
    // would move the `.stl` and `.obj` lines with it. That is a shared-tolerance decision, not a
    // constant this row can change on its own. What it costs meanwhile is bounded and small: the
    // gap bites only a plain-mesh 3MF between 2.2 MB and 4.93 MB, and the library's largest plain
    // mesh under the line is 0.54 MB, which peaks at 65 MB.
    //
    // One honest mismatch, unchanged: 51.9 comes from `pla_lith_mum_dad_e3.3mf`, and since the
    // gate now refuses slicer projects on `kind` before ever reaching here, that file can no
    // longer arrive. The plain meshes this row can actually see measure 36.34x at the same point.
    // The number is kept because density is a property of the mesh and not of the wrapper — a
    // plain mesh as dense as that project would cost the same — and because it is
    // outcome-neutral: at 36x the line is 7.1 MB and gates the same two files.
    peakCost: 51.9,
  },
}

/**
 * What the "unsupported" message names as openable, derived from `FORMATS` rather than written
 * out in each locale — the two would otherwise drift apart silently the moment a loader is
 * added, in two languages at once.
 */
export const SUPPORTED_FORMATS: readonly string[] = Object.keys(FORMATS).map((extension) =>
  extension.slice(1).toUpperCase(),
)

/**
 * How much memory one model may cost this tab before the user is asked whether to spend it.
 *
 * **This is the browser's number and nothing else's.** It is emphatically *not*
 * `DEFAULT_MAX_MESH_BYTES` from `packages/core/src/previews/mesh/limits.ts`, which happens to be
 * the same 256 MB — round 0 claimed that lineage and it was false in three ways. That constant's
 * own doc says it is "a backstop, not the mechanism", that "nothing in the reference library is
 * refused by this", and that "it is not derived from the memory budget"; it bounds geometry
 * arrays alone rather than a whole load; and it is operator-tunable through `SPM_MAX_MESH_MB` to
 * track a server's RAM and preview concurrency. Importing it would tie a browser filter that
 * fires on 40 real files to a deliberately non-binding server ceiling that someone may raise for
 * reasons having nothing to do with this tab. The two must move independently, so this number is
 * written here and derived here.
 *
 * ## The derivation
 *
 * The budget is set **as low as it can go without ever prompting on an ordinary model**, because
 * for a gate every megabyte of headroom is a megabyte of risk and the only cost of caution is a
 * click. "Ordinary" is the reference library's 90th percentile over all 1,725 models: **3.95 MB**
 * (the median is 0.148 MB). The binding format is the dearest, 3MF at 51.9x — **which is the
 * known-conservative figure, not the measured peak; see the `.3mf` row.** Re-deriving this from
 * the 117.75x that was actually measured wants a budget near 512 MB, and that decision has not
 * been taken, so what follows is the derivation as it stands rather than as it should be:
 *
 *     3.95 MB × 51.9 = 205 MB floor  →  256 MB shipped, 25 % headroom
 *
 * Nothing pushes it upward, so the floor governs and 256 MB is the round number just above it.
 *
 * ## What that catches, measured over the whole library
 *
 * | Format | Line                 | Gated, of what the viewer will open |
 * | ------ | -------------------- | ------------------------------------ |
 * | `.stl` | 256 / 6.75 = 37.9 MB | 25 of 1,311 (1.9 %)                  |
 * | `.obj` | 256 / 24.6 = 10.4 MB | 1 of 12 (8.3 %) — the 137.8 MB one   |
 * | `.3mf` | 256 / 51.9 =  4.9 MB | 2 of 28 (7.1 %) — the Beat Saber pair |
 *
 * **28 of the 1,351 files the viewer will open, 2.1 %.** The other 374 `.3mf` in the library are
 * slicer projects and never reach the size gate at all — `load` refuses them on `FileDto.kind`
 * first, which is the same predicate `project-detail.page.ts` uses to decide what gets a viewer
 * link. So the 3MF row is aimed at exactly the 28 files a user can actually click through to.
 *
 * One unit trap worth naming: these lines are decimal megabytes, but `formatBytes` divides by
 * 1024 while labelling the result "MB" (project-wide, and the project page prints file sizes the
 * same way). The 37.9 MB STL line therefore shows to the user as "36.2 MB", and the library's
 * 164.8 MB worst file appears in the prompt as "157.2 MB". The prompt matching the page the user
 * came from matters more than matching this comment.
 */
const PEAK_BUDGET_BYTES = 256_000_000

/**
 * The size above which a model of this format is not opened without asking.
 *
 * Throws rather than returning something unusable if a `peakCost` cannot bound anything. A
 * `peakCost: 0` typechecks and would make this `Infinity`, silently reopening the very hole
 * putting the cost inside `FORMATS` exists to close — so the one spelling that could disable the
 * gate by accident fails loudly instead, on the first load of that format.
 */
export function limitOf(extension: string, format: ModelFormat): number {
  const limit = PEAK_BUDGET_BYTES / format.peakCost
  if (!Number.isFinite(limit) || limit <= 0) {
    throw new Error(`FORMATS['${extension}'] has a peakCost that would disable the size gate`)
  }
  return limit
}

/**
 * The largest file of this name's format that opens without asking, or undefined when no loader
 * handles the name at all — in which case `load` has already reported it unsupported and never
 * asks.
 *
 * Exported for the spec, which derives a just-under and a just-over size from it rather than
 * writing byte counts of its own: a test that hardcoded 27.7 MB would quietly stop testing the
 * gate the day a `peakCost` was re-measured.
 */
export function sizeLimitFor(name: string): number | undefined {
  const extension = extensionOf(name)
  const format = FORMATS[extension]
  return format === undefined ? undefined : limitOf(extension, format)
}

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
 * Gives every mesh under `root` the viewer's own material, whatever the loader put there.
 *
 * **The same object must not look different because of the file it arrived in**, and before
 * this it did — measured in a real browser on three real files:
 *
 * - `.stl` — the app built a `MeshStandardMaterial`: matte, white.
 * - `.obj` with no `.mtl` beside it — `OBJLoader` falls back to three's default
 *   `MeshPhongMaterial`: white, and *shiny*, so the bottle opener came up with specular
 *   streaks down every edge that the same part in STL does not have.
 * - `.3mf` — `ThreeMFLoader`'s own default: a mid grey, noticeably darker than either.
 *
 * Three formats, three looks, one object. So one material wins, and it is the app's.
 *
 * **What that throws away, counted rather than guessed.** Of the 28 plain-mesh `.3mf` in the
 * reference library — the only files of any format that carry authored colour the loaders would
 * otherwise honour — 25 have no `displaycolor` at all (their `<basematerials>` is empty of one,
 * which is exactly why they render as that default grey), two name a single colour, and
 * **one** names two. So the whole cost of this decision is one file in 1,351 losing a
 * two-colour distinction, against every other file gaining a look that matches its thumbnail.
 * If real multi-material 3MFs ever become common here, the answer is a toggle, not a default.
 *
 * **Why the replaced materials are not disposed.** Nothing under `root` has been rendered yet:
 * `createContent` calls this before returning, and `load` only reaches `setContent` — the one
 * place anything joins the scene — afterwards. A `Material` or `Texture` that no renderer has
 * drawn with holds no GPU allocation and has no dispose listener attached, because three.js
 * registers both on first use. Disposing them would free nothing and dispatch an event nobody
 * is listening for. They are plain JS objects at this point, and the collector takes them.
 *
 * One material instance per mesh rather than one shared across all of them, so `disposeSubtree`
 * stays exactly one dispose per mesh. The cost is nil: three keys its shader programs by the
 * material's cache key, so N identical materials still compile one program.
 */
function materialise(root: Object3D): void {
  root.traverse((node) => {
    if ((node as Partial<Mesh>).isMesh !== true) return
    ;(node as Mesh).material = new MeshLambertMaterial({
      color: MODEL_COLOUR,
      // Both sides drawn. A printable STL is a closed solid and back faces should never show,
      // but plenty in the reference library are not closed, and a hole in a wall reading as a
      // hole in the *model* is the wrong report. The rasterizer takes the same view — it has
      // no back-face cull either, only a depth buffer.
      side: DoubleSide,
      // Per-face normals, so the same object is faceted whichever loader produced it. STL is
      // flat by construction (no shared vertices), `ThreeMFLoader` computes smooth vertex
      // normals, and OBJ is whichever the exporter wrote — three different surfaces for one
      // shape. Flat also matches the thumbnail, which shades per triangle.
      flatShading: true,
    })
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
          <!--
            The reset control sits on the title's row rather than over the canvas: floated on
            the stage it would have to be given a background of its own to stay legible over
            whatever the model happens to be, and it would cover part of the picture it exists
            to restore.

            Only while a model is on screen. There is no view to reset before one arrives, and
            a permanently visible control that does nothing for most of a load is worse than
            one that appears when it means something.
          -->
          <div class="spm-row spm-viewer-title">
            <h1>{{ t.translations().viewer.title }}</h1>
            @if (showsModel()) {
              <button jigButton kind="secondary" type="button" (click)="resetView()">
                {{ t.translations().viewer.resetView }}
              </button>
            }
          </div>
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
              <!--
                tabindex="-1" so loadAnyway can move focus here. Confirming the size gate
                destroys the button that was pressed along with its @case arm, and focus would
                otherwise fall to <body> — leaving a keyboard or screen-reader user with no
                confirmation that anything happened, on the one load slow enough to need one.
                -1 keeps it out of the tab order, so nothing changes for anyone else.
              -->
              <div #progressRegion tabindex="-1" class="spm-row spm-viewer-progress" role="status">
                <jig-progress [value]="percent() ?? 0" [indeterminate]="percent() === null" />
                <span class="spm-muted">{{ loadingLabel() }}</span>
              </div>
            }
            @case ('unsupported') {
              <!-- Warning, not error: nothing went wrong, this file is simply not a model. -->
              <jig-message color="warning" role="alert">{{ statusMessage() }}</jig-message>
            }
            @case ('slicerProject') {
              <!-- Same shape, different sentence: a .3mf the server read as a slicer project. -->
              <jig-message color="warning" role="alert">{{ statusMessage() }}</jig-message>
            }
            @case ('oversized') {
              <!--
                Warning, not error, for the same reason: nothing has gone wrong and the model is
                one click away. The user asked to be asked, not to be stopped.

                role="alert" stays on the message alone rather than wrapping the button too.
                An alert is announced and then left behind; interactive content inside one is
                not reliably reachable from where a screen reader lands. The button sits after
                it as an ordinary control, and its own label says what it does.
              -->
              <div class="spm-stack spm-stack--tight">
                <jig-message color="warning" role="alert">{{ statusMessage() }}</jig-message>
                <!-- Wrapped so the button is its own width rather than the stack's. -->
                <div>
                  <button jigButton kind="primary" type="button" (click)="loadAnyway()">
                    {{ t.translations().viewer.loadAnyway }}
                  </button>
                </div>
              </div>
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
          All three attributes are dropped whenever there is no model on screen: announcing
          "3D view of the model" beside an alert saying there is no model tells a screen-reader
          user two opposite things, and so does announcing it while the bytes are still
          arriving. tabindex goes with them because a focus stop that does nothing is worse
          than no focus stop -- there is nothing to orbit until there is a model.
        -->
        <div
          #viewport
          class="spm-viewport"
          [class.spm-viewport--collapsed]="!showsStage()"
          [attr.role]="showsModel() ? 'img' : null"
          [attr.aria-label]="showsModel() ? t.translations().viewer.canvasLabel : null"
          [attr.tabindex]="showsModel() ? 0 : null"
          (keydown)="onViewportKey($event)"
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
  private readonly injector = inject(Injector)
  protected readonly t = inject(TranslateService)
  protected readonly icons = { back: tablerArrowLeft }

  readonly id = input.required<string>()
  readonly fileId = input.required<string>()

  private readonly viewport = viewChild.required<ElementRef<HTMLElement>>('viewport')
  /** Present only while a model is downloading; see loadAnyway. */
  private readonly progressRegion = viewChild<ElementRef<HTMLElement>>('progressRegion')

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
      // `formats` comes from FORMATS, so adding a loader cannot leave two locales claiming a
      // shorter list than the viewer actually opens.
      return interpolate(viewer.unsupported, {
        extension: state.extension,
        formats: SUPPORTED_FORMATS.join(', '),
      })
    }
    if (state.status === 'slicerProject') return viewer.slicerProject
    if (state.status === 'oversized') {
      // `formatBytes` and not a number of our own: this is the same figure, in the same shape,
      // that the project page the user came from printed beside the file's name. A gate that
      // quoted a different size than the page it was reached from would read as a bug.
      return interpolate(viewer.tooLarge, {
        extension: state.extension,
        size: formatBytes(state.sizeBytes),
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
   * Whether the stage is worth the room it takes.
   *
   * Looked at in a browser this was the size gate's loudest defect, and it belonged to every
   * other outcome too: below the "this model is 74.2 MB" prompt sat an empty panel three
   * quarters of the viewport tall, in both themes, reading as a viewer that had failed to draw
   * rather than as one that had deliberately not started. The gate's own message is the answer
   * to "why is nothing here", and it cannot be read as such with a blank slab under it.
   *
   * 'loading' keeps the stage: the bytes are on their way and that is where they will land, so
   * collapsing and re-expanding the panel mid-download would be the page jumping for no reason.
   */
  protected readonly showsStage = computed(() => {
    if (this.initError() !== null) return false
    const status = this.state().status
    return status === 'ready' || status === 'loading'
  })

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
    // Before the position and before the controls, in that order and for two different
    // reasons: `lookAt` derives the whole basis from it, and `OrbitControls` snapshots it in
    // its constructor to build the quaternion its spherical model lives in.
    camera.up.copy(WORLD_UP)
    camera.position.copy(VIEW_DIRECTION).multiplyScalar(4)
    this.camera = camera

    // `AMBIENT + (1 - AMBIENT) * |N·L|`, the rasterizer's shading model, in three's terms.
    //
    // Three lights rather than the obvious one, and the count is the whole point. A single
    // directional light leaves every face turned away from it black, which orbiting to the far
    // side of a model does immediately. The pair below is opposed, so exactly one of them ever
    // has a positive `N·L` and the two together give `|N·L|` — the absolute value the
    // rasterizer takes — while the ambient term sets the floor a face edge-on to both lands on.
    //
    // `π` is not decoration. three.js divides irradiance by π in `BRDF_Lambert`, so an
    // intensity of `share * π` is what makes `share` mean the fraction of the base colour that
    // reaches the surface. Verified by reading pixels back off the canvas rather than trusted:
    // a face square-on to the key measures sRGB (239, 220, 198), which is `MODEL_COLOUR` exactly
    // — no clipping, no tone mapping in between.
    scene.add(new AmbientLight(0xffffff, AMBIENT_SHARE * Math.PI))
    for (const sign of [1, -1]) {
      const light = new DirectionalLight(0xffffff, (1 - AMBIENT_SHARE) * Math.PI)
      // A DirectionalLight shines from its position towards its target, and the target defaults
      // to the origin — so the position *is* the direction, and only its sign matters here.
      light.position.copy(KEY_LIGHT_DIRECTION).multiplyScalar(sign)
      scene.add(light)
    }

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
   * The user has read the size and wants it anyway. Runs the same load again with the gate
   * lifted for that one run.
   *
   * The answer is deliberately not recorded anywhere — not in a field, not in a set of file
   * ids, not in storage. It is an argument to a single call, so the *only* load it can affect
   * is this one. Someone who presses this by mistake on a 164 MB model has agreed to download
   * a 164 MB model, and nothing more: the next file, and this same file after a navigation,
   * ask again. A remembered "yes" would turn one misclick into a viewer that never asks
   * again, which is precisely the failure the gate exists to prevent.
   *
   * Re-registered with `PendingTasks` for the same reason `syncContent` does it — this is a
   * fresh download, and `whenStable()` has to cover it too.
   */
  protected loadAnyway(): void {
    if (this.state().status !== 'oversized') return
    const file = this.file()
    void this.pendingTasks.run(() => this.load(file, false, true))
    // `load` sets the loading state before its first await, so the very next render has the
    // progress region — which is where the focus the pressed button is about to take with it
    // has to go. Without this a keyboard user is returned to <body> and a screen-reader user
    // hears nothing at all, on a download that by definition takes a while.
    afterNextRender(() => this.progressRegion()?.nativeElement.focus(), {
      injector: this.injector,
    })
  }

  /**
   * Puts the camera back where the model opened.
   *
   * There was no way back before this. `resize` re-fits only while `userMovedCamera` is false,
   * which is correct — nobody wants their view undone because the window moved — but it meant
   * one drag past the edge of the model left a blank canvas with no error, no control and
   * nothing to try except reloading the page. The fit is the one view guaranteed to contain the
   * model, so it is the one thing worth offering.
   *
   * Clearing the flag as well as re-framing, so the automatic re-fit on resize is handed back
   * too: after a reset the camera is this component's again, exactly as it was on load.
   *
   * `frame` is idempotent here — it re-centres a model already centred on the origin, which
   * subtracts a zero — so pressing this twice is the same as pressing it once.
   */
  protected resetView(): void {
    const content = this.content
    if (!content) return
    this.userMovedCamera = false
    this.frame(content)
  }

  /**
   * The keyboard path for the camera: arrows orbit, `+`/`-` zoom, `0` resets.
   *
   * Written here rather than through `OrbitControls.listenToKeyEvents`, which does exist, for
   * two reasons that both come from reading its source. Its arrow keys **pan** and require a
   * modifier to rotate, which is backwards for a viewer whose primary gesture is rotate; and
   * its rotation step is `2π · keyRotateSpeed / clientHeight`, which at the shipped
   * `keyRotateSpeed` of 1 and this panel's height is 0.57° a press — 630 presses for one turn.
   * `rotateLeft`, `rotateUp`, `dollyIn` and `dollyOut` are public API and each calls `update()`
   * itself, so this is the supported surface, not a reach inside.
   *
   * **The honest part.** This is a keyboard path for a sighted keyboard user, and that is who
   * it is for. It is not one for a screen-reader user in browse mode, where the reader claims
   * the arrow keys before the page sees them; the container is `role="img"`, which is what it
   * is, and no role short of `application` changes that. Nothing is lost by it: rotating a
   * picture you cannot see buys nothing, and "Reset view" — a real, labelled button — is the
   * one camera control that stays reachable however the keys are being routed.
   */
  protected onViewportKey(event: KeyboardEvent): void {
    const controls = this.controls
    if (!controls) return
    // Chords belong to the browser and to assistive technology; only bare presses are ours.
    if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return

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
      // '=' is the unshifted key '+' lives on, on the layouts this ships to.
      case '+':
      case '=':
        controls.dollyIn(DOLLY_STEP)
        break
      case '-':
        controls.dollyOut(DOLLY_STEP)
        break
      case '0':
        // Returns without setting the flag: resetView clears it, and setting it after would
        // leave the camera "the user's" at the exact position the component chose.
        this.resetView()
        event.preventDefault()
        return
      default:
        return
    }

    // The same flag a drag or a wheel sets. Without it the next resize would re-fit and throw
    // away everything the user had just typed their way to.
    this.userMovedCamera = true
    // Only for the keys handled above, and only once one of them matched: an unconditional
    // preventDefault here would eat Tab and every browser shortcut that reaches this element.
    event.preventDefault()
  }

  /**
   * One load, start to finish: decide, fetch, parse, frame, swap — and put the page into
   * exactly one of the states on the way out.
   *
   * `file` is undefined for two different reasons and they do not read the same: the project
   * loaded and holds no such id (a stale link, or a file deleted from another tab), or the
   * project could not be fetched at all (`metadataFailed`, a network problem the user can
   * retry).
   *
   * `confirmed` is the user having pressed through the size gate for *this* load. It is a
   * parameter and not a field on purpose — see `loadAnyway`.
   */
  private async load(
    file: FileDto | undefined,
    metadataFailed: boolean,
    confirmed = false,
  ): Promise<void> {
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

    const extensionKey = extensionOf(file.name)
    const format = FORMATS[extensionKey]
    // The whole name when there is no extension, so no message renders an empty slot.
    const extension = extensionKey || file.name
    if (!format) {
      // Decided before anything is fetched, which is also where the two arms below belong:
      // all three are reasons not to open a connection at all.
      this.state.set({ status: 'unsupported', extension })
      return
    }

    // What the file *is*, not what it is called. `FileDto.kind` is on the object already in
    // hand and is the same predicate `project-detail.page.ts` uses to decide which files get a
    // viewer link at all, so reading it here makes the two agree instead of merely coincide.
    //
    // It matters most for `.3mf`, which is one extension over two entirely different things:
    // the reference library holds 374 slicer projects and 28 plain meshes. Keyed on the
    // extension alone the viewer offers to open a 96 MB Bambu project as a mesh — a download of
    // ~2.5 GB of peak memory to render something the user never asked to see — and, because the
    // size line then has to be set loose enough to be tolerable for those, it waved through both
    // of the only large 3MF meshes a user can actually click on.
    if (file.kind !== 'model') {
      if (file.kind === 'slicer_project') {
        this.state.set({ status: 'slicerProject' })
        return
      }
      // A viewable extension the server could not read as a model — in practice a `.3mf` whose
      // zip is damaged, since `classifyFile` gives `.stl` and `.obj` `kind: 'model'`
      // unconditionally. Reported as a parse failure without fetching: that message ("may be
      // damaged or only partly uploaded") is exactly the right advice, and it is now given for
      // the price of no download at all rather than after pulling the whole file down to fail
      // on it.
      this.state.set({ status: 'failed', reason: 'parse', extension })
      return
    }

    // The size gate, in the same place and for the same reason. The limit comes from `format`
    // that was just looked up, so there is no "no loader" case left to spell out here — and
    // `limitOf` throws rather than yielding a limit that could not gate anything.
    const limit = limitOf(extensionKey, format)
    if (!confirmed && file.sizeBytes > limit) {
      // Nothing is fetched. Not fetched-and-discarded, not fetched-and-paused: a gate that
      // opens the connection has already spent the download, which on the file this exists
      // for is 164 MB over whatever connection the user is on.
      this.state.set({ status: 'oversized', extension, sizeBytes: file.sizeBytes })
      return
    }

    const inFlight = new AbortController()
    this.inFlight = inFlight

    let content: Object3D
    try {
      content = await this.createContent(file, format.parse, token, inFlight.signal)
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

    // Before the return, so nothing the loader chose can reach the scene — which is also what
    // makes it safe not to dispose what it replaces. See `materialise`.
    materialise(content)
    return content
  }

  /**
   * The one place a model's bytes are fetched.
   *
   * The size gate sits earlier still — in `load`, beside the unsupported-extension arm —
   * because a file over the threshold must not open a connection at all. This staying the
   * only door to the network is what makes that gate impossible to route around, so a second
   * `fetch` added to this module would be a hole in it rather than a convenience.
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
   * the moment it turned. It is computed against both the vertical and the horizontal field of
   * view and the wider distance wins, so a tall model in a wide viewport is framed by its
   * height and not cropped by it.
   *
   * The cost is that the model always opens smaller here than its thumbnail looks, and **which**
   * models lose most is the opposite of what an earlier version of this comment claimed.
   * Measured as on-screen height over the tile's, in a 1254x627 panel: 3DBenchy 0.63, Batman
   * bust 0.75, UBO 0.72, miniCube 0.83, and a 22x11x3 mm box **0.92**. The elongated flat part
   * is the *best* case, not the worst — the rasterizer normalises by the larger projected
   * dimension, so a long part is squat in the tile too, and both fits penalise it together.
   * What actually drives the gap is how much bigger the bounding sphere is than the projected
   * outline, which is worst for a chunky model that fills its own silhouette. That is the right
   * trade for a view that moves, but it is not small: on a Benchy the viewer opens at under
   * two thirds of the tile's size.
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
