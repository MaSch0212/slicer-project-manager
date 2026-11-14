import { createSignal } from 'solid-js'
import type { FileDto, ProjectDto, ProjectGroupBy } from '../api/generated'
import { t } from './i18n'

/**
 * Grouping, as Questkeep does it: a list split into labelled groups that fold away, with the
 * group of items that have no value last. A project with several tags is in each of their groups.
 *
 * The projects page groups by a field the user picks (and a saved view remembers); a project's
 * files are grouped by their kind and nothing else. The splitting is pure and lives here, so it is
 * testable without a page; what is folded away and which group is picked are remembered on this
 * device, per field.
 */

/** One group of a grouped list. */
export interface Group<T> {
  /** A tag, a bucket or a kind; `NO_VALUE` for the items without one; "" for an ungrouped list. */
  key: string
  label: string
  items: T[]
}

/** The key of the group of items that have no value for the field (no tags, say). */
export const NO_VALUE = '~none'

/** The fields the projects page groups by, in the order its menu lists them. */
export const PROJECT_GROUPS: readonly Exclude<ProjectGroupBy, 'none'>[] = [
  'tag',
  'status',
  'content',
  'updated',
  'created',
  'name',
]

export function groupByLabel(by: ProjectGroupBy): string {
  return t(`grouping.by_${by}` as 'grouping.by_tag')
}

interface Placement {
  key: string
  label: string
  /** Position among the groups; equal ranks fall back to the label. */
  rank: number
}

const DAY_MS = 86_400_000

/** Age buckets for a date: newest first. */
const AGE_BUCKETS: readonly { key: string; maxDays: number }[] = [
  { key: 'today', maxDays: 1 },
  { key: 'thisWeek', maxDays: 7 },
  { key: 'thisMonth', maxDays: 30 },
  { key: 'thisYear', maxDays: 365 },
  { key: 'older', maxDays: Infinity },
]

function ageBucket(at: number, now: number): Placement {
  const days = Math.max(0, now - at) / DAY_MS
  const rank = AGE_BUCKETS.findIndex((bucket) => days < bucket.maxDays)
  const bucket = AGE_BUCKETS[rank]!
  return { key: bucket.key, label: t(`grouping.age_${bucket.key}` as 'grouping.age_today'), rank }
}

/** The letter a name files under: A to Z (accents folded), "0–9", or "#" for anything else. */
export function initialOf(name: string): string {
  const first = name.trim().normalize('NFD').replace(/\p{M}/gu, '').charAt(0).toUpperCase()
  if (/[A-Z]/.test(first)) return first
  if (/[0-9]/.test(first)) return '0–9'
  if (/\p{L}/u.test(first)) return first
  return '#'
}

function placements(project: ProjectDto, by: ProjectGroupBy, now: number): Placement[] {
  switch (by) {
    case 'tag': {
      const seen = new Set<string>()
      return project.tags.flatMap((tag) => {
        const key = tag.toLowerCase()
        if (seen.has(key)) return []
        seen.add(key)
        return [{ key, label: tag, rank: 0 }]
      })
    }
    case 'status':
      if (project.state === 'missing') {
        return [{ key: 'missing', label: t('grouping.status_missing'), rank: 2 }]
      }
      return project.isArchived
        ? [{ key: 'archived', label: t('grouping.status_archived'), rank: 1 }]
        : [{ key: 'active', label: t('grouping.status_active'), rank: 0 }]
    case 'content': {
      const { model, slicerProject, other } = project.fileCounts
      if (slicerProject > 0) {
        return [{ key: 'slicer', label: t('grouping.content_slicer'), rank: 0 }]
      }
      if (model > 0) return [{ key: 'models', label: t('grouping.content_models'), rank: 1 }]
      if (other > 0) return [{ key: 'other', label: t('grouping.content_other'), rank: 2 }]
      return [{ key: 'empty', label: t('grouping.content_empty'), rank: 3 }]
    }
    case 'updated':
      return [ageBucket(project.updatedAt, now)]
    case 'created':
      return [ageBucket(project.createdAt, now)]
    case 'name': {
      const letter = initialOf(project.name)
      // Digits before letters, "#" last; letters by the collator.
      const rank = letter === '0–9' ? -1 : letter === '#' ? 1 : 0
      return [{ key: letter, label: letter, rank }]
    }
    case 'none':
      return []
  }
}

/** The label of the group of projects without a value: only tags can be missing. */
function noValueLabel(by: ProjectGroupBy): string {
  return by === 'tag' ? t('grouping.noTags') : t('grouping.none')
}

/**
 * Splits the (already sorted) projects into groups, keeping their order inside each group. Tags go
 * by name, buckets in their natural order, and the projects with no tag come last. Without
 * grouping there is one group, key "".
 */
