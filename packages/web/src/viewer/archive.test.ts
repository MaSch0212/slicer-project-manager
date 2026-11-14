import { strToU8 as encode, zipSync } from 'three/addons/libs/fflate.module.js'
import { describe, expect, it } from 'vitest'
import { entryKindOf, previewKindOf } from '../core/preview-kind'
import { entryTree, initiallyOpen, listEntries, readEntry } from './archive'

/**
 * Text as bytes of *this* realm's Uint8Array. Under jsdom, `TextEncoder` returns another realm's,
 * which fflate's `zipSync` does not recognise as file data and zips up as a folder of numbers.
 */
const strToU8 = (text: string) => new Uint8Array(encode(text))

const zip = zipSync({
  'pack/readme.txt': strToU8('hello'),
  'pack/parts/b.stl': new Uint8Array(10),
  'pack/parts/a.stl': new Uint8Array(20),
  'pack/photo.png': new Uint8Array(5),
})

describe('reading an archive', () => {
  it('lists the files with their unpacked sizes, inflating nothing', () => {
    expect(listEntries(zip).sort((a, b) => a.path.localeCompare(b.path))).toEqual([
      { path: 'pack/parts/a.stl', size: 20 },
      { path: 'pack/parts/b.stl', size: 10 },
      { path: 'pack/photo.png', size: 5 },
      { path: 'pack/readme.txt', size: 5 },
    ])
  })

  it('reads one entry on demand', () => {
    expect(new TextDecoder().decode(readEntry(zip, 'pack/readme.txt'))).toBe('hello')
    expect(readEntry(zip, 'nope.txt')).toBeUndefined()
  })

  it('is a tree: folders first, sizes added up, a wrapping folder opened', () => {
    const tree = entryTree(listEntries(zip))
    expect(tree).toHaveLength(1)
    const pack = tree[0]!
    expect(pack).toMatchObject({ name: 'pack', path: 'pack', size: 40 })
    expect(pack.children!.map((node) => node.name)).toEqual(['parts', 'photo.png', 'readme.txt'])
    expect(pack.children![0]!.children!.map((node) => node.name)).toEqual(['a.stl', 'b.stl'])
    expect(pack.children![0]!.size).toBe(30)
    expect(initiallyOpen(tree)).toEqual(['pack'])
  })

  it('treats a backslash as a separator', () => {
    const tree = entryTree([{ path: 'a\\b.txt', size: 1 }])
    expect(tree[0]).toMatchObject({ name: 'a', children: [{ name: 'b.txt', path: 'a\\b.txt' }] })
  })

  it('refuses something that is not a zip', () => {
    expect(() => listEntries(strToU8('not a zip at all'))).toThrow()
  })
})

describe('how a file is previewed', () => {
  it('by what it is', () => {
    expect(previewKindOf({ name: 'a.stl', kind: 'model' })).toBe('model')
    expect(previewKindOf({ name: 'p.3mf', kind: 'slicer_project' })).toBe('model')
    expect(previewKindOf({ name: 'part.step', kind: 'model' })).toBe('none')
    expect(previewKindOf({ name: 'c.JSON', kind: 'other' })).toBe('text')
    expect(previewKindOf({ name: 'print.gcode', kind: 'other' })).toBe('text')
    expect(previewKindOf({ name: 'x.zip', kind: 'other' })).toBe('archive')
    expect(previewKindOf({ name: 'x.jpeg', kind: 'other' })).toBe('image')
    expect(previewKindOf({ name: 'x.pdf', kind: 'other' })).toBe('none')
    expect(entryKindOf('3D/3dmodel.model')).toBe('text')
  })
})
