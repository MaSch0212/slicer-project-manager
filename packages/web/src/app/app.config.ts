import {
  provideAppInitializer,
  provideBrowserGlobalErrorListeners,
  provideZonelessChangeDetection,
  inject,
  type ApplicationConfig,
} from '@angular/core'
import { provideRouter, withComponentInputBinding } from '@angular/router'
import { provideJigControls, withAutoColorScheme } from '@awdlab/jig/api/ng'
import { nova } from '@awdlab/jig-themes/nova'
import { AuthStore } from './core/auth.store'
import { CapabilitiesStore } from './core/capabilities.store'
import { TranslateService } from './core/i18n/translate.service'
import { SettingsStore } from './core/settings.store'
import { routes } from './routes'

export const appConfig: ApplicationConfig = {
  providers: [
    provideZonelessChangeDetection(),
    provideBrowserGlobalErrorListeners(),
    provideRouter(routes, withComponentInputBinding()),
    // Theming per Task 18: @awdlab/jig-themes is a runtime CSS engine, not a stylesheet
    // to link — a preset is handed to provideJigControls, which injects its rules into
    // <head>. withAutoColorScheme() registers ColorSchemeService, which App reads/drives
    // for the light/dark/system toggle (see app.ts).
    ...provideJigControls({ theme: { preset: nova } }, withAutoColorScheme()),
    provideAppInitializer(async () => {
      // Every inject() is resolved before the first await: inject() only works synchronously
      // inside the injection context, and an await ends it (NG0203). TranslateService is
      // hoisted here too — even in the unauthenticated branch, constructing it now (rather
      // than after the network round-trips below) gives its constructor-time effect the most
      // possible time to resolve the default 'en' translations before first render.
      const capabilities = inject(CapabilitiesStore)
      const auth = inject(AuthStore)
      const settings = inject(SettingsStore)
      const translate = inject(TranslateService)
      // Capabilities first: the auth guard reads requiresAuth from them.
      await capabilities.load()
      await auth.refresh()
      if (auth.isAuthenticated()) {
        await settings.load()
        // setLanguage is synchronous (see TranslateService) — it swaps which translations
        // are loaded reactively, there is nothing further to await here.
        translate.setLanguage(settings.settings().language)
      }
    }),
  ],
}
