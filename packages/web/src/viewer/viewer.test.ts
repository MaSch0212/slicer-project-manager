import { describe, expect, it, vi } from 'vitest'
import { Mesh } from 'three'
import { binaryStl, cube, obj, pyramid, threeMf } from '../../e2e/fixtures'
import {
  buildModel,
  disposeSubtree,
  fetchModel,
  materialise,
  ModelLoadError,
  parseModel,
  triangleCount,
} from './load-model'
import {
  extensionOf,
  formatOfExtension,
  judgeFile,
  PEAK_BUDGET_BYTES,
  PEAK_COST,
  sizeLimit,
  SUPPORTED_FORMATS,
} from './model-kind'
import { fitDistance } from './scene'

// Ported from legacy features/viewer/viewer.page.spec.ts where the assertion is about logic and
// still applies: the format table and its size gate, the loader per extension, the empty and
// unparseable cases, the download (progress, 404, bodyless, short and long bodies), the framing
// maths. Dropped, with the reason: everything that drove the Angular component through a fake
// WebGL renderer (frame loop, resize observer, context loss, focus, key handling, disposal order);
// those need a GL context and a layout engine, so the viewer page is covered by the headless
// screenshot run instead (e2e/library-screenshots.spec.ts), which draws a real model.

const asBuffer = (bytes: Uint8Array): ArrayBuffer =>
  bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer

describe('which files the viewer opens', () => {
  it('maps STL, OBJ and 3MF by extension, in any case', () => {
    expect(formatOfExtension(extensionOf('Part.STL'))).toBe('stl')
    expect(formatOfExtension(extensionOf('a.b.obj'))).toBe('obj')
    expect(formatOfExtension(extensionOf('x.3mf'))).toBe('3mf')
    expect(extensionOf('noextension')).toBe('')
    expect(SUPPORTED_FORMATS).toEqual(['STL', 'OBJ', '3MF'])
  })

  it('judges a model by its format', () => {
    expect(judgeFile({ name: 'a.stl', kind: 'model' })).toMatchObject({
      status: 'viewable',
      format: 'stl',
    })
    expect(judgeFile({ name: 'a.3mf', kind: 'model' })).toMatchObject({ format: '3mf' })
  })

  // Migration spec 4.1: STEP is listed and kept but has no preview, so the viewer says so and does
  // not fetch the file.
  it('answers STEP with its own verdict, whatever the kind says', () => {
    expect(judgeFile({ name: 'hinge.step', kind: 'model' })).toEqual({ status: 'step' })
    expect(judgeFile({ name: 'HINGE.STP', kind: 'model' })).toEqual({ status: 'step' })
    expect(judgeFile({ name: 'hinge.step', kind: 'other' })).toEqual({ status: 'step' })
  })

  it('reports an extension no loader handles, and names the whole file when there is none', () => {
    expect(judgeFile({ name: 'a.ply', kind: 'model' })).toEqual({
      status: 'unsupported',
      extension: '.ply',
    })
    expect(judgeFile({ name: 'README', kind: 'model' })).toEqual({
      status: 'unsupported',
      extension: 'README',
    })
  })

  it('refuses a slicer project on its kind, whatever its extension says', () => {
    expect(judgeFile({ name: 'plate.3mf', kind: 'slicer_project' })).toEqual({
      status: 'slicerProject',
    })
  })

  it('turns away a file the server did not call a model', () => {
    expect(judgeFile({ name: 'a.stl', kind: 'other' })).toEqual({
      status: 'unsupported',
      extension: '.stl',
    })
  })

  // The numbers are properties of the loaders, ported unchanged: a 3MF is inflated and turned into
  // a DOM, an OBJ is decoded and split, an STL is parsed in place.
  it('prices the three formats in the order they were measured to cost', () => {
    expect(PEAK_COST.stl).toBeLessThan(PEAK_COST.obj)
    expect(PEAK_COST.obj).toBeLessThan(PEAK_COST['3mf'])
    expect(sizeLimit('stl')).toBeGreaterThan(sizeLimit('obj'))
    expect(sizeLimit('obj')).toBeGreaterThan(sizeLimit('3mf'))
  })

  it('holds a 3MF and an STL of identical size to different lines', () => {
    const size = 5_000_000
    expect(size).toBeLessThan(sizeLimit('stl'))
    expect(size).toBeGreaterThan(sizeLimit('3mf'))
    expect(sizeLimit('stl') * PEAK_COST.stl).toBeCloseTo(PEAK_BUDGET_BYTES)
  })

  it('carries the size line in the verdict', () => {
    const verdict = judgeFile({ name: 'a.obj', kind: 'model' })
    expect(verdict).toMatchObject({ status: 'viewable', limitBytes: sizeLimit('obj') })
  })
})

