import { Component } from '@angular/core'

/**
 * Scaffold for the desktop-only routes: spec D replaces it with /settings/slicers and spec E
 * with /browse. It exists so the fileReplacements seam has something real to exclude — this
 * file must stay reachable only from routes.electron.ts, never from routes.ts.
 */
@Component({
  selector: 'app-desktop-placeholder-page',
  template: `<h1>Desktop only</h1>`,
})
export class DesktopPlaceholderPage {}
