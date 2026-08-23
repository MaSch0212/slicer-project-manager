import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Ctx } from '../src/ctx.ts'
import { newId } from '../src/db/ids.ts'
import type { Library } from '../src/db/open.ts'
import { readZipEntries } from '../src/files/zip.ts'
import { importCuraManagerZip, planZipImport } from '../src/projects/import-zip.ts'
import { getProject, listProjects } from '../src/projects/queries.ts'
import { updateProject } from '../src/projects/usecases.ts'
import { assert, test } from './harness.ts'
import { withLibrary } from './tmp-library.ts'
import { writeZip, type ZipInput } from './fixtures/make-3mf.ts'

function seedUser(lib: Library, username = 'marc', quotaBytes: number | null = null): Ctx {
  const id = newId()
  lib.db
    .prepare(
      `INSERT INTO users (id, username, display_name, library_dir, is_admin, status, quota_bytes, created_at)
       VALUES (?, ?, ?, ?, 0, 'active', ?, 0)`,
    )
    .run(id, username, username, username, quotaBytes)
  mkdirSync(join(lib.dir, username), { recursive: true })
  return { userId: id, isAdmin: false }
}

/** Writes a zip into the library's own scratch area and returns its path. */
function makeZip(lib: Library, entries: ZipInput[]): string {
  const path = join(lib.dir, `${newId()}.zip`)
  writeZip(path, entries)
  return path
}

const LIBRARY_ENTRIES: ZipInput[] = [
  { name: 'MyLibrary/Widget A/part.stl', data: 'solid a' },
  {
    name: 'MyLibrary/Widget A/metadata.json',
    data: JSON.stringify({
      Tags: ['toys'],
      Website: 'https://example.invalid/a',
      IsArchived: true,
    }),
  },
  { name: 'MyLibrary/Bracket/model.3mf', data: 'not a real 3mf' },
]

function entriesOf(entries: ZipInput[]): ReturnType<typeof readZipEntries> {
  // planZipImport reads a parsed central directory, so the fixture round-trips through a
  // real zip rather than through hand-built entry objects that could drift from the parser.
  const path = join(
    process.env.TMPDIR ?? process.env.TEMP ?? '/tmp',
    `spm-plan-${Math.trunc(performance.now() * 1000)}.zip`,
  )
  writeZip(path, entries)
  return readZipEntries(path)
}

test('a single wrapping folder holding project folders is stripped', () => {
  const plan = planZipImport(entriesOf(LIBRARY_ENTRIES))
  assert.equal(plan.strippedRoot, 'MyLibrary')
  assert.deepEqual(plan.projectDirs, ['Bracket', 'Widget A'])
  assert.deepEqual(plan.files.map((file) => file.relPath).sort(), [
    'Bracket/model.3mf',
    'Widget A/metadata.json',
    'Widget A/part.stl',
  ])
})

test('a single top-level folder of plain files is one project, not a wrapper', () => {
  // Stripping here would scatter the project's files across the library root, so the
  // heuristic has to see nesting before it strips anything.
  const plan = planZipImport(
    entriesOf([
      { name: 'Widget A/part.stl', data: 'solid a' },
      { name: 'Widget A/notes.txt', data: 'hi' },
    ]),
  )
  assert.equal(plan.strippedRoot, null)
  assert.deepEqual(plan.projectDirs, ['Widget A'])
})

test('projects at the archive root need no wrapper', () => {
  const plan = planZipImport(
    entriesOf([
      { name: 'Widget A/part.stl', data: 'solid a' },
      { name: 'Bracket/model.3mf', data: 'x' },
    ]),
  )
  assert.equal(plan.strippedRoot, null)
  assert.deepEqual(plan.projectDirs, ['Bracket', 'Widget A'])
})

