import type { Provider, EnvironmentProviders } from '@angular/core'
import { provideJigControls } from '@awdlab/jig/api/ng'
import { withDefaultIcons } from '@awdlab/jig/default-icons'
import { nova } from '@awdlab/jig-themes/nova'

/**
 * The jig providers every component spec needs once its template renders a jig control.
 *
 * Without them a control fails at construction with `NG0201: No provider found for Platform`,
 * and an icon slot throws "No icon registry provided" at render — both loudly, by design, so
 * this is not optional setup a spec can skip. Kept in one place so the list cannot drift from
 * `app.config.ts`.
 *
 * `withAutoColorScheme()` is deliberately left out: it registers a service that reads
 * `matchMedia` and writes to the document element, which no component spec needs and which
 * would leak a `dark` class between tests.
 */
export function provideJigForTests(): (Provider | EnvironmentProviders)[] {
  return [...provideJigControls({ theme: { preset: nova }, logLevel: 'error' }, withDefaultIcons())]
}