describe('building a model from bytes', () => {
  it.each([
    ['stl', binaryStl(cube())],
    ['obj', obj(cube())],
    ['3mf', threeMf(cube())],
  ] as const)('parses %s into real geometry', (format, bytes) => {
    const model = buildModel(format, asBuffer(bytes))
    expect(triangleCount(model)).toBe(12)
    disposeSubtree(model)
  })

  it('uses a loader that matches the format', () => {
    expect(parseModel('stl', asBuffer(binaryStl(pyramid()))).type).toBe('Mesh')
    expect(triangleCount(parseModel('obj', asBuffer(obj(pyramid()))))).toBe(6)
  })

  it('reports a file that will not parse, as a parse failure', () => {
    expect(() => buildModel('3mf', asBuffer(new TextEncoder().encode('not a zip')))).toThrow(
      ModelLoadError,
    )
    try {
      buildModel('3mf', asBuffer(new TextEncoder().encode('not a zip')))
    } catch (error) {
      expect((error as ModelLoadError).reason).toBe('parse')
    }
  })

  it('reports a model with no triangles instead of drawing nothing', () => {
    const empty = obj({ vertices: [[0, 0, 0]], triangles: [] })
    try {
      buildModel('obj', asBuffer(empty))
      expect.unreachable()
    } catch (error) {
      expect((error as ModelLoadError).reason).toBe('empty')
    }
  })

  it('draws every format in one material, one instance per mesh', () => {
    const model = buildModel('3mf', asBuffer(threeMf(cube())))
    const materials = new Set<unknown>()
    model.traverse((node) => {
      if ((node as Mesh).isMesh) materials.add((node as Mesh).material)
    })
    expect(materials.size).toBe(1)
    const [material] = [...materials] as { flatShading: boolean; color: { getHex(): number } }[]
    expect(material!.flatShading).toBe(true)
    expect(material!.color.getHex()).toBe(0xefdcc6)
    // Applying it again replaces rather than stacking.
    materialise(model)
  })

  it('frees geometry and material of a subtree', () => {
    const model = parseModel('stl', asBuffer(binaryStl(cube())))
    materialise(model)
    const mesh = model as Mesh
    const geometry = vi.spyOn(mesh.geometry, 'dispose')
    const material = vi.spyOn(mesh.material as { dispose(): void }, 'dispose')
    disposeSubtree(model)
    expect(geometry).toHaveBeenCalled()
    expect(material).toHaveBeenCalled()
  })
})

/** A response whose body arrives in the given chunks. */
function streamed(chunks: Uint8Array[], status = 200): Response {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk)
      controller.close()
    },
  })
  return new Response(body, { status })
}

