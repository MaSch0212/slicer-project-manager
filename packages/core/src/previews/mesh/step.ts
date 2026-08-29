import { readFileSync, statSync } from 'node:fs'
import { AppError } from '@spm/contract/errors.ts'
import occtimportjs from 'occt-import-js'
import { allocateMesh, assertMeshFits, assertStepFileFits, type MeshLimits } from './limits.ts'
import type { Mesh } from './mesh.ts'

/**
 * The one entry point of `occt-import-js` this package uses, and deliberately the only one.
 *
 * The package ships no type declarations, so this is the shape a `.d.ts` beside it declares. It
 * names `ReadStepFile` and nothing else: the library also exports `ReadFile`, `ReadIgesFile` and
 * `ReadBrepFile`, IGES and BREP are out of scope, and a declared entry point that nothing has ever
 * tested is how a file that could have rendered ends up with an `unsupported` row instead.
 */
export type Occt = {
  ReadStepFile(bytes: Uint8Array, params: null): OcctResult
}

/**
 * What `ReadStepFile` hands back, as this build actually returns it.
 *
 * `meshes` is optional because it is genuinely absent on failure — measured: a truncated STEP file
 * returns an object whose only own key is `success`. `error` is optional for the weaker reason that
 * nothing observed has ever carried one, so the message this module throws has to stand on its own
 * and the field is read only as a bonus.
 */
type OcctResult = {
  success: boolean
  error?: string
  meshes?: readonly OcctMesh[]
}

/**
 * One indexed mesh: a vertex table plus the triangle indices into it.
 *
 * `ArrayLike<number>` rather than a typed array, because it is not one. All ten reference files
 * came back with `positionsIsTypedArray: false` and `indexIsTypedArray: false` — plain JavaScript
 * number arrays — and so does the `cube.stp` fixture. The de-index loop below reads through this
 * type and writes `Float32Array`, so the conversion is free and the declaration does not have to
 * promise a representation the library does not give.
 */
type OcctMesh = {
  attributes: { position: { array: ArrayLike<number> } }
  index: { array: ArrayLike<number> }
}

/**
 * Holds the instantiated WASM module, and never holds a rejection.
 *
 * Exported and taking its factory as a parameter for one reason: the rejection case has to be
 * reachable from a test. `node --test` and `deno test` share one process across a file, so a memo
 * kept in a module-level `let` would be resolved by the first parse in the suite and the rejection
 * branch would be unreachable for every test after it. Each test builds its own loader instead.
 *
 * A cached rejection is the failure worth spending a closure on: one bad start — a `.wasm` not yet
 * staged beside the bundle, a machine momentarily out of address space — would otherwise wedge
 * every STEP file in the process at `failed` for as long as it runs, and only a change to a file's
 * bytes ever re-queues it.
 */
export function makeOcctLoader(factory: () => Promise<Occt>): () => Promise<Occt> {
  let pending: Promise<Occt> | null = null
  return () => {
    if (pending === null) {
      pending = factory().catch((error: unknown) => {
        // Never cache a rejection: a cached one would wedge every STEP file in this process.
        pending = null
        throw error
      })
    }
    return pending
  }
}

/** One loader for the whole package: one module instance, and one WASM heap, per process. */
const loadOcct = makeOcctLoader(occtimportjs)

/** Every STEP file, of every part 21 flavour, opens with these thirteen bytes. */
const STEP_MAGIC = 'ISO-10303-21;'
const MAGIC = new TextEncoder().encode(STEP_MAGIC)
/** Tab, newline, carriage return and space — the only bytes skipped ahead of the magic. */
const SKIPPABLE = new Set([0x09, 0x0a, 0x0d, 0x20])

/** Thirteen bytes as Latin-1, with anything unprintable shown as a dot, for the error's details. */
function describe(bytes: Uint8Array, from: number): string {
  let out = ''
  for (let i = 0; i < MAGIC.length; i++) {
    const byte = bytes[from + i]
    if (byte === undefined) break
    out += (byte >= 0x20 && byte <= 0x7e) || byte >= 0xa0 ? String.fromCharCode(byte) : '.'
  }
  return out
}

