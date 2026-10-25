/**
 * Which files the viewer can draw, and what it says about the ones it cannot. Pure and free of
 * three.js, so the decision is testable (and importable) without loading a renderer.
 *
 * STL, OBJ and 3MF have loaders. A STEP file is a model the library lists and keeps, but the new
 * server has no STEP kernel (migration spec 4.1), so there is nothing to draw and the viewer says
 * so instead of fetching a file it could not use.
 */
export type ViewableFormat = 'stl' | 'obj' | '3mf'

/**
 * Bytes of memory a format needs at its peak, per byte of file, measured on the library's real
 * files (ported unchanged from the Angular viewer: the numbers are properties of the loaders, not
 * of the framework). An STL is parsed in place; an OBJ is decoded to text, split and held as
 * objects; a 3MF is inflated and turned into a DOM, so it costs the most per byte.
 */
export const PEAK_COST: Readonly<Record<ViewableFormat, number>> = {
  stl: 6.75,
  obj: 28.93,
  '3mf': 120.95,
}

/** What the viewer will let one model cost the browser before it asks first. */
export const PEAK_BUDGET_BYTES = 256_000_000

export type ViewerVerdict =
  | { status: 'viewable'; format: ViewableFormat; limitBytes: number }
  | { status: 'step' }
  | { status: 'slicerProject' }
  | { status: 'unsupported'; extension: string }

/** The lower-cased extension with its dot, or an empty string when there is none. */
export function extensionOf(name: string): string {
  const dot = name.lastIndexOf('.')
  return dot === -1 ? '' : name.slice(dot).toLowerCase()
}

/** The format an extension maps to, or undefined. */
export function formatOfExtension(extension: string): ViewableFormat | undefined {
  switch (extension) {
    case '.stl':
      return 'stl'
    case '.obj':
      return 'obj'
    case '.3mf':
      return '3mf'
    default:
      return undefined
  }
}

/** The size in bytes above which opening a file of this format asks first. */
export function sizeLimit(format: ViewableFormat): number {
  return PEAK_BUDGET_BYTES / PEAK_COST[format]
}

/** The formats the viewer opens, upper-cased, for the "this viewer opens ..." sentence. */
export const SUPPORTED_FORMATS: readonly string[] = ['STL', 'OBJ', '3MF']

/**
 * Decides what to do with a file, by its extension and the kind the server classified it as. The
 * extension comes first so a STEP file gets its own message whatever its kind; then a slicer
 * project (a 3MF the server read as a project has no single mesh to show) and anything else the
 * server did not call a model are turned away.
 */
export function judgeFile(file: { name: string; kind: string }): ViewerVerdict {
  const extension = extensionOf(file.name)
  if (extension === '.step' || extension === '.stp') return { status: 'step' }
  const format = formatOfExtension(extension)
  if (format === undefined) return { status: 'unsupported', extension: extension || file.name }
  if (file.kind === 'slicer_project') return { status: 'slicerProject' }
  if (file.kind !== 'model') return { status: 'unsupported', extension }
  return { status: 'viewable', format, limitBytes: sizeLimit(format) }
}
