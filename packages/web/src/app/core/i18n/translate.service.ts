import { Injectable, effect } from '@angular/core'
import { BaseTranslateService } from '@ngneers/signal-translate'
import en from './locales/en.json'

export type Translations = typeof en
export type Language = 'en' | 'de'

const AVAILABLE_LANGUAGES: readonly Language[] = ['en', 'de']

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
    if (language === 'de') return (await import('./locales/de.json')).default
    return en
  }
}