export function groupProjects(
  projects: readonly ProjectDto[],
  by: ProjectGroupBy,
  now = Date.now(),
): Group<ProjectDto>[] {
  if (by === 'none') return [{ key: '', label: '', items: [...projects] }]
  const collator = new Intl.Collator(undefined, { sensitivity: 'base', numeric: true })
  const groups = new Map<string, Group<ProjectDto> & { rank: number }>()
  for (const project of projects) {
    const places = placements(project, by, now)
    if (places.length === 0) {
      places.push({ key: NO_VALUE, label: noValueLabel(by), rank: Infinity })
    }
    for (const place of places) {
      let group = groups.get(place.key)
      if (!group) {
        group = { key: place.key, label: place.label, rank: place.rank, items: [] }
        groups.set(place.key, group)
      }
      group.items.push(project)
    }
  }
  return [...groups.values()]
    .sort((a, b) => a.rank - b.rank || collator.compare(a.label, b.label))
    .map(({ rank: _rank, ...group }) => group)
}

/** What a file is, for grouping: finer than its `kind`, which lumps every non-3D file together. */
export type FileGroupKind = 'slicerProject' | 'model' | 'image' | 'text' | 'archive' | 'other'

const FILE_GROUP_ORDER: readonly FileGroupKind[] = [
  'slicerProject',
  'model',
  'image',
  'text',
  'archive',
  'other',
]

const IMAGE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg', 'avif'])
const ARCHIVE_EXTENSIONS = new Set(['zip', '7z', 'rar', 'tar', 'gz', 'tgz', 'bz2', 'xz'])

/** The lower-cased extension without its dot, or "" when there is none. */
export function extensionOfName(name: string): string {
  const dot = name.lastIndexOf('.')
  return dot <= 0 ? '' : name.slice(dot + 1).toLowerCase()
}

/** Text the preview shows as text: data, markup, configuration, G-code, notes. */
export const TEXT_EXTENSIONS = new Set([
  'txt',
  'md',
  'markdown',
  'json',
  'xml',
  'html',
  'htm',
  'svg',
  'yml',
  'yaml',
  'ini',
  'cfg',
  'conf',
  'config',
  'toml',
  'csv',
  'tsv',
  'log',
  'gcode',
  'gco',
  'g',
  'scad',
  'py',
  'js',
  'ts',
  'css',
  'sh',
  'bat',
  'ps1',
  'nfo',
  'properties',
  'model',
  'rels',
])

export function fileGroupKind(file: Pick<FileDto, 'name' | 'kind'>): FileGroupKind {
  if (file.kind === 'slicer_project') return 'slicerProject'
  if (file.kind === 'model') return 'model'
  const extension = extensionOfName(file.name)
  if (IMAGE_EXTENSIONS.has(extension)) return 'image'
  if (ARCHIVE_EXTENSIONS.has(extension)) return 'archive'
  if (TEXT_EXTENSIONS.has(extension) || extension === 'pdf') return 'text'
  return 'other'
}

/** A project's files by kind: slicer projects, models, pictures, documents, archives, the rest. */
export function groupFiles(files: readonly FileDto[]): Group<FileDto>[] {
  const groups = new Map<FileGroupKind, FileDto[]>()
  for (const file of files) {
    const kind = fileGroupKind(file)
    const items = groups.get(kind)
    if (items) items.push(file)
    else groups.set(kind, [file])
  }
  return FILE_GROUP_ORDER.flatMap((kind) => {
    const items = groups.get(kind)
    return items
      ? [{ key: kind, label: t(`grouping.files_${kind}` as 'grouping.files_model'), items }]
      : []
  })
}

/**
 * Which groups are folded away and which one is picked in the group list, per field (`tag`,
 * `files`, ...), on this device. A matter of the screen in front of you, like the panel's width.
 */
const COLLAPSED_KEY = 'spm.collapsedGroups'
const PICKED_KEY = 'spm.pickedGroup'

function readJson<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key)
    if (!raw) return fallback
    const parsed: unknown = JSON.parse(raw)
    return parsed && typeof parsed === 'object' ? (parsed as T) : fallback
  } catch {
    return fallback
  }
}

function writeJson(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value))
  } catch {
    // Blocked storage: the choice lasts until the app closes.
  }
}

const [collapsedMap, setCollapsedMap] = createSignal<Record<string, string[]>>(
  readJson(COLLAPSED_KEY, {}),
)
const [pickedMap, setPickedMap] = createSignal<Record<string, string>>(readJson(PICKED_KEY, {}))

export function isCollapsed(field: string, key: string): boolean {
  return collapsedMap()[field]?.includes(key) ?? false
}

export function toggleCollapsed(field: string, key: string): void {
  const current = collapsedMap()[field] ?? []
  const next = current.includes(key) ? current.filter((k) => k !== key) : [...current, key]
  const map = { ...collapsedMap(), [field]: next }
  setCollapsedMap(map)
  writeJson(COLLAPSED_KEY, map)
}

/** Folds every group of a field away, or opens every one. */
export function setAllCollapsed(field: string, keys: readonly string[], collapsed: boolean): void {
  const map = { ...collapsedMap(), [field]: collapsed ? [...keys] : [] }
  setCollapsedMap(map)
  writeJson(COLLAPSED_KEY, map)
}

/** The group picked in the group list for a field; null is "all groups". */
export function pickedGroup(field: string): string | null {
  return pickedMap()[field] ?? null
}

export function pickGroup(field: string, key: string | null): void {
  const map = { ...pickedMap() }
  if (key === null) delete map[field]
  else map[field] = key
  setPickedMap(map)
  writeJson(PICKED_KEY, map)
}
