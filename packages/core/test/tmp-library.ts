import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { closeLibrary, openLibrary, type Library } from '../src/db/open.ts'

export async function withLibrary(run: (lib: Library) => void | Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'spm-test-'))
  const lib = openLibrary(dir)
  try {
    await run(lib)
  } finally {
    closeLibrary(lib)
    rmSync(dir, { recursive: true, force: true })
  }
}
