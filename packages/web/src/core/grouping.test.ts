import { beforeEach, describe, expect, it } from 'vitest'
import type { FileDto, ProjectDto } from '../api/generated'
import {
  fileGroupKind,
  groupFiles,
  groupProjects,
  initialOf,
  isCollapsed,
  NO_VALUE,
  pickedGroup,
  pickGroup,
  setAllCollapsed,
  toggleCollapsed,
} from './grouping'

const NOW = Date.UTC(2026, 10, 14, 12)
const DAY = 86_400_000

const project = (over: Partial<ProjectDto> = {}): ProjectDto => ({
  id: over.name ?? 'p',
  name: 'Benchy',
  isArchived: false,
  state: 'ok',
  tags: [],
  fileCounts: { model: 0, slicerProject: 0, other: 0 },
  createdAt: NOW,
  updatedAt: NOW,
  ...over,
})

const file = (name: string, kind: FileDto['kind'] = 'other'): FileDto => ({
  id: name,
  name,
  kind,
  sizeBytes: 1,
  previewState: 'pending',
  rawUrl: `/api/files/${name}/raw`,
})

const summary = (groups: { key: string; items: { name: string }[] }[]) =>
  groups.map((group) => [group.key, group.items.map((item) => item.name)])

describe('grouping projects', () => {
  it('is one group without grouping, in the order given', () => {
    const list = [project({ name: 'b' }), project({ name: 'a' })]
    expect(summary(groupProjects(list, 'none', NOW))).toEqual([['', ['b', 'a']]])
  })

  it('puts a project with several tags in each, and the untagged last', () => {
    const list = [
      project({ name: 'boat', tags: ['PETG', 'toys'] }),
      project({ name: 'plain' }),
      project({ name: 'clip', tags: ['petg'] }),
    ]
    expect(summary(groupProjects(list, 'tag', NOW))).toEqual([
      ['petg', ['boat', 'clip']],
      ['toys', ['boat']],
      [NO_VALUE, ['plain']],
    ])
  })

  it('splits by status: active, archived, then a missing folder', () => {
    const list = [
      project({ name: 'gone', state: 'missing', isArchived: true }),
      project({ name: 'old', isArchived: true }),
      project({ name: 'new' }),
    ]
    expect(summary(groupProjects(list, 'status', NOW))).toEqual([
      ['active', ['new']],
      ['archived', ['old']],
      ['missing', ['gone']],
    ])
  })

  it('splits by contents', () => {
    const list = [
      project({ name: 'empty' }),
      project({ name: 'notes', fileCounts: { model: 0, slicerProject: 0, other: 2 } }),
      project({ name: 'stl', fileCounts: { model: 1, slicerProject: 0, other: 0 } }),
      project({ name: 'sliced', fileCounts: { model: 1, slicerProject: 1, other: 0 } }),
    ]
    expect(summary(groupProjects(list, 'content', NOW)).map(([key]) => key)).toEqual([
      'slicer',
      'models',
      'other',
      'empty',
    ])
  })

  it('buckets dates newest first', () => {
    const list = [
      project({ name: 'ancient', updatedAt: NOW - 800 * DAY }),
      project({ name: 'now', updatedAt: NOW - 1000 }),
      project({ name: 'days', updatedAt: NOW - 3 * DAY }),
      project({ name: 'weeks', createdAt: NOW - 20 * DAY, updatedAt: NOW - 20 * DAY }),
    ]
    expect(summary(groupProjects(list, 'updated', NOW))).toEqual([
      ['today', ['now']],
      ['thisWeek', ['days']],
      ['thisMonth', ['weeks']],
      ['older', ['ancient']],
    ])
  })

  it('files by initial letter: digits first, letters in order, symbols last', () => {
    const list = [
      project({ name: 'Zebra' }),
      project({ name: '3D cube' }),
      project({ name: '_misc' }),
      project({ name: 'Ärmel' }),
      project({ name: 'apple' }),
    ]
    expect(summary(groupProjects(list, 'name', NOW))).toEqual([
      ['0–9', ['3D cube']],
      ['A', ['Ärmel', 'apple']],
      ['Z', ['Zebra']],
      ['#', ['_misc']],
    ])
    expect(initialOf('  émile')).toBe('E')
  })
})

describe('grouping files', () => {
  it('groups by kind, slicer projects first and only the kinds that are there', () => {
    const files = [
      file('readme.txt'),
      file('photo.JPG'),
      file('part.stl', 'model'),
      file('plate.3mf', 'slicer_project'),
      file('extras.zip'),
      file('thing.bin'),
      file('settings.json'),
    ]
    expect(summary(groupFiles(files))).toEqual([
      ['slicerProject', ['plate.3mf']],
      ['model', ['part.stl']],
      ['image', ['photo.JPG']],
      ['text', ['readme.txt', 'settings.json']],
      ['archive', ['extras.zip']],
      ['other', ['thing.bin']],
    ])
    expect(fileGroupKind(file('.gitignore'))).toBe('other')
  })
})

describe('remembered group state', () => {
  beforeEach(() => {
    setAllCollapsed('projects.tag', [], false)
    pickGroup('projects.tag', null)
  })

  it('folds a group away and back, per field', () => {
    toggleCollapsed('projects.tag', 'petg')
    expect(isCollapsed('projects.tag', 'petg')).toBe(true)
    expect(isCollapsed('files', 'petg')).toBe(false)
    toggleCollapsed('projects.tag', 'petg')
    expect(isCollapsed('projects.tag', 'petg')).toBe(false)
  })

  it('folds every group at once', () => {
    setAllCollapsed('projects.tag', ['a', 'b'], true)
    expect(isCollapsed('projects.tag', 'b')).toBe(true)
    setAllCollapsed('projects.tag', [], false)
    expect(isCollapsed('projects.tag', 'a')).toBe(false)
  })

  it('remembers the picked group', () => {
    expect(pickedGroup('projects.tag')).toBeNull()
    pickGroup('projects.tag', 'petg')
    expect(pickedGroup('projects.tag')).toBe('petg')
    expect(JSON.parse(localStorage.getItem('spm.pickedGroup') ?? '{}')).toEqual({
      'projects.tag': 'petg',
    })
  })
})
