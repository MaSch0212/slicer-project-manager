import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'

export async function fileContentHash(absPath: string): Promise<Uint8Array> {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(absPath)) {
    hash.update(chunk as Uint8Array)
  }
  return new Uint8Array(hash.digest())
}
