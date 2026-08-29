import { AppError } from '@spm/contract/errors.ts'

/** `positions` holds 9 `Float32Array` slots — three vertices, x/y/z each — per triangle. */
const BYTES_PER_TRIANGLE = 36
/** The index table the 3MF and OBJ parsers resolve faces through: x/y/z per distinct vertex. */
const BYTES_PER_VERTEX = 12

/**
 * The default ceiling on one mesh's geometry arrays.
 *
 * **A backstop, not the mechanism.** Every read in this package is streamed *except the STEP one*,
 * so for STL, OBJ and 3MF the document is no longer part of the peak, and nothing in the reference
 * library is refused by this. The two worst
 * files are the Köln Pokal 3MF — 2 899 850 triangles over 8 699 550 unshared vertices, so 104.4 MB
 * of `positions` beside 104.4 MB of the vertex table they index, 208.8 MB — and Baby Groot's
 * 164 MB binary STL at 3 295 832 triangles, which needs 118.7 MB and no vertex table at all. What
 * this exists for is input whose triangle count is a function of an attacker rather than of a
 * printer: a model part declaring a billion degenerate triangles asks for 36 GB, and asking is all
 * it takes.
 *
 * **This constant does not bound what a STEP file costs, and that is the most misleading thing a
 * reader could infer from it.** `parseStepFile` hands the whole file to OCCT, which tessellates
 * before anything countable exists, and the measured cost of doing so is a per-process floor of
 * ~244 MB of peak RSS that is not the mesh at all: the largest `positions` array over the whole
 * reference STEP sample is 796 932 bytes, three orders of magnitude under this number. Lowering
 * this will not lower that floor and raising it will not raise it. What this does bound on that
 * arm is the adapter's own `positions` allocation, after the parse. See `parseStepFile`.
 *
 * 256 MB is the library's worst file plus 23%, which is the smallest round number that is a
 * backstop rather than a filter. It is not derived from the memory budget — one worker's peak is
 * `mesh + ~80 MB of reader + ~46 MB of Deno`, so at the default concurrency of 1 the budget's
 * share is ~374 MB and the ceiling is the looser of the two constraints. Raising it is one
 * variable, `SPM_MAX_MESH_MB`; the README carries the arithmetic for pairing it with
 * `SPM_PREVIEW_CONCURRENCY`.
 */
export const DEFAULT_MAX_MESH_BYTES = 256_000_000

/**
 * The default ceiling on one **STEP file**, read from its size on disk before it is opened.
 *
 * **A guard against the unmeasured, and not a memory model.** `assertMeshFits` structurally cannot
 * bound a STEP parse — the triangle count does not exist until OCCT has already tessellated, so by
 * the time there is a number to check the expensive part is paid. This is the only thing standing
 * between the queue and a file nobody has tried. What it stands on is thin, and the thinness is
 * written down here rather than smoothed over.
 *
 * **Where 10 MB comes from.** Fitting the reference library's ten STEP files gives ~243 MB of
 * intercept plus ~25 bytes of peak RSS per input byte, so a 10 MB input predicts 243 + 250 ≈
 * **493 MB — the entire 500 MB NAS budget, on one file.** It is also **7.2x the largest STEP file
 * in that library** (1 388 035 bytes), so nothing real is near it from the other direction either.
 *
 * **And the fit cannot be accurate, because the cost tracks surface complexity rather than size.**
 * A 386 KB file yielded 22 137 triangles where a 497 KB one yielded 2 698 — an 8x spread from
 * comparable inputs. A size-keyed guard mis-prices both, and there is no other signal available
 * before the parse. What a 50 MB STEP file costs, and whether it degrades or takes the process
 * down, is **unmeasured**: nothing above 1.39 MB has ever been run. This refuses such a file
 * rather than finding out on a 2 GB NAS.
 *
 * **Raising `SPM_MAX_STEP_MB` is forward-only, and here is what an operator actually does about
 * it.** `failed` is terminal — `claimPendingPreviews` selects only `pending` — so a raised ceiling
 * gets the new limit for files the queue has not yet seen and **nothing at all** for the ones it
 * has already refused. That is the shape of the 326 blank projects, arriving through a
 * configuration change rather than a release. The only remedy the shipped code offers is to touch
 * the file's bytes: a rescan that sees the content hash change resets the preview row to `pending`
 * and zeroes `attempts`. This is already true of `SPM_MAX_MESH_MB`; F neither fixes it nor makes
 * it worse, and it is recorded here so nobody discovers it in the field.
 */
export const DEFAULT_MAX_STEP_BYTES = 10_000_000

/** What a parser is about to allocate for a mesh of this shape, in bytes. */
export function meshBytesFor(vertexCount: number, triangleCount: number): number {
  return vertexCount * BYTES_PER_VERTEX + triangleCount * BYTES_PER_TRIANGLE
}

