import {
  provideAppInitializer,
  provideBrowserGlobalErrorListeners,
  provideZonelessChangeDetection,
  inject,
  type ApplicationConfig,
} from '@angular/core'
import { provideRouter, withComponentInputBinding } from '@angular/router'
import { AuthStore } from './core/auth.store'
import { CapabilitiesStore } from './core/capabilities.store'
import { routes } from './routes'

export const appConfig: ApplicationConfig = {
  providers: [
    provideZonelessChangeDetection(),
    provideBrowserGlobalErrorListeners(),
    provideRouter(routes, withComponentInputBinding()),
    provideAppInitializer(async () => {
      // Both stores are resolved before the first await: inject() only works synchronously
      // inside the injection context, and an await ends it.
      const capabilities = inject(CapabilitiesStore)
      const auth = inject(AuthStore)
      // Capabilities first: the auth guard reads requiresAuth from them.
      await capabilities.load()
      await auth.refresh()
    }),
  ],
}