/**
 * Refuses anything that is not a STEP file **before** OCCT is asked to look at it.
 *
 * The guard is here rather than left to the parser because reaching OCCT with the wrong bytes costs
 * the whole per-process floor — a module instantiation and a ~244 MB peak — to arrive at the same
 * refusal. Thirteen byte comparisons get there first, and they get there with a message that says
 * what the file actually starts with.
 *
 * The leading-whitespace tolerance is **insurance, not a measured need**: all ten STEP files in the
 * reference library carry the sequence at offset 0, with no BOM and nothing in front of it. It is
 * here because it costs four byte comparisons and the alternative is refusing a file OCCT reads.
 */
function assertStepMagic(bytes: Uint8Array): void {
  let start = 0
  while (start < bytes.length && SKIPPABLE.has(bytes[start]!)) start++
  for (let i = 0; i < MAGIC.length; i++) {
    if (bytes[start + i] === MAGIC[i]) continue
    throw new AppError(
      'Validation',
      `this file does not begin ${STEP_MAGIC}, so it is not a STEP file`,
      { found: describe(bytes, start) },
    )
  }
}

/**
 * Turns OCCT's array of indexed meshes into the one triangle soup the rasterizer reads.
 *
 * Two shape mismatches, both measured, both handled by the one loop. `renderMesh` wants a single
 * `Mesh` — a `Float32Array` of `triangleCount * 9` floats — while `ReadStepFile` returns an *array*
 * of *indexed* meshes, one per solid. And the arrays it returns are plain JavaScript number arrays
 * rather than typed ones, on every file measured, so de-indexing does the float conversion for free
 * and there is no second representation to pay for.
 *
 * **`assertMeshFits` over-charges here, and that is left alone on purpose.** `meshBytesFor` is
 * `vertexCount * 12 + triangleCount * 36`, and this adapter allocates no vertex table at all — it
 * de-indexes straight into `positions`. So the check is conservative by the whole vertex term. That
 * is the correct direction to be wrong in, and it costs nothing on the reference sample, whose
 * largest `positions` array is 796 932 bytes against a 256 MB ceiling. Passing `0` for the vertices
 * instead would make the number exact and the ceiling looser than the one every other parser is
 * measured against, for no gain.
 *
 * **What it does not bound is the parse.** By the time this function runs OCCT has already
 * tessellated; the triangle count is a result, not a prediction. See `assertMeshFits` and
 * `DEFAULT_MAX_MESH_BYTES` in `limits.ts`, which say the same thing from the other side.
 *
 * **Both failures throw rather than returning `null`**, and the difference is the whole point.
 * `null` from the `readMesh` arm is a message-less `unsupported` row, which is terminal and only
 * re-queued by a change to the file's bytes. A `success: false` is "this should have rendered and
 * did not", and so is a file that parsed into no surfaces at all — both are `failed` with something
 * to read in the `error` column.
 */
function occtToMesh(result: OcctResult, limits: MeshLimits | undefined): Mesh {
  if (!result?.success || !result.meshes?.length) {
    throw new AppError('Validation', 'the STEP file could not be read by the geometry kernel', {
      // Present only if this build ever supplies one; the measured failures carry no such field.
      occtError: result?.error,
    })
  }

  let triangleCount = 0
  let vertexCount = 0
  for (const mesh of result.meshes) {
    triangleCount += mesh.index.array.length / 3
    vertexCount += mesh.attributes.position.array.length / 3
  }
  if (triangleCount < 1) {
    throw new AppError('Validation', 'the STEP file parsed but describes no surfaces to draw', {
      meshes: result.meshes.length,
    })
  }
  assertMeshFits(vertexCount, triangleCount, limits)

  const positions = allocateMesh(triangleCount * 9, 'positions')
  let out = 0
  for (const mesh of result.meshes) {
    const points = mesh.attributes.position.array
    const index = mesh.index.array
    for (let i = 0; i < index.length; i++) {
      const vertex = index[i]! * 3
      positions[out++] = points[vertex]!
      positions[out++] = points[vertex + 1]!
      positions[out++] = points[vertex + 2]!
    }
  }
  return { positions, triangleCount }
}

