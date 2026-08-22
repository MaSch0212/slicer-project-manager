import { Injectable } from '@angular/core'
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
  constructor() {
    super(AVAILABLE_LANGUAGES, 'en')
  }

  protected override async loadTranslations(language: string): Promise<Translations> {
    if (language === 'de') return (await import('./locales/de.json')).default
    return en
  }
}
