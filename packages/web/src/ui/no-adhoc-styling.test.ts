import { describe, expect, it } from 'vitest'

/**
 * Enforces "every element is styled exactly once": outside `src/ui/`, no source file may set a
 * colour, border, radius, shadow, font size or weight. Those belong to the component library; feature
 * code composes components and uses layout utilities (flex, grid, gap, padding, margin, sizing)
 * only. If this fails, you need a component (or a variant) in `src/ui/`, not a class here.
 *
 * It reads every string literal outside `ui/`, splits it into words and rejects the words that are
 * styling utilities. A prose word that happens to equal one (a sentence containing a bare
 * "border") would be a false positive; reword it.
 */

const FORBIDDEN: RegExp[] = [
  // Colour, border, outline, ring and shadow utilities, whatever the value.
  /^(bg|ring|fill|stroke|shadow|divide|caret|decoration|accent|placeholder|from|via|to)-/,
  /^(border|outline|rounded|shadow|ring)$/,
  /^(border|outline|rounded)-/,
  // `text-*` is a colour or a size, except alignment and wrapping.
  /^text-(?!left$|center$|right$|justify$|start$|end$|wrap$|nowrap$|balance$|pretty$|ellipsis$|clip$)/,
  // Typography.
  /^(font|leading|tracking)-/,
  /^(uppercase|lowercase|capitalize|italic|underline|no-underline|line-through|antialiased)$/,
  /^opacity-/,
]

/** Words of one class string, with variants (`hover:`, `md:`), `!` and a leading `-` removed. */
function utilities(text: string): string[] {
  return text
    .split(/\s+/)
    .filter(Boolean)
    .map((word) => word.slice(word.lastIndexOf(':') + 1).replace(/^[!-]+/, ''))
}

export function violations(source: string): string[] {
  const found: string[] = []
  for (const match of source.matchAll(/(["'`])((?:\\.|(?!\1)[^\\])*)\1/g)) {
    const text = match[2]!
    for (const word of utilities(text)) {
      if (FORBIDDEN.some((rule) => rule.test(word))) found.push(word)
    }
    if (/#[0-9a-fA-F]{3,8}\b/.test(text) && /^[^a-z]*#[0-9a-fA-F]{3,8}\b/.test(text.trim())) {
      found.push(`hard-coded colour ${text.trim()}`)
    }
  }
  if (/\bstyle=\{?\s*["{]/.test(source)) found.push('inline style attribute')
  return found
}

describe('the violation scanner', () => {
  it('flags colours, borders, radii, shadows and type', () => {
    for (const bad of [
      'bg-surface',
      'text-fg-muted',
      'text-sm',
      'border',
      'border-b',
      'rounded-control',
      'shadow-card',
      'font-semibold',
      'hover:bg-surface-2',
      'md:text-xs',
      '!rounded',
      'uppercase',
      'ring-2',
    ]) {
      expect(violations(`<div class="flex ${bad}" />`), bad).toEqual([
        bad.replace(/^[^:]*:|^!/g, ''),
      ])
    }
    expect(violations(`const c = '#ea580c'`)).toHaveLength(1)
    expect(violations('<div style={{ color: "red" }} />')).toHaveLength(1)
  })

  it('allows layout', () => {
    expect(
      violations(
        `<div class="flex flex-col items-center gap-3 p-4 md:grid-cols-2 w-full max-w-sm mt-auto -mx-1 text-center text-left truncate sr-only" />`,
      ),
    ).toEqual([])
  })
})

const sources = import.meta.glob<string>('/src/**/*.{ts,tsx}', {
  query: '?raw',
  import: 'default',
  eager: true,
})

describe('feature code', () => {
  const files = Object.entries(sources).filter(
    ([path]) =>
      !path.startsWith('/src/ui/') &&
      !path.startsWith('/src/api/generated/') &&
      !/\.test\.tsx?$/.test(path),
  )

  it('scans the app (guards against an empty glob passing vacuously)', () => {
    const scanned = files.map(([path]) => path)
    expect(scanned).toContain('/src/shell/shell.tsx')
    expect(scanned).toContain('/src/pages/login.tsx')
    expect(scanned).toContain('/src/gallery/ui-gallery.tsx')
  })

  it.each(files)('%s sets no colours, borders, radii or font styles', (_path, source) => {
    expect(violations(source)).toEqual([])
  })
})
