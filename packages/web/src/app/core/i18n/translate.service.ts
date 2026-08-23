import { Injectable, effect } from '@angular/core'
import { BaseTranslateService } from '@ngneers/signal-translate'
import en from './locales/en.json'

export type Translations = typeof en
export type Language = 'en' | 'de'

const AVAILABLE_LANGUAGES: readonly Language[] = ['en', 'de']

/**
 * Ruling 74: `en` is statically bundled and always present; `de` is a separate lazy chunk. If
 * that chunk ever fails to load (offline, a stale deploy, a 404), the base class's
 * `_translations` signal would never populate — and app.config.ts awaits `TranslateService.ready`
 * before bootstrap finishes, so an unresolved promise here would hang the whole app on a blank
 * screen. Falling back to `en` keeps "translations are always available" true rather than merely
 * probable.
 *
 * `importDe` is a parameter (rather than a literal `import('./locales/de.json')` inline below)
 * so this can be unit-tested with a rejecting stub: Angular's vitest integration refuses
 * `vi.mock` on relative specifiers ("Please use Angular TestBed for mocking dependencies"), so
 * mocking the dynamic import itself is not an option here.
 *
 * TODO(spec C, Electron): the desktop build must bundle the locale files directly (not fetch
 * them as a dynamic import) so this works with no network at all.
 */
export async function loadDeOrFallbackToEn(
  importDe: () => Promise<{ default: Translations }>,
): Promise<Translations> {
  try {
    return (await importDe()).default
  } catch (error) {
    // Falling back silently would leave a genuinely broken de.json looking like a language
    // that simply renders in English, so say so once — the fallback itself is deliberate.
    console.warn('failed to load the German locale; falling back to English', error)
    return en
  }
}

/**
 * The installed `BaseTranslateService<T>` takes a single type parameter (it hard-codes the
 * `_`-separated translation-key signal) and its constructor is
 * `(availableLanguages: readonly string[], initialLanguage: string | null)` — not the
 * `(defaultLanguage, defaultTranslations)` shape originally assumed. `setLanguage` is
 * synchronous (`void`, not `Promise<void>`): it just writes a signal, and a `constructor`-time
 * `effect()` reactively calls `loadTranslations` and republishes `translations` whenever the
 * language changes (see task-18-report.md for the full comparison against the plan).
 */
@Injectable({ providedIn: 'root' })
export class TranslateService extends BaseTranslateService<Translations> {
  /**
   * Resolves the first time `translations()` is actually populated. The base class starts
   * its internal `_translations` signal at `undefined` and only fills it in from that
   * constructor-time `effect()`, asynchronously — the public `translations` signal's own
   * declared type claims it is always `Translations`, but at runtime there is a real window,
   * right after construction, where it is not. app.config.ts awaits this once in the app
   * initializer so bootstrap cannot finish, and no page can render, during that window.
   */
  readonly ready: Promise<void>

  constructor() {
    super(AVAILABLE_LANGUAGES, 'en')
    this.ready = new Promise<void>((resolve) => {
      const ref = effect(() => {
        // The signal's declared type says this read can never be undefined; the runtime
        // disagrees until the first load lands, hence the cast — we are deliberately
        // checking for the case the type system is told does not exist.
        const value = this.translations() as Translations | undefined
        if (value !== undefined) {
          resolve()
          ref.destroy()
        }
      })
    })
  }

  protected override async loadTranslations(language: string): Promise<Translations> {
    if (language === 'de') return loadDeOrFallbackToEn(() => import('./locales/de.json'))
    return en
  }
}