describe('downloading a model', () => {
  const signal = () => new AbortController().signal
  const bytes = (n: number, fill = 1) => new Uint8Array(n).fill(fill)

  it('reports progress against the size the API gave, and returns exactly the bytes', async () => {
    const onProgress = vi.fn()
    const fetchFn = vi.fn().mockResolvedValue(streamed([bytes(40), bytes(60, 2)]))
    const result = await fetchModel('/raw', 100, signal(), onProgress, fetchFn)
    expect(fetchFn).toHaveBeenCalledWith(
      '/raw',
      expect.objectContaining({ credentials: 'same-origin' }),
    )
    expect(onProgress.mock.calls.map((call) => call[0])).toEqual([0.4, 1])
    const view = new Uint8Array(result)
    expect(view).toHaveLength(100)
    expect(view[0]).toBe(1)
    expect(view[99]).toBe(2)
  })

  it.each([
    ['shorter', 100, 90],
    ['longer', 100, 130],
  ])(
    'hands over what arrived when the DTO size is %s than the body',
    async (_name, hint, actual) => {
      const result = await fetchModel(
        '/raw',
        hint,
        signal(),
        () => {},
        () => Promise.resolve(streamed([bytes(actual / 2), bytes(actual / 2)])),
      )
      expect(result.byteLength).toBe(actual)
    },
  )

  it('reports no fraction when the size is not known', async () => {
    const onProgress = vi.fn()
    await fetchModel('/raw', 0, signal(), onProgress, () => Promise.resolve(streamed([bytes(10)])))
    expect(onProgress).toHaveBeenCalledWith(null)
  })

  it('loads a response that has no readable stream at all', async () => {
    const response = {
      ok: true,
      status: 200,
      body: null,
      arrayBuffer: () => Promise.resolve(new ArrayBuffer(8)),
    }
    const result = await fetchModel(
      '/raw',
      8,
      signal(),
      () => {},
      () => Promise.resolve(response as never),
    )
    expect(result.byteLength).toBe(8)
  })

  const reasonOf = async (promise: Promise<unknown>) =>
    promise.then(
      () => undefined,
      (error: ModelLoadError) => error.reason,
    )

  it('reports a 404 as a missing file, not as a bad connection', async () => {
    const reason = await reasonOf(
      fetchModel(
        '/raw',
        1,
        signal(),
        () => {},
        () => Promise.resolve(new Response('', { status: 404 })),
      ),
    )
    expect(reason).toBe('missing')
  })

  it('reports a network failure, a server error and a connection that drops mid-body', async () => {
    expect(
      await reasonOf(
        fetchModel(
          '/raw',
          1,
          signal(),
          () => {},
          () => Promise.reject(new TypeError('x')),
        ),
      ),
    ).toBe('fetch')
    expect(
      await reasonOf(
        fetchModel(
          '/raw',
          1,
          signal(),
          () => {},
          () => Promise.resolve(new Response('', { status: 500 })),
        ),
      ),
    ).toBe('fetch')
    const dropping = new Response(
      new ReadableStream({
        pull(controller) {
          controller.error(new Error('reset'))
        },
      }),
    )
    expect(
      await reasonOf(
        fetchModel(
          '/raw',
          10,
          signal(),
          () => {},
          () => Promise.resolve(dropping),
        ),
      ),
    ).toBe('fetch')
  })

  it('abandons the download when the page goes away', async () => {
    const controller = new AbortController()
    const never = new Response(new ReadableStream({ start() {} }))
    const pending = fetchModel(
      '/raw',
      10,
      controller.signal,
      () => {},
      () => Promise.resolve(never),
    )
    controller.abort()
    expect(await reasonOf(pending)).toBe('fetch')
  })
})

describe('framing', () => {
  // Ported: "pulls the camera back until the whole model is inside the frustum", "frames by the
  // tighter axis when the viewport is portrait".
  it('pulls back far enough for the sphere to fit, with a margin', () => {
    const distance = fitDistance(10, 50, 1)
    const halfFov = (50 * Math.PI) / 180 / 2
    // The sphere subtends exactly the half-angle at radius / sin(halfFov); the margin adds to that.
    expect(distance).toBeGreaterThan(10 / Math.sin(halfFov))
    expect(distance).toBeLessThan(10 / Math.sin(halfFov) / 0.8)
  })

  it('is limited by the width on a portrait stage and by the height on a landscape one', () => {
    const square = fitDistance(10, 50, 1)
    expect(fitDistance(10, 50, 0.5)).toBeGreaterThan(square)
    expect(fitDistance(10, 50, 2)).toBeCloseTo(square)
  })

  it('scales with the size of the model', () => {
    expect(fitDistance(20, 50, 1.5)).toBeCloseTo(fitDistance(10, 50, 1.5) * 2)
  })
})
