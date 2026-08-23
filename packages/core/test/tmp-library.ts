import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { closeLibrary, openLibrary, type Library, type OpenOptions } from '../src/db/open.ts'
import { createLogger, type LogRecord } from '../src/log.ts'

export async function withLibrary(
  run: (lib: Library) => void | Promise<void>,
  opts: OpenOptions = {},
): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'spm-test-'))
  const lib = openLibrary(dir, opts)
  try {
    await run(lib)
  } finally {
    closeLibrary(lib)
    rmSync(dir, { recursive: true, force: true })
  }
}

/** A library whose logger records everything at `trace`, for asserting on what core logs. */
export async function withLoggedLibrary(
  run: (lib: Library, records: LogRecord[]) => void | Promise<void>,
): Promise<void> {
  const records: LogRecord[] = []
  const logger = createLogger({ level: 'trace', sink: (record) => records.push(record) })
  await withLibrary((lib) => run(lib, records), { logger })
}
