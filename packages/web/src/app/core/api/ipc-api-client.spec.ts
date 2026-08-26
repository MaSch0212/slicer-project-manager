import { describe, expect, it, vi } from 'vitest'
import { AppError } from '@spm/contract/errors.ts'
import { BRIDGE_MISSING, IpcApiClient, desktopBridge, type IpcResult } from './ipc-api-client'

function bridgeReturning(result: IpcResult) {
  return { invoke: vi.fn().mockResolvedValue(result) }
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
    const bridge = { invoke: vi.fn().mockRejectedValue(new Error('No handler registered')) }

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
     * Both `UploadBody` arms have to arrive as bytes. Measured in Electron 44.0.0: a `Blob`, a
     * `File` and a `ReadableStream` all cross `ipcRenderer.invoke` as an empty plain object, with
     * no error raised — so a client that forwarded the body untouched would have written
     * zero-byte files and reported success.
     */
    it('reads the blob arm into a Uint8Array of the same bytes', async () => {
      const bridge = bridgeReturning({ ok: true, value: { id: 'f1' } })
      const bytes = new Uint8Array([115, 111, 108, 105, 100])

      await new IpcApiClient(bridge).files.upload('p1', 'cube.stl', { blob: new Blob([bytes]) })

      const [path, args] = bridge.invoke.mock.calls[0]!
      expect(path).toBe('files.upload')
      expect(args[0]).toBe('p1')
      expect(args[1]).toBe('cube.stl')
      expect(args[2]).toBeInstanceOf(Uint8Array)
      expect(Array.from(args[2] as Uint8Array)).toEqual([115, 111, 108, 105, 100])
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
      expect(Array.from(args[0] as Uint8Array)).toEqual([1, 2, 3, 4])
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

    it('rejects an object on window.spm that has no invoke', () => {
      const globals = globalThis as { spm?: unknown }
      const saved = globals.spm
      globals.spm = {}
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
      const installed = { invoke: vi.fn() }
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
