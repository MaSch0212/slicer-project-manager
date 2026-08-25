# Slicer Project Manager — Subsystem B2: the interactive viewer

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to
> implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** open a model and look at it. Today a file row shows a 256px thumbnail and nothing
else; there is no way to inspect geometry, check an orientation, or confirm a print is the one
you meant. This adds the three.js viewer that spec §7.4 sketches.

**Spec:** [`docs/superpowers/specs/2026-08-22-slicer-project-manager-design.md`](../specs/2026-08-22-slicer-project-manager-design.md)
§7.4, with §6.3 for routes and §2.5 for build targets.

**Prior plans:** [subsystem A](2026-08-22-slicer-project-manager-subsystem-a.md),
[B1](2026-08-23-slicer-project-manager-subsystem-b1-rasterizer.md),
[B1 follow-ups](2026-08-24-slicer-project-manager-b1-followups.md). B1 gave every model a
server-rendered thumbnail; none of that is rebuilt here, and **nothing in `packages/core` or
`packages/server` changes**.

---

## Scope

| In this plan                                               | Not in this plan                                    |
| ---------------------------------------------------------- | --------------------------------------------------- |
| three.js, lazy-loaded, browser only                        | Any change to core, the server, or the API contract |
| A route that opens one file in a canvas                    | Uploading the canvas as a higher-quality preview    |
| STL, OBJ and 3MF via three.js's own loaders                | Mesh decimation                                     |
| A size gate that asks before loading a big model           | Measurement, section planes, or any editing         |
| Orbit / zoom / pan, and framing that matches the thumbnail | Multi-file scenes, or comparing two models          |

**Deliberately deferred, with reasons**, so they are not rediscovered as gaps:

- **Uploading the rendered canvas as the preview.** The browser has a real GPU and three.js
  produces a better image than the server's flat-shaded rasterizer. It needs a new API
  endpoint and a contract change, and it is only worth doing once the viewer itself is proven.
- **Decimation.** It does nothing for server memory (measured in the B1 follow-ups: the peak is
  the document, not the mesh) but it is genuinely useful _here_ — shipping a 164 MB STL to a
  browser is bad regardless. The size gate below is the cheap version; decimation is the real
  fix and belongs with the upload work above.

---

## Global constraints

A reviewer should treat a violation as a defect regardless of what a task says.

1. **three.js must not enter the initial bundle.** It is the heaviest dependency in the
   project. The route is lazy, and task 5 adds a check that fails the build if it leaks.
2. **Every GPU resource is released when the viewer goes away.** Geometries, materials,
   textures and the renderer itself. A viewer that leaks a context per navigation will exhaust
   the browser after a handful of models, and nothing in the existing suite would notice.
3. **No changes to `packages/core`, `packages/server`, or `packages/contract`.** Everything
   needed is already on `FileDto`: `rawUrl`, `sizeBytes`, `kind`, `name`.
4. **Angular 22 house style**, as the rest of `packages/web`: standalone, zoneless, `OnPush`,
   `inject()` only, signals and `resource()` rather than manual subscriptions, jig controls for
   anything that is not the canvas.
5. **Both themes.** The viewer's background and lighting must read correctly in light and dark;
   the thumbnail palette assumed a dark background and this one cannot.
6. **Failure is explicit.** A model that will not parse, a fetch that 404s, a WebGL context
   that cannot be created — each says so in words. A blank canvas is not an acceptable outcome.
7. **Tests run in `packages/web`** and must pass under `deno task test:web`; e2e under
   `deno task e2e`. Every assertion must be able to fail — break the code it covers, confirm
   red, restore.

---

## Decisions taken up front

1. **A real route, not a modal.** `projects/:id/view/:fileId`, added to `routes.shared.ts` with
   `loadComponent`. It is linkable, back-button works, and the lazy chunk boundary falls
   exactly where the heavy dependency does. A modal would put the viewer in whichever chunk the
   detail page lives in.
2. **three.js's own loaders**, not the parsers from `packages/core`. Those are written for a
   dual-runtime server and return a bare triangle soup; `STLLoader`, `OBJLoader` and
   `ThreeMFLoader` return `BufferGeometry` ready for the GPU, and `ThreeMFLoader` works in a
   browser because `DOMParser` exists there — which is exactly why it could not be used on the
   server.
3. **The default camera matches the thumbnail.** Azimuth 32° off the isometric diagonal,
   elevation `atan(1/√2)`, the same framing B1 settled on after several rounds. Opening a model
   should not make it jump; the grid and the viewer should look like the same object.
4. **The size gate is a prompt, not a refusal.** Over the threshold, the viewer explains the
   size and offers to load it anyway. The user asked for this, and a refusal the user cannot
   override is worse than a slow load they chose.

---

## Tasks

### Task 1 — The route, the canvas, and disposal

- [ ] Add `projects/:id/view/:fileId` to `packages/web/src/app/routes.shared.ts` with
      `loadComponent`, guarded by `authGuard` like its siblings.
- [ ] `packages/web/src/app/features/viewer/viewer.page.ts`: a standalone `OnPush` component
      that creates a `WebGLRenderer`, a scene, a camera and `OrbitControls`, sized to its
      container and resizing with it.
- [ ] Render a hard-coded cube for now. This task is the plumbing; task 2 loads real files.
- [ ] **Disposal is the point of this task.** On destroy: stop the animation loop, dispose
      every geometry, material and texture, dispose the controls, call
      `renderer.dispose()` and `forceContextLoss()`, and drop the canvas. Write the test first —
      navigate away and assert the resources were released.
- [ ] A `ResizeObserver`, not a window listener: the canvas shares a page with a sidebar.
- [ ] Tests: the route resolves and lazily loads; a canvas is present; navigating away disposes
      (assert on spies over the three.js objects, and confirm the test fails if any single
      `dispose()` is removed).

