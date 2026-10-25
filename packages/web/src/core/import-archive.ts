import { createSignal } from 'solid-js'
import type { ZipImportResultDto } from '../api/generated'
import { api, type ApiClient } from './api/client'
import { isApiError } from './api/error'
import { t } from './i18n'
import { errorMessage } from './i18n/errors'
import { formatBytes } from './format-bytes'

/** True for a file name ending in .zip, in any case. */
export const isZipName = (name: string): boolean => /\.zip$/i.test(name)

/**
 * The words for a failed archive import. A collision or a refused archive carries a sentence that
 * says what to do about it (which project already exists, which entry was refused), so that one is
 * shown as the server wrote it; a quota failure has its own sentence with the numbers; everything
 * else is one generic line that never leaks an internal message.
 */
export function importErrorMessage(error: unknown): string {
  if (isApiError(error)) {
    if (error.code === 'Conflict' || error.code === 'Validation') return error.message
    if (error.code === 'QuotaExceeded') return errorMessage(error)
  }
  return t('import.failed')
}

export type ImportSummary = {
  /** Labelled numbers for a `StatList`. */
  stats: { label: string; value: string }[]
  /** Sentences about what the import left alone or changed on the way. */
  notes: string[]
}

/** What the import did, as labelled numbers and notes, in the current language. */
export function summarizeImport(result: ZipImportResultDto): ImportSummary {
  const stats = [
    { label: t('import.statProjects'), value: String(result.projectsExtracted) },
    { label: t('import.statFiles'), value: String(result.filesExtracted) },
    { label: t('import.statSize'), value: formatBytes(result.bytesExtracted) },
    { label: t('import.statTags'), value: String(result.tagsApplied) },
  ]
  if (result.projectsUpdated > 0) {
    stats.push({ label: t('import.statUpdated'), value: String(result.projectsUpdated) })
  }
  if (result.rescan.previewsQueued > 0) {
    stats.push({ label: t('import.statPreviews'), value: String(result.rescan.previewsQueued) })
  }
  const notes: string[] = []
  if (result.strippedRoot) notes.push(t('import.strippedRoot', { name: result.strippedRoot }))
  if (result.skipped === 1) notes.push(t('import.skippedOne'))
  else if (result.skipped > 1) notes.push(t('import.skipped', { count: result.skipped }))
  return { stats, notes }
}

/**
 * The CuraManager archive import as state: one archive at a time (the endpoint takes one, and two
 * in flight would race on its collision check), a result or an error, never both. A new attempt
 * clears the last outcome, so a success banner never sits beside a fresh failure.
 */
export function createArchiveImport(client: Pick<ApiClient, 'importer'> = api) {
  const [busy, setBusy] = createSignal(false)
  const [result, setResult] = createSignal<ZipImportResultDto | null>(null)
  const [error, setError] = createSignal<string | null>(null)

  return {
    busy,
    result,
    error,

    /** Imports the first of `files`; any others are ignored. Never rejects. */
    async run(files: readonly File[]): Promise<void> {
      const [file] = files
      if (!file || busy()) return
      setError(null)
      setResult(null)
      if (!isZipName(file.name)) {
        setError(t('import.notZip'))
        return
      }
      setBusy(true)
      try {
        setResult(await client.importer.curaManagerZip(file))
      } catch (failure) {
        setError(importErrorMessage(failure))
      } finally {
        setBusy(false)
      }
    },

    reset(): void {
      setResult(null)
      setError(null)
    },
  }
}

export type ArchiveImport = ReturnType<typeof createArchiveImport>