/**
 * Options every mesh parser takes, so the ceiling is the caller's to raise.
 *
 * **Three things about `maxStepBytes` that are not tidy.**
 *
 * It bounds a **file** where every other member bounds a **mesh**, which makes this type's name
 * slightly wrong. It is not renamed: a rename touches every parser signature in the package, and
 * buys a better noun and nothing else.
 *
 * It has **exactly one reader**, and nobody should add a second by analogy. `assertMeshFits` does
 * not consult it — that function reads `maxMeshBytes` alone — and `assertStepFileFits` is the only
 * thing that does. Both halves of that are pinned by a test.
 *
 * And it is **not a memory model**. A STEP parse costs a ~244 MB per-process floor that no value
 * here lowers; this bounds the input, because the input is the only thing knowable before the
 * parse. See `DEFAULT_MAX_STEP_BYTES`.
 */
export type MeshLimits = {
  /** Defaults to `DEFAULT_MAX_MESH_BYTES`. */
  maxMeshBytes?: number
  /** Defaults to `DEFAULT_MAX_STEP_BYTES`. The file on disk, not the mesh it yields. */
  maxStepBytes?: number
}

function megabytes(bytes: number): string {
  return `${(bytes / 1_000_000).toFixed(1)} MB`
}

/**
 * Refuses a mesh that would not fit, **before** the allocation rather than after it.
 *
 * **On the STL, OBJ and 3MF arms** the counts come from a counting pass that allocates nothing, so
 * this runs while the process is still holding only the parser's fixed window — which is the only
 * order in which a limit is worth having.
 *
 * **On the STEP arm it cannot, and the call there means something narrower.** OCCT tessellates
 * before any count exists, so the numbers reaching this function are a result rather than a
 * prediction, and the expensive part of that parse has already been paid. What this bounds there is
 * the adapter's own `positions` allocation and nothing else. It is still worth calling — one
 * ceiling for every arm, and a pathological tessellation is still refused before a `Float32Array`
 * is asked for — but it is not the guard it is on the other three. `assertStepFileFits` below is
 * what stands in for it there, and it bounds the input rather than the mesh. **This function does
 * not read `maxStepBytes` and must not start**: the two ceilings answer different questions at
 * different moments, and the STEP one has exactly one reader on purpose.
 *
 * The message names both sizes because the operator's next question is always "by how much", and
 * the answer decides whether `SPM_MAX_MESH_MB` is the fix or the file is.
 */
export function assertMeshFits(
  vertexCount: number,
  triangleCount: number,
  limits: MeshLimits | undefined,
): void {
  const maxMeshBytes = limits?.maxMeshBytes ?? DEFAULT_MAX_MESH_BYTES
  const needed = meshBytesFor(vertexCount, triangleCount)
  if (needed > maxMeshBytes) {
    throw new AppError(
      'Validation',
      `model geometry needs ${megabytes(needed)} (${triangleCount} triangles), ` +
        `more than the ${megabytes(maxMeshBytes)} this server permits`,
      { vertexCount, triangleCount, neededBytes: needed, maxMeshBytes },
    )
  }
}

/**
 * Refuses a STEP file larger than the ceiling, **before it is opened**.
 *
 * `assertMeshFits`'s exact shape, doing something different, which is why the difference is here
 * rather than left to be inferred. That one bounds an allocation this process is about to make and
 * can predict. This one bounds an **input**, because the cost it stands in for — OCCT's ~244 MB
 * per-process floor plus whatever tessellating this particular file adds on top — cannot be
 * predicted from anything available before the parse.
 *
 * `sizeBytes` must come from `statSync` and never from a buffer's `length`: a check on the buffer
 * is a check after the file is already resident, which is precisely the cost this exists to avoid.
 * `readStepBytes` in `step.ts` is the one place that ordering lives, and where it is asserted.
 *
 * "Permitted for one STEP file", not `assertMeshFits`'s "this server permits" — the same string
 * ships inside the Electron app, where there is no server. The message names both sizes for the
 * same reason the neighbour's does: the operator's next question is always "by how much".
 */
export function assertStepFileFits(sizeBytes: number, limits: MeshLimits | undefined): void {
  const maxStepBytes = limits?.maxStepBytes ?? DEFAULT_MAX_STEP_BYTES
  if (sizeBytes > maxStepBytes) {
    throw new AppError(
      'Validation',
      `this STEP file is ${megabytes(sizeBytes)}, more than the ` +
        `${megabytes(maxStepBytes)} permitted for one STEP file`,
      { sizeBytes, maxStepBytes },
    )
  }
}

/**
 * `new Float32Array(length)` with the bare `RangeError` turned into the failure contract the rest
 * of the system reads.
 *
 * `assertMeshFits` is the ceiling an operator sets, and it is deliberately allowed to be larger
 * than a given machine — the same configuration ships to a NAS and to a Mac mini. So the
 * allocation can still fail: past the engine's own typed-array limit, and, more plausibly, because
 * the machine has not got the memory. Either way the length that reached here came out of a file,
 * and the rule for anything a file can cause is `AppError('Validation', …)` and never a
 * `RangeError` escaping the queue's failure contract. Same reasoning, and same shape, as
 * `allocate` in `files/zip.ts`.
 */
export function allocateMesh(floats: number, what: string): Float32Array {
  try {
    return new Float32Array(floats)
  } catch {
    throw new AppError('Validation', `model is too large to allocate its ${what}`, {
      floats,
      bytes: floats * 4,
    })
  }
}
