import { describe, expect, it, vi } from 'vitest'
import { AppError } from '@spm/contract/errors.ts'
import {
  BRIDGE_MISSING,
  FILE_REF_KEY,
  IpcApiClient,
  desktopBridge,
  type IpcResult,
} from './ipc-api-client'

/**
 * `canStreamFromDisk: () => false` is a real preload's answer for a `Blob` or a script-built
 * `File` (`webUtils.getPathForFile` returns `''` for both, measured), so this is the buffering
 * arm. Tests that want the streaming arm flip it.
 */
function bridgeReturning(result: IpcResult) {
  return {
    canStreamFromDisk: vi.fn().mockReturnValue(false),
    invoke: vi.fn().mockResolvedValue(result),
  }
}

describe('IpcApiClient', () => {
  it('forwards the path and the argument list, and returns the value', async () => {
    const bridge = bridgeReturning({ ok: true, value: [{ id: 'p1' }] })
    const client = new IpcApiClient(bridge)

    const projects = await client.projects.list({ search: 'brack', tags: ['petg'] })

    expect(bridge.invoke).toHaveBeenCalledWith('projects.list', [
      { search: 'brack', tags: ['petg'] },
    ])
    // The value has to reach the caller: a transport that resolved undefined for everything
    // would pass a call-shape assertion on its own.
    expect(projects).toEqual([{ id: 'p1' }])
  })

  it('sends an empty argument list for a no-argument call', async () => {
    const bridge = bridgeReturning({ ok: true, value: { requiresAuth: false } })
    await new IpcApiClient(bridge).capabilities()
    expect(bridge.invoke).toHaveBeenCalledWith('capabilities', [])
  })

  /**
   * Constraint 5, and the assertion the task brief singles out: not that something throws, but
   * that the thing thrown is an `AppError` carrying the same `code` the server sends over HTTP.
   *
   * The envelope below is exactly what `toFailure` in packages/desktop/src/ipc.ts produces for
   * an `AppError('QuotaExceeded', …)` out of core — the same error `packages/core`'s
   * `assertWithinQuota` throws and the same one `HttpApiClient` rebuilds from the JSON envelope.
   */
  it('rethrows a tagged failure as an AppError with its code, message and details', async () => {
    const bridge = bridgeReturning({
      ok: false,
      error: {
        code: 'QuotaExceeded',
        message: 'storage quota exceeded',
        details: { usageBytes: 10, quotaBytes: 12, incomingBytes: 5 },
      },
    })

    const error = await new IpcApiClient(bridge).files
      .upload('p1', 'a.stl', { blob: new Blob([new Uint8Array([1])]) })
      .catch((thrown: unknown) => thrown)

    expect(error).toBeInstanceOf(AppError)
    expect((error as AppError).code).toBe('QuotaExceeded')
    expect((error as AppError).message).toBe('storage quota exceeded')
    expect((error as AppError).details).toEqual({
      usageBytes: 10,
      quotaBytes: 12,
      incomingBytes: 5,
    })
  })

  it('turns a rejected channel into an AppError rather than letting a raw Error escape', async () => {
    // The main process answers failures as values, so this only happens when the channel itself
    // is gone. Callers must still see one failure shape, exactly as HttpApiClient promises.
    const bridge = {
      canStreamFromDisk: vi.fn().mockReturnValue(false),
      invoke: vi.fn().mockRejectedValue(new Error('No handler registered')),
    }

    const error = await new IpcApiClient(bridge).capabilities().catch((thrown: unknown) => thrown)

    expect(error).toBeInstanceOf(AppError)
    expect((error as AppError).code).toBe('Internal')
    expect((error as AppError).message).toBe('No handler registered')
  })

  it('refuses a result that is neither arm of the envelope', async () => {
    const bridge = { invoke: vi.fn().mockResolvedValue({ value: 'no ok field' }) }
    const error = await new IpcApiClient(bridge as never).account
      .me()
      .catch((thrown: unknown) => thrown)
    expect(error).toBeInstanceOf(AppError)
    expect((error as AppError).code).toBe('Internal')
  })

  describe('uploads', () => {
    /**
     * A picked file is handed over, not copied. This is the arm every upload the UI can start
     * takes, and the reason the transport has no size ceiling: the bytes stay on disk and the
     * main process streams them.
     *
     * The `File` itself and never a path — a path this world could write would let a compromised
     * renderer have the main process open any file the user can read (constraint 4). The preload
     * turns it into a path in its own world, inside the same `invoke`.
     */
    it('hands the File itself over for a file that is backed by one, and never reads it', async () => {
      const bridge = bridgeReturning({ ok: true, value: { id: 'f1' } })
      bridge.canStreamFromDisk.mockReturnValue(true)
      const picked = new File([new Uint8Array([1, 2, 3])], 'cube.stl')
      // If this is ever called, the file was buffered after all.
      const arrayBuffer = vi.spyOn(picked, 'arrayBuffer')

      await new IpcApiClient(bridge).files.upload('p1', 'cube.stl', { blob: picked })

      const [path, args] = bridge.invoke.mock.calls[0]!
      expect(path).toBe('files.upload')
      expect(bridge.canStreamFromDisk).toHaveBeenCalledWith(picked)
      // The same object, by identity: a copy would have no file behind it by the time the
      // preload looked.
      expect((args[2] as Record<string, unknown>)[FILE_REF_KEY]).toBe(picked)
      // And no path anywhere in the arguments — this world never learns one.
      expect(JSON.stringify(args)).not.toContain('localPath')
      expect(arrayBuffer).not.toHaveBeenCalled()
    })

    it('hands over a picked archive the same way', async () => {
      const bridge = bridgeReturning({ ok: true, value: { projectsExtracted: 1 } })
      bridge.canStreamFromDisk.mockReturnValue(true)
      const picked = new File([new Uint8Array([1])], 'lib.zip')

      await new IpcApiClient(bridge).importer.curaManagerZip({ blob: picked })

      expect((bridge.invoke.mock.calls[0]![1][0] as Record<string, unknown>)[FILE_REF_KEY]).toBe(
        picked,
      )
    })

    /**
     * The fallback, for a body with no file behind it. Measured in Electron 44.0.0: a `Blob`, a
     * `File` and a `ReadableStream` all cross `ipcRenderer.invoke` as an empty plain object, with
     * no error raised — so a client that forwarded the body untouched would have written
     * zero-byte files and reported success.
     */
    it('reads the blob arm into a Uint8Array when there is no file behind it', async () => {
      const bridge = bridgeReturning({ ok: true, value: { id: 'f1' } })
      const bytes = new Uint8Array([115, 111, 108, 105, 100])

      await new IpcApiClient(bridge).files.upload('p1', 'cube.stl', { blob: new Blob([bytes]) })

      const [path, args] = bridge.invoke.mock.calls[0]!
      expect(path).toBe('files.upload')
      expect(args[0]).toBe('p1')
      expect(args[1]).toBe('cube.stl')
      expect((args[2] as { bytes: Uint8Array }).bytes).toBeInstanceOf(Uint8Array)
      expect(Array.from((args[2] as { bytes: Uint8Array }).bytes)).toEqual([
        115, 111, 108, 105, 100,
      ])
    })

    it('drains the stream arm into the same bytes', async () => {
      const bridge = bridgeReturning({ ok: true, value: { projectsExtracted: 0 } })
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new Uint8Array([1, 2]))
          controller.enqueue(new Uint8Array([3, 4]))
          controller.close()
        },
      })

      await new IpcApiClient(bridge).importer.curaManagerZip({ stream, sizeBytes: 4 })

      const [path, args] = bridge.invoke.mock.calls[0]!
      expect(path).toBe('importer.curaManagerZip')
      expect(Array.from((args[0] as { bytes: Uint8Array }).bytes)).toEqual([1, 2, 3, 4])
    })

    /**
     * Reading the body happens in an argument position, outside `invoke`'s own try, so a
     * rejection there used to escape as itself: measured, `files.upload` threw a bare
     * `RangeError` with `isAppError` false and `code` undefined. Both callers of these two
     * methods branch on `isAppError` (`import.page.ts:134`, `project-detail.page.ts:679`), so
     * the user got the generic message and no diagnosis, and the invariant this client documents
     * two lines above was simply untrue.
     *
     * `RangeError` is what Chromium raises for a buffer larger than the renderer can allocate —
     * the failure mode of the fallback arm — and `DOMException: NotFoundError` for a file that
     * moved between the picker and the read.
     */
    it.each([
      [
        'a buffer too large for the renderer',
        new RangeError('Array buffer allocation failed'),
        'Array buffer allocation failed',
      ],
      [
        'a file that moved after it was picked',
        // Not `instanceof Error` in this test environment, measured: the assertion below is on
        // the fragment because the client falls through to `String(error)` for it, which yields
        // `NotFoundError: not found`. Either branch has to produce an AppError, which is the
        // property under test.
        new DOMException('not found', 'NotFoundError'),
        'not found',
      ],
    ])('reports %s as an AppError, not as itself', async (_name, thrown, fragment) => {
      const bridge = bridgeReturning({ ok: true, value: { id: 'f1' } })
      const unreadable = {
        arrayBuffer: () => Promise.reject(thrown),
      } as unknown as Blob

      for (const call of [
        () => new IpcApiClient(bridge).files.upload('p1', 'a.stl', { blob: unreadable }),
        () => new IpcApiClient(bridge).importer.curaManagerZip({ blob: unreadable }),
      ]) {
        const error = await call().catch((caught: unknown) => caught)
        expect(error).toBeInstanceOf(AppError)
        expect((error as AppError).code).toBe('Internal')
        expect((error as AppError).message).toContain(fragment)
      }
      // And nothing was sent: a half-read body must not reach the main process.
      expect(bridge.invoke).not.toHaveBeenCalled()
    })
  })

  describe('desktopBridge', () => {
    it('reports a missing preload as an AppError, not a TypeError on undefined', async () => {
      const globals = globalThis as { spm?: unknown }
      const saved = globals.spm
      delete globals.spm
      try {
        expect(() => desktopBridge()).toThrowError(
          expect.objectContaining({ code: 'Internal', message: BRIDGE_MISSING }),
        )
      } finally {
        if (saved !== undefined) globals.spm = saved
      }
    })

    // A half-built bridge is what a stale preload beside a newer renderer looks like, and the
    // `canStreamFromDisk` case matters more than it seems: without the check every upload would
    // take the buffering arm and nothing would say why.
    it.each([
      ['nothing at all', {}],
      ['no invoke', { canStreamFromDisk: vi.fn() }],
      ['no canStreamFromDisk', { invoke: vi.fn() }],
    ])('rejects a window.spm with %s', (_name, installed) => {
      const globals = globalThis as { spm?: unknown }
      const saved = globals.spm
      globals.spm = installed
      try {
        expect(() => desktopBridge()).toThrowError(BRIDGE_MISSING)
      } finally {
        if (saved === undefined) delete globals.spm
        else globals.spm = saved
      }
    })

    it('returns the bridge the preload installed', () => {
      const globals = globalThis as { spm?: unknown }
      const saved = globals.spm
      const installed = { canStreamFromDisk: vi.fn(), invoke: vi.fn() }
      globals.spm = installed
      try {
        expect(desktopBridge()).toBe(installed)
      } finally {
        if (saved === undefined) delete globals.spm
        else globals.spm = saved
      }
    })
  })
})