### Task 2 — Loading real geometry

- [ ] `STLLoader`, `OBJLoader` and `ThreeMFLoader` from `three/examples/jsm/loaders/`, chosen by
      the file's extension — the same three the server rasterizes, so the viewer covers exactly
      what the grid shows a thumbnail for.
- [ ] Fetch from `FileDto.rawUrl`. Report progress if the loader offers it; a 164 MB STL over a
      home connection is not instant.
- [ ] Frame the loaded geometry: compute its bounding box, centre it, and set the camera
      distance so it fills the view with a margin — the same fit rule the rasterizer uses.
- [ ] Four states, each distinguishable and each tested: loading, ready, unsupported extension,
      and failed (fetch error, parse error, or a mesh with no triangles).
- [ ] **Link to it.** `project-detail.page.ts` currently sends a model file to its `rawUrl`,
      which downloads it. Nothing anywhere opens the viewer, so without this B2 ships a feature
      reachable only by typing a URL. Add the entry point and test that it navigates.
- [ ] Tests: each loader is selected for its extension and for an uppercase extension (the
      reference library contains `.STL` — this exact bug was found in B1); an unknown extension
      is `unsupported`, not a crash; a parse failure surfaces as an error state with a message.

### Task 3 — The size gate

- [ ] Over a threshold, do not load. Show the file's size and a control to load it anyway.
- [ ] Derive the threshold from something real, not a round number: the reference library has
      1,311 STLs and a 164 MB worst case. State in a comment what fraction of the library falls
      above the chosen line, and why that line.
- [ ] The choice is per-load, not remembered — an accidental "load anyway" on a 164 MB file
      should not make every later model load silently.
- [ ] Tests: under the threshold loads without a prompt; over it prompts and does not fetch
      until confirmed (assert no request was made); confirming loads.

### Task 4 — Making it look like the same object as the thumbnail

- [ ] Default camera as decision 3: azimuth 32°, elevation `atan(1/√2)`. Take the exact angles
      from `packages/core/src/previews/raster.ts`, which documents them and pins them with a
      test — do not re-derive them by eye.
- [ ] Lighting and material chosen so the model reads at a glance and both themes work. The
      thumbnail's amber-on-slate was tuned for a dark background only; say what you chose here
      and why.
- [ ] Fix what task 1's review measured in a real browser: the viewport border is invisible in
      the light theme (`surface-100` and `border` resolve to the same colour there), and the
      transparency checker sits at 1.22:1 contrast in light and 2.82:1 in dark — visible in
      both, comfortable in neither.
- [ ] A grid or ground plane if it helps orientation, and only if it does.
- [ ] The canvas needs an accessible name, and the orbit controls need a keyboard path or an
      honest statement that they have none.
- [ ] **Look at it.** Render several real models — `D:\SPM Library\marc` has 1,311 STLs and 402
      `.3mf` files, of which 374 are slicer projects and only **28** are plain meshes the viewer
      can open, plus a 3DBenchy and a Batman bust — take screenshots, open them, and report what
      you see.
      Compare against the thumbnail of the same model: they should read as the same object.

### Task 5 — Proving it, and keeping three.js out of the initial bundle

- [ ] A check that fails if three.js reaches an initial chunk. The web CI job already greps the
      built bundle for a class name (spec 2.5); follow that pattern rather than inventing one,
      and make it fail loudly with the chunk named. Verify each marker you grep for is actually
      **present in the viewer chunk** — task 1 shipped two that match nothing anywhere, and a
      marker that is never present cannot detect a leak.
- [ ] **The obvious proof does not work, so do not plan around it.** Measured in task 1:
      three.js is effectively not tree-shakeable here — a full `WebGLRenderer` import, a
      realistic `Box3`/`Mesh`/`Scene` import and a single `Vector3` all produce the same 1.18 MB
      initial bundle, which blows the existing 1 MB budget. So importing it eagerly fails the
      **budget** before any grep runs, and no artifacts are written at all. Two consequences:
      the grep step must be unable to pass against a stale `dist/` (a build that wrote nothing
      must fail, not silently re-grep yesterday's output), and the proof that the grep bites has
      to be staged differently — raise the budget temporarily, or plant a marker string.
- [ ] Record the lazy chunk's size in the README so a future dependency bump that doubles it is
      visible in a diff.
- [ ] An e2e that opens a real model and asserts the canvas has actually drawn — not that a
      `<canvas>` element exists. Playwright's bundled Chromium renders WebGL2 through
      SwiftShader with no GPU — measured in this project, the renderer string names
      SwiftShader — so read pixels back and assert the frame is not uniformly the background
      colour.
- [ ] **Prove contexts are released, which the unit suite structurally cannot.** jsdom has no
      WebGL, so task 1's renderer disposal is asserted against a stand-in; only a real browser
      can show a context was freed. Navigate into the viewer and back more than sixteen times —
      browsers cap live contexts around there — and assert the last one still draws. Without
      this, nothing in the project proves the leak that motivated task 1 is actually fixed.
- [ ] Keep the e2e fixture small. The web CI job has a ten-minute timeout and the e2e job
      twenty; a large model would spend the budget on a download.
- [ ] Tests: the bundle check fails when three.js is imported eagerly (prove it by doing so
      temporarily); the e2e fails if the canvas never draws.

---

## Definition of done

- `deno task verify` green; `deno task e2e` green; CI green on `main` after push.
- Opening a model from the project detail page shows it, orbits smoothly, and looks like the
  thumbnail of the same file.
- three.js is absent from every initial chunk, and the check that proves it fails when it is
  not.
- Navigating in and out of the viewer twenty times does not accumulate WebGL contexts.
