import { createSignal } from 'solid-js'
import { errorMessage } from './i18n/errors'

export type UploadStatus = 'queued' | 'uploading' | 'done' | 'failed'

export type UploadItem = {
  id: number
  name: string
  size: number
  status: UploadStatus
  /** 0 to 1 while uploading, 1 once done. */
  progress: number
  /** The words for a failure, already translated. */
  error?: string
}

export type UploadQueueOptions = {
  /** Sends one file; reports 0..1 as it goes. Rejects with an `ApiError` on failure. */
  upload: (file: File, onProgress: (fraction: number) => void) => Promise<unknown>
  /** After each file that went through, so the page can refetch and show its thumbnail. */
  onFileDone?: (file: File) => void
  /** The words for a failure. Defaults to the shared `errorMessage`, which spells out a quota. */
  describe?: (error: unknown) => string
}

/**
 * Uploads files one after another and keeps what the page shows about them: a row per file with its
 * status, its progress and, on failure, why. One at a time on purpose: the library's quota is
 * checked per upload, so parallel sends would all pass the check and then collectively overshoot,
 * and a sequential queue also keeps the failure list in the order the user dropped the files.
 *
 * A failed file stays in the list with a reason and can be retried; the others carry on. Plain
 * signals, no reactive owner needed.
 */
export function createUploadQueue(options: UploadQueueOptions) {
  const describe = options.describe ?? errorMessage
  const [items, setItems] = createSignal<UploadItem[]>([])
  const files = new Map<number, File>()
  let nextId = 1
  let running = false

  const update = (id: number, patch: Partial<UploadItem>) =>
    setItems((list) => list.map((item) => (item.id === id ? { ...item, ...patch } : item)))

  async function run(): Promise<void> {
    if (running) return
    running = true
    try {
      for (;;) {
        const next = items().find((item) => item.status === 'queued')
        if (!next) return
        const file = files.get(next.id)!
        update(next.id, { status: 'uploading', progress: 0, error: undefined })
        try {
          await options.upload(file, (fraction) => update(next.id, { progress: fraction }))
          update(next.id, { status: 'done', progress: 1 })
          files.delete(next.id)
          options.onFileDone?.(file)
        } catch (error) {
          update(next.id, { status: 'failed', error: describe(error) })
        }
      }
    } finally {
      running = false
    }
  }

  return {
    items,

    /** Whether anything is waiting or in flight. */
    busy: () => items().some((item) => item.status === 'queued' || item.status === 'uploading'),

    add(newFiles: readonly File[]): void {
      const added: UploadItem[] = newFiles.map((file) => {
        const id = nextId++
        files.set(id, file)
        return { id, name: file.name, size: file.size, status: 'queued', progress: 0 }
      })
      setItems((list) => [...list, ...added])
      void run()
    },

    retry(id: number): void {
      if (!files.has(id)) return
      update(id, { status: 'queued', progress: 0, error: undefined })
      void run()
    },

    /** Drops the rows that are finished (done or failed); queued and running ones stay. */
    clearFinished(): void {
      setItems((list) =>
        list.filter((item) => {
          const finished = item.status === 'done' || item.status === 'failed'
          if (finished) files.delete(item.id)
          return !finished
        }),
      )
    },
  }
}

export type UploadQueue = ReturnType<typeof createUploadQueue>
