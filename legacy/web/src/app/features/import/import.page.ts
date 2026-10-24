import { ChangeDetectionStrategy, Component, inject } from '@angular/core'
import { TranslateService } from '../../core/i18n/translate.service'
import { ImportPanel } from './import.panel'

/**
 * `/import`, kept resolving after spec G 6.2 moved the import surface onto the settings General
 * tab: the links and bookmarks that already point here go on working, and the navigation entry
 * that used to point at it is gone.
 *
 * All this page contributes is the landmark and the heading. Everything the import actually does
 * lives in `ImportPanel`, which the settings card renders too — reused rather than reimplemented,
 * so a change to the upload behaviour cannot land in one of the two places and not the other.
 */
@Component({
  selector: 'spm-import-page',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [ImportPanel],
  template: `
    <main class="spm-main spm-main--narrow">
      <div class="spm-stack">
        <h1>{{ t.translations().import.heading }}</h1>
        <spm-import-panel />
      </div>
    </main>
  `,
})
export class ImportPage {
  protected readonly t = inject(TranslateService)
}
