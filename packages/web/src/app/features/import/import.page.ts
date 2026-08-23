import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core'
import { RouterLink } from '@angular/router'
import { InterpolatePipe } from '@ngneers/signal-translate'
import type { ZipImportResultDto } from '@spm/contract/dtos.ts'
import { isAppError } from '@spm/contract/errors.ts'
import { JigButton } from '@awdlab/jig/button'
import { JigIcon } from '@awdlab/jig/icon'
import { JigMessage } from '@awdlab/jig/message'
import { JigSpinner } from '@awdlab/jig/spinner'
import { JigUpload, type JigUploadFile } from '@awdlab/jig/upload'
import tablerFileZip from '@iconify/icons-tabler/file-zip'
import { API_CLIENT } from '../../core/api/api-client.token'
import { formatBytes } from '../../core/format-bytes'
import { TranslateService } from '../../core/i18n/translate.service'

@Component({
  selector: 'spm-import-page',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterLink, InterpolatePipe, JigButton, JigIcon, JigMessage, JigSpinner, JigUpload],
  template: `
    <main class="spm-main spm-main--narrow">
      <div class="spm-stack">
        <div>
          <h1>{{ t.translations().import.heading }}</h1>
          <p class="spm-muted">{{ t.translations().import.intro }}</p>
        </div>

        @if (result(); as done) {
          <jig-message color="success" role="status">
            <div class="spm-stack spm-stack--tight">
              <strong>{{ t.translations().import.doneTitle }}</strong>
              <span>
                {{
                  t.translations().import.done
                    | interpolate
                      : {
                          projects: done.projectsExtracted,
                          files: done.filesExtracted,
                          tags: done.tagsApplied,
                        }
                }}
              </span>
              <span class="spm-muted">{{ formatBytes(done.bytesExtracted) }}</span>
              @if (done.strippedRoot) {
                <span class="spm-muted">
                  {{
                    t.translations().import.strippedRoot | interpolate: { name: done.strippedRoot }
                  }}
                </span>
              }
              @if (done.skipped > 0) {
                <span class="spm-muted">
                  {{ t.translations().import.skipped | interpolate: { count: done.skipped } }}
                </span>
              }
            </div>
          </jig-message>
          <a jigButton kind="primary" routerLink="/projects">
            {{ t.translations().import.viewProjects }}
          </a>
        }

        @if (errorMessage(); as message) {
          <jig-message color="error" role="alert">{{ message }}</jig-message>
        }

        @if (busy()) {
          <div class="spm-card spm-row">
            <jig-spinner [size]="28" />
            <span>{{ t.translations().import.running }}</span>
          </div>
        } @else {
          <!-- confirm mode: the archive queues on drop and only uploads when the user
               presses the control's own Upload button, so a mis-drop costs nothing. -->
          <jig-upload
            #upload="jigUpload"
            mode="confirm"
            confirmTrigger="all"
            (upload)="onUpload($event, upload)"
          >
            <input type="file" accept=".zip,application/zip" />
            <div class="spm-stack spm-stack--tight" style="align-items: center">
              <jig-icon [icon]="icons.zip" style="font-size: 2rem" />
              <span>{{ t.translations().import.pick }}</span>
            </div>
          </jig-upload>
        }
      </div>
    </main>
  `,
})
export class ImportPage {
  private readonly api = inject(API_CLIENT)
  protected readonly t = inject(TranslateService)
  protected readonly formatBytes = formatBytes
  protected readonly icons = { zip: tablerFileZip }

  readonly busy = signal(false)
  readonly result = signal<ZipImportResultDto | null>(null)
  readonly errorMessage = signal<string | null>(null)

  /**
   * `jig-upload` hands over every pending file at once, but the endpoint takes one archive:
   * a CuraManager library is a single zip, and importing two in parallel would race on the
   * same collision check. Only the first is used; the rest are released rather than left
   * spinning.
   */
  async onUpload(files: JigUploadFile[], upload: JigUpload): Promise<void> {
    const [first, ...rest] = files
    for (const extra of rest) upload.markFailed(extra.id)
    if (!first) return

    this.errorMessage.set(null)
    this.result.set(null)

    if (!/\.zip$/i.test(first.file.name)) {
      upload.markFailed(first.id)
      this.errorMessage.set(this.t.translations().import.notZip)
      return
    }

    this.busy.set(true)
    try {
      // The blob arm, not the stream arm: `content-length` is a forbidden fetch header, so a
      // script-set one is stripped and the server's 411 precheck would reject every stream
      // upload from a browser. A File already is a Blob, so fetch derives the length itself.
      this.result.set(await this.api.importer.curaManagerZip({ blob: first.file }))
      upload.markDone(first.id)
    } catch (error) {
      upload.markFailed(first.id)
      // A collision or an archive with no projects in it is the user's to fix and says
      // exactly what to do, so it is worth showing verbatim; anything else is ours.
      this.errorMessage.set(
        isAppError(error) && (error.code === 'Conflict' || error.code === 'Validation')
          ? error.message
          : this.t.translations().import.failed,
      )
    } finally {
      this.busy.set(false)
    }
  }
}
