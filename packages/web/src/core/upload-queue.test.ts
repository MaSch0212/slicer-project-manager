import { describe, expect, it, vi } from 'vitest'
import { ApiError } from './api/error'
import { createUploadQueue } from './upload-queue'

// Ported from the former Angular project-detail.page.spec.ts: "uploads the File itself as a Blob" and "renders a
// quota failure with the actual numbers". The queue is new (several files, progress, retry); the two
// legacy assertions are kept as the first two cases.

const file = (name: string, size = 10) => new File([new Uint8Array(size)], name)

function deferred() {
  let resolve!: () => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<void>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

describe('upload queue', () => {
  it('sends the File itself, not a stream', async () => {
    const upload = vi.fn().mockResolvedValue({})
    const queue = createUploadQueue({ upload })
    const model = file('model.stl')
    queue.add([model])
    await vi.waitFor(() => expect(queue.busy()).toBe(false))
    expect(upload.mock.calls[0]![0]).toBe(model)
  })

  it('shows a quota failure with the actual numbers', async () => {
    const quota = new ApiError('QuotaExceeded', 'over', {
      status: 413,
      details: { usageBytes: 1024, quotaBytes: 2048, incomingBytes: 4096 },
    })
    const queue = createUploadQueue({ upload: vi.fn().mockRejectedValue(quota) })
    queue.add([file('big.stl')])
    await vi.waitFor(() => expect(queue.items()[0]?.status).toBe('failed'))
    expect(queue.items()[0]!.error).toBe(
      'This upload would exceed your quota (1.0 kB of 2.0 kB used)',
    )
  })

  it('uploads one file at a time, in the order they were added', async () => {
    const gates = [deferred(), deferred(), deferred()]
    let started = 0
    const upload = vi.fn(() => gates[started++]!.promise)
    const queue = createUploadQueue({ upload })
    queue.add([file('a'), file('b'), file('c')])

    expect(queue.items().map((i) => i.status)).toEqual(['uploading', 'queued', 'queued'])
    expect(upload).toHaveBeenCalledTimes(1)
    gates[0]!.resolve()
    await vi.waitFor(() => expect(upload).toHaveBeenCalledTimes(2))
    expect(queue.items().map((i) => i.status)).toEqual(['done', 'uploading', 'queued'])
    gates[1]!.resolve()
    gates[2]!.resolve()
    await vi.waitFor(() => expect(queue.busy()).toBe(false))
    expect(queue.items().map((i) => i.status)).toEqual(['done', 'done', 'done'])
    expect(upload.mock.calls.map((call) => (call as unknown as [File])[0].name)).toEqual([
      'a',
      'b',
      'c',
    ])
  })

  it('reports progress per file', async () => {
    const gate = deferred()
    const upload = vi.fn((_file: File, onProgress: (fraction: number) => void) => {
      onProgress(0.25)
      onProgress(0.75)
      return gate.promise
    })
    const queue = createUploadQueue({ upload })
    queue.add([file('a')])
    expect(queue.items()[0]!.progress).toBe(0.75)
    gate.resolve()
    await vi.waitFor(() => expect(queue.items()[0]!.status).toBe('done'))
    expect(queue.items()[0]!.progress).toBe(1)
  })

  it('carries on after a failure, keeps the reason, and retries only that file', async () => {
    const upload = vi
      .fn()
      .mockRejectedValueOnce(new ApiError('Internal', 'x'))
      .mockResolvedValue({})
    const onFileDone = vi.fn()
    const queue = createUploadQueue({ upload, onFileDone })
    queue.add([file('bad'), file('good')])
    await vi.waitFor(() => expect(queue.busy()).toBe(false))
    expect(queue.items().map((i) => i.status)).toEqual(['failed', 'done'])
    expect(queue.items()[0]!.error).toBe('Something went wrong')
    expect(onFileDone).toHaveBeenCalledTimes(1)

    queue.retry(queue.items()[0]!.id)
    await vi.waitFor(() => expect(queue.items()[0]!.status).toBe('done'))
    expect(queue.items()[0]!.error).toBeUndefined()
    expect(onFileDone).toHaveBeenCalledTimes(2)
  })

  it('clears finished rows and leaves queued and running ones', async () => {
    const gate = deferred()
    const upload = vi.fn().mockResolvedValueOnce({}).mockReturnValueOnce(gate.promise)
    const queue = createUploadQueue({ upload })
    queue.add([file('done')])
    await vi.waitFor(() => expect(queue.items()[0]!.status).toBe('done'))
    queue.add([file('running'), file('waiting')])
    queue.clearFinished()
    expect(queue.items().map((i) => i.name)).toEqual(['running', 'waiting'])
    gate.resolve()
  })

  it('ignores a retry for a file that is already done', async () => {
    const upload = vi.fn().mockResolvedValue({})
    const queue = createUploadQueue({ upload })
    queue.add([file('a')])
    await vi.waitFor(() => expect(queue.busy()).toBe(false))
    queue.retry(queue.items()[0]!.id)
    expect(upload).toHaveBeenCalledTimes(1)
  })
})
