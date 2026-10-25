import { createSignal } from 'solid-js'
import type { Language } from '../../api/generated'
import en from './en.json'

export type { Language }
export type Translations = typeof en

type Path<T, Prefix extends string = ''> = {
  [K in keyof T & string]: T[K] extends string ? `${Prefix}${K}` : Path<T[K], `${Prefix}${K}.`>
}[keyof T & string]

/** Every translation key, as a dotted path: `'auth.signIn'`. A typo is a compile error. */
export type TranslationKey = Path<Translations>

export type TranslationParams = Record<string, string | number>

export const LANGUAGES: readonly Language[] = ['en', 'de']

/** `{{ name }}` placeholders. A placeholder with no value is left as written, never `undefined`. */
export function interpolate(template: string, params?: TranslationParams): string {
  if (!params) return template
  return template.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (match, name: string) => {
    const value = params[name]
    return value === undefined ? match : String(value)
  })
}

/** Reads a dotted key out of a translation tree, or `undefined` when it is not a string there. */
export function lookup(translations: unknown, key: string): string | undefined {
  let node: unknown = translations
  for (const part of key.split('.')) {
    if (typeof node !== 'object' || node === null) return undefined
    node = (node as Record<string, unknown>)[part]
  }
  return typeof node === 'string' ? node : undefined
}

/**
 * `en` is bundled into the main chunk and always present; `de` is its own lazy chunk (still a
 * local asset in the desktop build, so it needs no network there). If that chunk fails to load
 * the app must not be left without text, so this falls back to `en` and says so once.
 *
 * `importDe` is a parameter so a test can hand in a rejecting loader.
 */
export async function loadTranslations(
  language: Language,
  importDe: () => Promise<{ default: unknown }> = () => import('./de.json'),
): Promise<Translations> {
  if (language !== 'de') return en
  try {
    return (await importDe()).default as Translations
  } catch (error) {
    console.warn('failed to load the German locale; falling back to English', error)
    return en
  }
}

const [language, setLanguageSignal] = createSignal<Language>('en')
const [translations, setTranslations] = createSignal<Translations>(en)

export { language }

export async function setLanguage(next: Language): Promise<void> {
  const loaded = await loadTranslations(next)
  setTranslations(() => loaded)
  setLanguageSignal(next)
  if (typeof document !== 'undefined') document.documentElement.lang = next
}

/**
 * Translates `key`, reactively: reading it in JSX or an effect re-runs when the language changes.
 * A key missing from the current language falls back to English, and a key missing from both
 * renders as the key itself, which is loud enough to notice and never blank.
 */
export function t(key: TranslationKey, params?: TranslationParams): string {
  const text = lookup(translations(), key) ?? lookup(en, key) ?? key
  return interpolate(text, params)
}