test('noise, loose root files and traversal entries are skipped, not written', () => {
  const plan = planZipImport(
    entriesOf([
      { name: 'Widget A/part.stl', data: 'solid a' },
      { name: 'Bracket/model.3mf', data: 'x' },
      // A file directly at the library root belongs to no project.
      { name: 'metadata-cache.json', data: '{}' },
      { name: '__MACOSX/._Widget A', data: 'junk' },
      { name: 'Widget A/.DS_Store', data: 'junk' },
      { name: '../escape.txt', data: 'nope' },
      { name: 'Widget A/../../escape2.txt', data: 'nope' },
    ]),
  )
  assert.equal(plan.skipped, 5)
  assert.deepEqual(plan.files.map((file) => file.relPath).sort(), [
    'Bracket/model.3mf',
    'Widget A/part.stl',
  ])
  // The decisive assertion: nothing that could escape survived into the write list.
  assert.ok(!plan.files.some((file) => file.relPath.includes('..')))
})

test('a zip import extracts, adopts and applies each sidecar', async () => {
  await withLibrary(async (lib) => {
    const ctx = seedUser(lib)
    const zip = makeZip(lib, LIBRARY_ENTRIES)

    const result = await importCuraManagerZip(lib, ctx, zip)

    assert.equal(result.projectsExtracted, 2)
    assert.equal(result.filesExtracted, 3)
    assert.equal(result.strippedRoot, 'MyLibrary')
    assert.equal(result.rescan.adopted, 2)
    assert.equal(result.rescan.filesAdded, 3)
    assert.equal(result.tagsApplied, 1)

    // On disk, under the user's own root and with the wrapper folder gone.
    assert.ok(existsSync(join(lib.dir, 'marc', 'Widget A', 'part.stl')))
    assert.ok(existsSync(join(lib.dir, 'marc', 'Bracket', 'model.3mf')))
    assert.ok(!existsSync(join(lib.dir, 'marc', 'MyLibrary')))
    assert.equal(readFileSync(join(lib.dir, 'marc', 'Widget A', 'part.stl'), 'utf8'), 'solid a')

    // And in the database, with the sidecar applied.
    const projects = listProjects(lib, ctx, { includeArchived: true })
    const widget = projects.find((project) => project.name === 'Widget A')
    assert.ok(widget, 'Widget A was not adopted')
    assert.equal(widget.isArchived, true)
    assert.deepEqual(widget.tags, ['toys'])
    assert.equal(getProject(lib, ctx, widget.id).website, 'https://example.invalid/a')
  })
})

test('a colliding project folder refuses the whole archive and writes nothing', async () => {
  await withLibrary(async (lib) => {
    const ctx = seedUser(lib)
    mkdirSync(join(lib.dir, 'marc', 'Bracket'), { recursive: true })

    const zip = makeZip(lib, LIBRARY_ENTRIES)
    await assert.rejects(
      () => importCuraManagerZip(lib, ctx, zip),
      (error: Error) => error.message.includes('Bracket'),
    )

    // All-or-nothing: the non-colliding folder must not have been written either.
    assert.ok(!existsSync(join(lib.dir, 'marc', 'Widget A')))
    assert.deepEqual(readdirSync(join(lib.dir, 'marc', 'Bracket')), [])
  })
})

test('an archive that would exceed the quota is refused before extracting', async () => {
  await withLibrary(async (lib) => {
    const ctx = seedUser(lib, 'marc', 8)
    const zip = makeZip(lib, [{ name: 'Widget A/big.stl', data: 'x'.repeat(4096) }])

    await assert.rejects(() => importCuraManagerZip(lib, ctx, zip))
    assert.ok(!existsSync(join(lib.dir, 'marc', 'Widget A')))
  })
})

test('an archive with no project folders is refused with an explanation', async () => {
  await withLibrary(async (lib) => {
    const ctx = seedUser(lib)
    const zip = makeZip(lib, [{ name: 'just-a-file.txt', data: 'hello' }])
    await assert.rejects(
      () => importCuraManagerZip(lib, ctx, zip),
      (error: Error) => error.message.includes('no project folders'),
    )
  })
})

