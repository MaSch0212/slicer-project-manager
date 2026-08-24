import { AppError } from '@spm/contract/errors.ts'

/** `positions` holds 9 `Float32Array` slots — three vertices, x/y/z each — per triangle. */
const BYTES_PER_TRIANGLE = 36
/** The index table the 3MF and OBJ parsers resolve faces through: x/y/z per distinct vertex. */
const BYTES_PER_VERTEX = 12

/**
 * The default ceiling on one mesh's geometry arrays.
 *
 * **A backstop, not the mechanism.** Every read in this package is streamed, so the document is no
 * longer part of the peak and nothing in the reference library is refused by this. The two worst
 * files are the Köln Pokal 3MF — 2 899 850 triangles over 8 699 550 unshared vertices, so 104.4 MB
 * of `positions` beside 104.4 MB of the vertex table they index, 208.8 MB — and Baby Groot's
 * 164 MB binary STL at 3 295 832 triangles, which needs 118.7 MB and no vertex table at all. What
 * this exists for is input whose triangle count is a function of an attacker rather than of a
 * printer: a model part declaring a billion degenerate triangles asks for 36 GB, and asking is all
 * it takes.
 *
 * 256 MB is the library's worst file plus 23%, which is the smallest round number that is a
 * backstop rather than a filter. It is not derived from the memory budget — one worker's peak is
 * `mesh + ~80 MB of reader + ~46 MB of Deno`, so at the default concurrency of 1 the budget's
 * share is ~374 MB and the ceiling is the looser of the two constraints. Raising it is one
 * variable, `SPM_MAX_MESH_MB`; the README carries the arithmetic for pairing it with
 * `SPM_PREVIEW_CONCURRENCY`.
 */
export const DEFAULT_MAX_MESH_BYTES = 256_000_000

/** What a parser is about to allocate for a mesh of this shape, in bytes. */
export function meshBytesFor(vertexCount: number, triangleCount: number): number {
  return vertexCount * BYTES_PER_VERTEX + triangleCount * BYTES_PER_TRIANGLE
}

/** Options every mesh parser takes, so the ceiling is the caller's to raise. */
export type MeshLimits = {
  /** Defaults to `DEFAULT_MAX_MESH_BYTES`. */
  maxMeshBytes?: number
}

function megabytes(bytes: number): string {
  return `${(bytes / 1_000_000).toFixed(1)} MB`
}

/**
 * Refuses a mesh that would not fit, **before** the allocation rather than after it.
 *
 * The counts come from a counting pass that allocates nothing, so this runs while the process is
 * still holding only the parser's fixed window — which is the only order in which a limit is worth
 * having. The message names both sizes because the operator's next question is always "by how
 * much", and the answer decides whether `SPM_MAX_MESH_MB` is the fix or the file is.
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
