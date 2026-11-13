import { describe, expect, it } from 'vitest'
import type { ProjectViewDto } from '../api/generated'
import { hasViewIcon } from '../ui/nav-views'
import {
  activeView,
  currentView,
  DEFAULT_VIEW_ICON,
  duplicateView,
  editView,
  isViewIcon,
  matchesView,
  moveView,
  newViewId,
  removeView,
  reshapeView,
  shapeOf,
  VIEW_ICONS,
  viewFrom,
  type ViewShape,
} from './views'

const shape = (over: Partial<ViewShape> = {}): ViewShape => ({
  viewMode: 'grid',
  sort: 'updatedAt',
  dir: 'desc',
  includeArchived: false,
  tags: [],
  ...over,
})

const view = (over: Partial<ProjectViewDto> = {}): ProjectViewDto => ({
  id: 'v1',
  name: 'Everything',
  icon: 'layers',
  ...shape(),
  ...over,
})

describe('what a view is made of', () => {
  it('takes the four things a view decides out of the settings, and not the search', () => {
    const taken = shapeOf({
      viewMode: 'list',
      sort: 'name',
      dir: 'asc',
      includeArchived: true,
      filterTags: ['petg', 'boats'],
    })

    expect(taken).toEqual({
      viewMode: 'list',
      sort: 'name',
      dir: 'asc',
      includeArchived: true,
      // Sorted, so two selections of the same tags are one selection.
      tags: ['boats', 'petg'],
    })
    expect('search' in taken).toBe(false)
  })

  it('keeps only an icon it can draw', () => {
    expect(viewFrom('v1', 'A', 'tag', shape()).icon).toBe('tag')
    expect(viewFrom('v1', 'A', 'not-an-icon', shape()).icon).toBe(DEFAULT_VIEW_ICON)
    expect(isViewIcon('printer')).toBe(true)
    expect(isViewIcon('printer2')).toBe(false)
  })

  it('trims the name, because a view called " " is a row you cannot read', () => {
    expect(viewFrom('v1', '  Functional  ', 'layers', shape()).name).toBe('Functional')
  })
})

describe('which view the list is showing', () => {
  it('matches on the four, whatever order the tags came in', () => {
    const saved = view({ tags: ['boats', 'petg'] })

    expect(matchesView(shape({ tags: ['petg', 'boats'] }), saved)).toBe(true)
    expect(matchesView(shape({ tags: ['petg'] }), saved)).toBe(false)
    expect(matchesView(shape({ tags: ['boats', 'petg'], dir: 'asc' }), saved)).toBe(false)
    expect(matchesView(shape({ tags: ['boats', 'petg'], viewMode: 'list' }), saved)).toBe(false)
  })

  it('is nothing at all when the list matches none of them', () => {
    const views = [view({ id: 'v1' }), view({ id: 'v2', sort: 'name' })]

    expect(activeView(views, shape())?.id).toBe('v1')
    expect(activeView(views, shape({ sort: 'name' }))?.id).toBe('v2')
    expect(activeView(views, shape({ includeArchived: true }))).toBeNull()
    expect(activeView([], shape())).toBeNull()
  })
})

describe('keeping the list of views', () => {
  it('mints an id nothing is using', () => {
    expect(newViewId([])).toBe('view-1')
    expect(newViewId([view({ id: 'view-1' })])).toBe('view-2')
    expect(newViewId([view({ id: 'view-2' })])).toBe('view-1')
  })

  it('moves one up and down, and does nothing at the ends', () => {
    const views = [view({ id: 'a' }), view({ id: 'b' }), view({ id: 'c' })]
    const ids = (list: ProjectViewDto[]) => list.map((v) => v.id)

    expect(ids(moveView(views, 'b', 'up'))).toEqual(['b', 'a', 'c'])
    expect(ids(moveView(views, 'b', 'down'))).toEqual(['a', 'c', 'b'])
    expect(ids(moveView(views, 'a', 'up'))).toEqual(['a', 'b', 'c'])
    expect(ids(moveView(views, 'c', 'down'))).toEqual(['a', 'b', 'c'])
    expect(ids(moveView(views, 'nope', 'up'))).toEqual(['a', 'b', 'c'])
  })

  it('renames and removes by id, and leaves the rest alone', () => {
    const views = [view({ id: 'a', name: 'One' }), view({ id: 'b', name: 'Two' })]

    expect(editView(views, 'a', { name: '  Renamed  ' })[0]!.name).toBe('Renamed')
    expect(editView(views, 'a', { name: 'Renamed' })[1]!.name).toBe('Two')
    expect(editView(views, 'nope', { name: 'Renamed' })).toEqual(views)
    expect(removeView(views, 'a').map((v) => v.id)).toEqual(['b'])
    expect(removeView(views, 'nope')).toHaveLength(2)
  })

  it('copies one in place, under a new id and the name it was given', () => {
    const views = [view({ id: 'a' }), view({ id: 'b', name: 'Two' })]

    const copied = duplicateView(views, 'a', '  Everything copy  ')

    expect(copied.map((v) => v.id)).toEqual(['a', 'view-1', 'b'])
    expect(copied[1]!.name).toBe('Everything copy')
    expect(copied[1]!.tags).toEqual(views[0]!.tags)
    expect(duplicateView(views, 'nope', 'x')).toEqual(views)
  })

  it('takes a new shape without touching the name or the icon', () => {
    const views = [view({ id: 'a', name: 'One', icon: 'tag' })]

    const reshaped = reshapeView(views, 'a', shape({ sort: 'name', tags: ['petg'] }))[0]!

    expect(reshaped).toMatchObject({ name: 'One', icon: 'tag', sort: 'name', tags: ['petg'] })
    expect(reshapeView(views, 'nope', shape({ sort: 'name' }))).toEqual(views)
  })
})

describe('the icons', () => {
  it('can all be drawn: a name with no picture would be a blank row', () => {
    for (const icon of VIEW_ICONS) expect(hasViewIcon(icon), icon).toBe(true)
  })
})

describe('the view the list is in', () => {
  const twins = [view({ id: 'a', name: 'First' }), view({ id: 'b', name: 'Twin' })]

  it('is the picked one, even when an earlier one has the same filters', () => {
    expect(currentView(twins, shape(), 'b')).toEqual({ view: twins[1], modified: false })
  })

  it('stays the picked one once its filters change, and says so', () => {
    expect(currentView(twins, shape({ sort: 'name' }), 'b')).toEqual({
      view: twins[1],
      modified: true,
    })
  })

  it('falls back to matching when nothing, or a deleted view, was picked', () => {
    expect(currentView(twins, shape(), null)?.view.id).toBe('a')
    expect(currentView(twins, shape(), 'gone')?.view.id).toBe('a')
    expect(currentView(twins, shape({ sort: 'name' }), null)).toBeNull()
  })
})