test('a second import leaves the first import edits alone', async () => {
  await withLibrary(async (lib) => {
    const ctx = seedUser(lib)
    await importCuraManagerZip(lib, ctx, makeZip(lib, LIBRARY_ENTRIES))

    // The user then curates Widget A in the app: un-archives it and clears the website.
    // Its metadata.json is still sitting in the folder, saying the opposite.
    const widget = listProjects(lib, ctx, { includeArchived: true }).find(
      (project) => project.name === 'Widget A',
    )!
    updateProject(lib, ctx, widget.id, { isArchived: false, website: null })

    // A completely unrelated second archive must not re-run the sidecar pass over it.
    await importCuraManagerZip(
      lib,
      ctx,
      makeZip(lib, [
        { name: 'Later/part.stl', data: 'solid later' },
        { name: 'Later/metadata.json', data: JSON.stringify({ Tags: ['new'] }) },
      ]),
    )

    const after = getProject(lib, ctx, widget.id)
    assert.equal(after.isArchived, false, 'the second import re-archived an edited project')
    // `?? null` because getProject omits a cleared website rather than reporting it as null.
    assert.equal(after.website ?? null, null, 'the second import restored a cleared website')
    // And the new archive did land, so the guard above is not just an import that did nothing.
    assert.ok(listProjects(lib, ctx, {}).some((project) => project.name === 'Later'))
  })
})

test('a stored file keeps its exact bytes through the round trip', async () => {
  await withLibrary(async (lib) => {
    const ctx = seedUser(lib)
    // Deflated, so this exercises the inflate path rather than a stored copy.
    const body = 'solid deflate-me\n'.repeat(400)
    const zip = makeZip(lib, [{ name: 'Widget/part.stl', data: body, deflate: true }])
    await importCuraManagerZip(lib, ctx, zip)
    assert.equal(readFileSync(join(lib.dir, 'marc', 'Widget', 'part.stl'), 'utf8'), body)
  })
})

test('progress is reported for extraction, indexing and sidecars, in that order', async () => {
  await withLibrary(async (lib) => {
    const ctx = seedUser(lib)
    const phases: string[] = []
    await importCuraManagerZip(lib, ctx, makeZip(lib, LIBRARY_ENTRIES), {
      onProgress: (event) => phases.push(event.phase),
    })
    assert.ok(phases.includes('extracting'), 'no extraction progress')
    assert.ok(phases.includes('indexing'), 'no indexing progress')
    assert.ok(phases.includes('sidecars'), 'no sidecar progress')
    assert.ok(
      phases.lastIndexOf('extracting') < phases.indexOf('indexing'),
      `phases out of order: ${phases.join()}`,
    )
    assert.ok(
      phases.lastIndexOf('indexing') < phases.indexOf('sidecars'),
      `phases out of order: ${phases.join()}`,
    )
  })
})

test('the writes land inside the user own folder, never a sibling user', async () => {
  await withLibrary(async (lib) => {
    const marc = seedUser(lib, 'marc')
    seedUser(lib, 'other')
    writeFileSync(join(lib.dir, 'other', 'keep.txt'), 'untouched')

    await importCuraManagerZip(lib, marc, makeZip(lib, LIBRARY_ENTRIES))

    assert.deepEqual(readdirSync(join(lib.dir, 'other')), ['keep.txt'])
  })
})

test('an entry that escapes only via backslashes is refused, and nothing is written', async () => {
  await withLibrary(async (lib) => {
    const ctx = seedUser(lib)
    // planZipImport splits on '/' only, so a Windows-authored entry name arrives as one
    // opaque segment that neither the dot rule nor the '..' rule matches. safeJoin is what
    // catches it, and the pre-flight is what stops the good sibling being written first.
    const zip = makeZip(lib, [
      { name: 'Widget A/part.stl', data: 'solid a' },
      { name: 'Widget A/sub\\..\\..\\..\\escape.txt', data: 'nope' },
    ])

    await assert.rejects(() => importCuraManagerZip(lib, ctx, zip))
    assert.ok(!existsSync(join(lib.dir, 'marc', 'Widget A', 'part.stl')), 'wrote a partial import')
    assert.ok(!existsSync(join(lib.dir, 'escape.txt')))
    assert.ok(!existsSync(join(lib.dir, 'marc', 'escape.txt')))
  })
})