/**
 * The two filesystem calls this module makes, in one object so a test can replace them.
 *
 * Not an abstraction anybody asked for: it exists because the property worth pinning about
 * `readStepBytes` is an *order*, and an order between two direct `node:fs` calls is not observable
 * from anywhere. There is nothing to spy on a bare `statSync`/`readFileSync` pair, and the obvious
 * substitute — a path that stats and fails to read — does not exist portably, because `statSync`
 * on an absent path throws `ENOENT` rather than answering with a size.
 *
 * Declared through a named type rather than inferred, and the difference is not cosmetic:
 * `readFileSync` returns a node `Buffer`, so an inferred `typeof STEP_IO` would demand every
 * substitute return one too — and nothing that is merely standing in for a read has any business
 * constructing a `Buffer`. `Uint8Array` is also what this module actually needs, since it is what
 * `ReadStepFile` is handed.
 */
export type StepIo = {
  size: (path: string) => number
  read: (path: string) => Uint8Array
}

const STEP_IO: StepIo = {
  size: (path) => statSync(path).size,
  read: (path) => readFileSync(path),
}

/**
 * The file's bytes, or the ceiling's refusal — **and the refusal costs no read at all.**
 *
 * The whole job of this function is the order of its two lines. The size comes from `statSync`
 * rather than from the buffer's `length`, because a check on the buffer is a check after the file
 * is already resident, and holding the file is exactly the cost `assertStepFileFits` exists to
 * avoid. `parseStepFile` is what makes it worth avoiding: `ReadStepFile` is whole-buffer, so the
 * file is resident *twice* one line later.
 *
 * `io` defaults to the real filesystem and production never passes it. It is a parameter so the
 * ordering can be observed by a reader that throws if it is ever reached — see the test named for
 * it, which touches no path and needs no fixture.
 */
export function readStepBytes(
  absPath: string,
  limits: MeshLimits | undefined,
  io: StepIo = STEP_IO,
): Uint8Array {
  assertStepFileFits(io.size(absPath), limits)
  return io.read(absPath)
}

/**
 * Parses a STEP file from disk, holding it whole — the one parser here that does.
 *
 * **This arm is the exception to everything `readMesh`'s docblock says about memory**, and the
 * numbers are worth carrying rather than summarising. `ReadStepFile` is whole-buffer: there is no
 * streaming form, and the bytes are copied into the WASM heap, so at the moment of the call the
 * file is resident **twice** — once as the `Uint8Array` read here, once inside the module. That is
 * the small part. The large part is a per-process floor of **~244 MB of peak RSS during any parse**,
 * measured across the reference library's ten files: an 8 KB file with twelve triangles cost
 * 207 MB, the largest cost 278 MB, and fitting the extremes gives an intercept of ~243 MB. It is
 * not the mesh (the largest `positions` in that sample is 796 932 bytes), not V8 garbage (a 128x
 * range of `--max-old-space-size` moves it under 2 %), and not the WASM linear heap (30–62 MB).
 * ~100 MB of it is attributed to no counter the spike's harness could read.
 *
 * The one good property: it is paid **per process, not per file**. Peak RSS stayed flat across all
 * ten files and a second pass over the same ten, and a process that never parses a STEP file pays
 * nothing, because the module is instantiated on first use.
 *
 * **And the parse is synchronous once it starts** — 217–1 307 ms cold, ~30 % less warm, with no
 * yield in it. On the Deno server that is a stall in a process doing nothing else; in the Electron
 * shell the preview queue ticks on the main process's own thread, so it is a stall the IPC table
 * and the `spm://` thumbnail handler share. `desktop/src/previews.ts` carries that note where the
 * concurrency is set.
 *
 * The `await` is for the module, not for the file: `loadOcct()` resolves instantly after the first
 * call, and the bytes are already in hand when it is reached — got there by `readStepBytes`, whose
 * `readFileSync` is the other blocking call in this function. So on the Electron main process the
 * stall the IPC table shares is the read **and** the parse, not the parse alone.
 *
 * **What bounds any of this is `limits.maxStepBytes`, and it bounds the input rather than the
 * cost.** `assertMeshFits` runs below, after OCCT has tessellated, so on this arm it is a check on
 * a result and not on a prediction; nothing it does lowers the floor above. `readStepBytes` is the
 * only guard that runs before a byte is spent, it is keyed on the file's size on disk, and a size
 * is a poor proxy for what a STEP file costs — see `DEFAULT_MAX_STEP_BYTES`, which says how poor.
 */
export async function parseStepFile(absPath: string, limits?: MeshLimits): Promise<Mesh> {
  const bytes = readStepBytes(absPath, limits)
  assertStepMagic(bytes)
  const occt = await loadOcct()
  return occtToMesh(occt.ReadStepFile(bytes, null), limits)
}
