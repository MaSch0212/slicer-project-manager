import { expect, test } from '@playwright/test'
import { deflateRawSync } from 'node:zlib'
import { signIn } from './fixtures'

/**
 * A real zip, built here rather than checked in as a binary fixture, so what the test uploads
 * is readable in the diff. Entries are deflated, which is what a zip tool actually produces
 * and what exercises the inflate path on the server.
 */
function zip(files: { name: string; body: string }[]): Buffer {
  const local: Buffer[] = []
  const central: Buffer[] = []
  let offset = 0

  const crcTable = Array.from({ length: 256 }, (_, i) => {
    let c = i
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    return c >>> 0
  })
  const crc32 = (bytes: Buffer): number => {
    let c = 0xffffffff
    for (const byte of bytes) c = crcTable[(c ^ byte) & 0xff]! ^ (c >>> 8)
    return (c ^ 0xffffffff) >>> 0
  }

  for (const file of files) {
    const name = Buffer.from(file.name, 'utf8')
    const raw = Buffer.from(file.body, 'utf8')
    const data = deflateRawSync(raw)
    const crc = crc32(raw)

    const header = Buffer.alloc(30)
    header.writeUInt32LE(0x04034b50, 0)
    header.writeUInt16LE(20, 4)
    header.writeUInt16LE(8, 8) // deflate
    header.writeUInt32LE(crc, 14)
    header.writeUInt32LE(data.length, 18)
    header.writeUInt32LE(raw.length, 22)
    header.writeUInt16LE(name.length, 26)
    local.push(header, name, data)

    const entry = Buffer.alloc(46)
    entry.writeUInt32LE(0x02014b50, 0)
    entry.writeUInt16LE(20, 4)
    entry.writeUInt16LE(20, 6)
    entry.writeUInt16LE(8, 10)
    entry.writeUInt32LE(crc, 16)
    entry.writeUInt32LE(data.length, 20)
    entry.writeUInt32LE(raw.length, 24)
    entry.writeUInt16LE(name.length, 28)
    entry.writeUInt32LE(offset, 42)
    central.push(entry, name)

    offset += header.length + name.length + data.length
  }

  const centralBytes = Buffer.concat(central)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(files.length, 8)
  end.writeUInt16LE(files.length, 10)
  end.writeUInt32LE(centralBytes.length, 12)
  end.writeUInt32LE(offset, 16)

  return Buffer.concat([...local, centralBytes, end])
}

test('a zipped CuraManager library is uploaded, imported and shows up as projects', async ({
  page,
}) => {
  await signIn(page)
  await page.getByRole('link', { name: 'Import' }).click()
  await expect(page.getByRole('heading', { name: 'Import a CuraManager library' })).toBeVisible()

  // Names nothing else in the suite uses, so this cannot collide with the projects the other
  // specs create in the same shared library.
  await page.locator('input[type="file"]').setInputFiles({
    name: 'curamanager.zip',
    mimeType: 'application/zip',
    buffer: zip([
      // `solid alpha` is not a real STL, and since a rasterizer was wired into the preview
      // queue this file is now attempted and correctly fails — so the server log for this
      // suite carries `WARN preview failed … STL file has zero triangles`. Expected, bounded
      // by MAX_PREVIEW_ATTEMPTS, and free coverage of the failed path. Kept as a string on
      // purpose: making it a real mesh would mean widening `zip()` from strings to bytes for
      // a spec that is about importing an archive, not about rendering.
      { name: 'CuraLibrary/Zip Import Alpha/part.stl', body: 'solid alpha' },
      {
        name: 'CuraLibrary/Zip Import Alpha/metadata.json',
        body: JSON.stringify({ Tags: ['zip-imported'], IsArchived: false }),
      },
      { name: 'CuraLibrary/Zip Import Beta/model.3mf', body: 'not really a 3mf' },
      // Skipped by the importer: a loose file at the library root.
      { name: 'CuraLibrary/metadata-cache.json', body: '{}' },
    ]),
  })

  // `mode="confirm"`: the archive queues on drop and uploads when the control's own button
  // is pressed, so a mis-drop costs nothing.
  await page.getByRole('button', { name: /upload/i }).click()

  await expect(page.getByText('Import finished')).toBeVisible({ timeout: 30_000 })
  await expect(page.getByRole('status')).toContainText('2 projects and 3 files imported')
  // The single wrapping folder is detected and stripped rather than becoming a project.
  await expect(page.getByRole('status')).toContainText('CuraLibrary')

  await page.getByRole('link', { name: 'View projects' }).click()
  await expect(page.getByRole('heading', { name: 'Zip Import Alpha' })).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Zip Import Beta' })).toBeVisible()
  // The sidecar's tag came across with it, which is the whole point of importing rather
  // than just copying folders in.
  await expect(page.getByText('zip-imported').first()).toBeVisible()
})
