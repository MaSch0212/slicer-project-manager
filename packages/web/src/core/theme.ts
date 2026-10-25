import { createSignal } from 'solid-js'
import type { Theme } from '../api/generated'

export type ResolvedTheme = 'light' | 'dark'

const CACHE_KEY = 'spm.theme'

/**
 * What `data-theme` on <html> should be: `light` or `dark` pins the scheme, and `null` (no
 * attribute) leaves it to `color-scheme: light dark` in styles.css, which follows the OS.
 */
export function themeAttribute(theme: Theme): ResolvedTheme | null {
  return theme === 'system' ? null : theme
}

/** The scheme actually in force, for the few things CSS cannot decide (a WebGL clear colour). */
export function resolveTheme(theme: Theme, prefersDark: boolean): ResolvedTheme {
  if (theme === 'system') return prefersDark ? 'dark' : 'light'
  return theme
}

export function isTheme(value: unknown): value is Theme {
  return value === 'light' || value === 'dark' || value === 'system'
}

/**
 * The last theme this browser applied. The authoritative setting lives on the server, but it
 * arrives after the first paint; this is what stops a dark-mode user seeing a light flash first.
 */
export function cachedTheme(storage: Pick<Storage, 'getItem'> | undefined = safeStorage()): Theme {
  try {
    const value = storage?.getItem(CACHE_KEY)
    return isTheme(value) ? value : 'system'
  } catch {
    return 'system'
  }
}

function safeStorage(): Storage | undefined {
  try {
    return typeof localStorage === 'undefined' ? undefined : localStorage
  } catch {
    return undefined
  }
}

export function applyTheme(
  theme: Theme,
  root: HTMLElement = document.documentElement,
  storage: Pick<Storage, 'setItem'> | undefined = safeStorage(),
): void {
  const attribute = themeAttribute(theme)
  if (attribute) root.setAttribute('data-theme', attribute)
  else root.removeAttribute('data-theme')
  try {
    storage?.setItem(CACHE_KEY, theme)
  } catch {
    // Private mode or blocked storage: the cache is a convenience, not state.
  }
}

const query =
  typeof window !== 'undefined' && typeof window.matchMedia === 'function'
    ? window.matchMedia('(prefers-color-scheme: dark)')
    : undefined

const [prefersDark, setPrefersDark] = createSignal(query?.matches ?? false)
query?.addEventListener('change', (event) => setPrefersDark(event.matches))

/** Reactive: whether the OS currently prefers dark. */
export { prefersDark }
