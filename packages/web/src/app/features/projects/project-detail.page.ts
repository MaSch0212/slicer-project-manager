import {
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
  input,
  linkedSignal,
  resource,
  signal,
} from '@angular/core'
import { Router, RouterLink } from '@angular/router'
import { FormField, form, submit, validateStandardSchema } from '@angular/forms/signals'
import { interpolate } from '@ngneers/signal-translate'
import { JigErrors } from '@awdlab/jig/errors'
import { JigHint } from '@awdlab/jig/hint'
import { JigInput } from '@awdlab/jig/input'
import { JigInputField } from '@awdlab/jig/input-field'
import type { FileDto, ProjectDetailDto } from '@spm/contract/dtos.ts'
import { isAppError, type QuotaExceededDetails } from '@spm/contract/errors.ts'
import {
  fileNameSchema,
  projectPatchSchema,
  tagNameSchema,
  type ProjectPatchInput,
} from '@spm/contract/schemas.ts'
import { API_CLIENT } from '../../core/api/api-client.token'
import { TranslateService } from '../../core/i18n/translate.service'

const UNITS = ['B', 'kB', 'MB', 'GB', 'TB']

type EditModel = { name: string; website: string; notes: string; isArchived: boolean }

/**
 * projectPatchSchema spells "no website" as `null`, but a text input can only ever hand back
 * `''` — which `z.url()` rejects, leaving the user unable to clear a website they once set.
 * The empty case therefore validates against the very same schema minus that one field
 * (`.omit`, so no constraint is restated here), and the patch carries `null` instead.
 */
const PATCH_WITHOUT_WEBSITE = projectPatchSchema.omit({ website: true })

/**
 * The single definition of "the website field is empty". Both readers — the validator arm the
 * form picks, and the value the patch carries — go through this, so the two can never drift
 * into a state where a value validated by the no-website arm is sent as a non-null string.
 */
function websiteOrNull(value: string): string | null {
  const trimmed = value.trim()
  return trimmed === '' ? null : trimmed
}

function toEditModel(detail: ProjectDetailDto | undefined): EditModel {
  return {
    name: detail?.name ?? '',
    website: detail?.website ?? '',
    notes: detail?.notes ?? '',
    isArchived: detail?.isArchived ?? false,
  }
}

function sameEditModel(a: EditModel, b: EditModel): boolean {
  return (
    a.name === b.name &&
    a.website === b.website &&
    a.notes === b.notes &&
    a.isArchived === b.isArchived
  )
}

@Component({
  selector: 'spm-project-detail-page',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterLink, FormField, JigInputField, JigInput, JigHint, JigErrors],
  template: `
    @if (loadFailed()) {
      <!--
        Ruling 62: reading project.value() after a settled failure throws a
        ResourceValueError, so the error branch has to come first and must not touch it. A
        404 (deleted project, stale bookmark, someone else's id) reads differently from a
        transient failure, and either way there is a way back to the list.
      -->
      <p role="alert">{{ loadErrorMessage() }}</p>
      <a [routerLink]="['/projects']">{{ t.translations().projects.backToProjects }}</a>
    } @else {
      @if (loaded(); as detail) {
        <header>
          <a [routerLink]="['/projects']">{{ t.translations().projects.backToProjects }}</a>
          <h1>{{ detail.name }}</h1>
          @if (detail.isArchived) {
            <span>{{ t.translations().projects.archived }}</span>
          }
          @if (detail.state === 'missing') {
            <p role="alert">{{ t.translations().projects.missing }}</p>
          }
          <!-- One alert for every mutation on the page (ruling 64). -->
          @if (errorMessage()) {
            <p role="alert">{{ errorMessage() }}</p>
          }
        </header>

        <dl>
          <dt>{{ t.translations().projects.website }}</dt>
          <dd>
            @if (detail.website) {
              <a [href]="detail.website" target="_blank" rel="noreferrer noopener">
                {{ detail.website }}
              </a>
            }
          </dd>
          <dt>{{ t.translations().projects.notes }}</dt>
          <dd>{{ detail.notes }}</dd>
        </dl>

        <!--
          Ruling 66: without this form projects.update and projectPatchSchema were reachable
          from nowhere in the web package — no way to rename a project, edit its notes or
          website, or archive it, while the project list already filters and badges archived
          projects. Deliberately plain: a form, not a dialog.
        -->
        <section>
          <h2>{{ t.translations().projects.edit }}</h2>
          <form (submit)="onSaveEdit(); $event.preventDefault()">
            <jig-input-field [label]="t.translations().projects.name">
              <input jigInput [formField]="editForm.name" jigErrors [jigErrorsHint]="nameHint" />
              <jig-hint #nameHint />
            </jig-input-field>

            <jig-input-field [label]="t.translations().projects.website">
              <input
                jigInput
                inputmode="url"
                [formField]="editForm.website"
                jigErrors
                [jigErrorsHint]="websiteHint"
              />
              <jig-hint #websiteHint />
            </jig-input-field>

            <jig-input-field [label]="t.translations().projects.notes">
              <textarea
                jigInput
                [formField]="editForm.notes"
                jigErrors
                [jigErrorsHint]="notesHint"
              ></textarea>
              <jig-hint #notesHint />
            </jig-input-field>

            <label>
              <input type="checkbox" [formField]="editForm.isArchived" />
              <!--
                Its own key, not the badge's: a non-archived project rendering the bare word
                "Archived" beside a checkbox read as a state, not an action — and it made the
                badge impossible to assert on, since the word was on the page either way.
              -->
              {{ t.translations().projects.archive }}
            </label>

            <button type="submit" [disabled]="editForm().submitting()">
              {{ t.translations().projects.save }}
            </button>
          </form>
        </section>

        <section>
          <h2>{{ t.translations().projects.tags }}</h2>
          @for (tag of detail.tags; track tag) {
            <span>
              {{ tag }}
              <button
                type="button"
                (click)="onRemoveTag(tag)"
                [attr.aria-label]="t.translations().projects.removeTag + ' ' + tag"
              >
                x
              </button>
            </span>
          }
          <input
            type="text"
            [attr.aria-label]="t.translations().projects.addTag"
            (keydown.enter)="onTagInput($event)"
          />
        </section>

        <section>
          <h2>{{ t.translations().projects.files }}</h2>
          <input
            type="file"
            [attr.aria-label]="t.translations().projects.upload"
            (change)="onFileInput($event)"
          />

          <ul>
            @for (file of detail.files; track file.id) {
              <li>
                @if (file.thumbUrl) {
                  <img [src]="file.thumbUrl" [alt]="file.name" width="128" height="128" />
                } @else {
                  <span>{{ t.translations().projects.previewPending }}</span>
                }
                <a [href]="file.rawUrl">{{ file.name }}</a>
                <span>{{ formatBytes(file.sizeBytes) }}</span>
                @if (file.slicer) {
                  <span>{{ file.slicer }}</span>
                }

                <!-- Ruling 66: files.rename was unreachable from the whole web package. -->
                @if (renamingId() === file.id) {
                  <jig-input-field [label]="t.translations().projects.newName">
                    <input
                      jigInput
                      [value]="renameDraft()"
                      (valueChange)="renameDraft.set($event ?? '')"
                    />
                  </jig-input-field>
                  <button type="button" (click)="onRenameFile(file, renameDraft())">
                    {{ t.translations().projects.save }}
                  </button>
                  <button type="button" (click)="cancelRename()">
                    {{ t.translations().projects.cancel }}
                  </button>
                } @else {
                  <button type="button" (click)="startRename(file)">
                    {{ t.translations().projects.rename }}
                  </button>
                }

                <button
                  type="button"
                  (click)="onDeleteFile(file)"
                  [attr.aria-label]="t.translations().projects.deleteFile + ' ' + file.name"
                >
                  x
                </button>
              </li>
            }
          </ul>
        </section>

        <section>
          <label>
            <input
              type="checkbox"
              [checked]="deleteFiles()"
              (change)="deleteFiles.set($any($event.target).checked)"
            />
            {{ t.translations().projects.deleteFiles }}
          </label>

          <!--
            Ruling 67: with the box ticked this erases every file of the project from disk,
            irreversibly. The first press only arms it and states the real consequence; the
            second one carries it out.
          -->
          @if (deleteArmed()) {
            <p role="alert">
              {{
                deleteFiles()
                  ? t.translations().projects.confirmDeleteWithFiles
                  : t.translations().projects.confirmDelete
              }}
            </p>
            <button type="button" (click)="onDeleteProject(deleteFiles())">
              {{ t.translations().projects.confirmDeleteAction }}
            </button>
            <button type="button" (click)="cancelDelete()">
              {{ t.translations().projects.cancel }}
            </button>
          } @else {
            <button type="button" (click)="onDeleteProject(deleteFiles())">
              {{ t.translations().projects.delete }}
            </button>
          }
        </section>
      } @else {
        <p>...</p>
      }
    }
  `,
})
export class ProjectDetailPage {
  private readonly api = inject(API_CLIENT)
  private readonly router = inject(Router)
  protected readonly t = inject(TranslateService)

  readonly id = input.required<string>()

  readonly project = resource({
    params: () => this.id(),
    loader: ({ params }) => this.api.projects.get(params),
  })

  /**
   * `Resource.value()` throws once a load settles to the public 'error' status, so every read
   * of it — here and in the template — is gated on this first (the same pattern as
   * ProjectsStore.loadFailed). `Resource<T>` exposes no `isError()`; `status()` is the
   * public way to ask.
   */
  readonly loadFailed = computed(() => this.project.status() === 'error')

  /** undefined while loading, and (unlike `value()`) safe to read after a failed load. */
  protected readonly loaded = computed<ProjectDetailDto | undefined>(() =>
    this.project.hasValue() ? this.project.value() : undefined,
  )

  protected readonly loadErrorMessage = computed(() =>
    this.loadFailed() ? this.describe(this.project.error()) : null,
  )

  /**
   * Everything below is per-project state, keyed on `id` through linkedSignal, because the
   * router reuses this one component instance across a `:id` change — it only swaps the
   * input. Without that, an error from one project would render over the next one, and (much
   * worse, ruling 67) a delete armed on one project would still be armed on the next, so a
   * single press would destroy the wrong project's files.
   */
  readonly errorMessage = linkedSignal<string, string | null>({
    source: this.id,
    computation: () => null,
  })

  /** The file currently being renamed, and the name being typed for it. */
  readonly renamingId = linkedSignal<string, string | null>({
    source: this.id,
    computation: () => null,
  })
  readonly renameDraft = signal('')

  /** Ruling 67: the delete needs a second, informed press before it destroys anything. */
  readonly deleteFiles = linkedSignal<string, boolean>({
    source: this.id,
    computation: () => false,
  })
  readonly deleteArmed = linkedSignal<string, boolean>({
    source: this.id,
    computation: () => false,
  })

  /**
   * Seeded from the project, but re-seeded only when the project's identity or its *stored*
   * values actually change — not merely when the resource reloads.
   *
   * Every mutation on this page ends in `project.reload()`, and each reload resolves to a
   * fresh DTO object. Keying this on the loaded DTO alone therefore threw away whatever the
   * user had typed but not yet saved the moment they added a tag, uploaded a file or deleted
   * one — silently, and with the typed text unrecoverable. Comparing the stored values keeps
   * both halves of the guarantee: an in-progress edit survives an unrelated mutation, while a
   * first load, a successful save and an external change all still re-seed the form to what
   * is really stored.
   */
  readonly editModel = linkedSignal<{ id: string; stored: EditModel }, EditModel>({
    source: () => ({ id: this.id(), stored: toEditModel(this.loaded()) }),
    computation: (next, previous) => {
      const unchanged =
        previous !== undefined &&
        previous.source.id === next.id &&
        sameEditModel(previous.source.stored, next.stored)
      return unchanged ? previous.value : next.stored
    },
  })

  // The same schema the server validates with (spec 2.3), via submit() so the field errors
  // land in the jig hints instead of coming back as an undisplayed 400.
  protected readonly editForm = form(this.editModel, (path) => {
    validateStandardSchema(path, ({ value }) =>
      websiteOrNull(value().website) === null ? PATCH_WITHOUT_WEBSITE : projectPatchSchema,
    )
  })

  formatBytes(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`
    let value = bytes
    let unit = 0
    while (value >= 1024 && unit < UNITS.length - 1) {
      value /= 1024
      unit++
    }
    return `${value.toFixed(1)} ${UNITS[unit]}`
  }

  protected async onFileInput(event: Event): Promise<void> {
    const element = event.target as HTMLInputElement
    const file = element.files?.[0]
    if (!file) return
    await this.onUpload(file)
    // Let the same file be picked again — e.g. after freeing up quota.
    element.value = ''
  }

  async onUpload(file: File): Promise<void> {
    // Ruling 61: the `blob` arm, never the `stream` one. `Content-Length` is a forbidden
    // header name, so a script-set one is stripped and a ReadableStream body has no length
    // the browser can compute — the server, which hard-requires the header, then answers 411.
    // A File *is* a Blob, so handing it straight to fetch lets the browser set the length
    // itself (and avoids `duplex: 'half'`, which is Chromium-and-HTTP/2-only).
    await this.mutate(() => this.api.files.upload(this.id(), file.name, { blob: file }))
  }

  /** Resolves to whether the tag was actually added, so the input only clears on success. */
  async onAddTag(name: string): Promise<boolean> {
    // Ruling 65: tagNameSchema is what the server validates with — a 61-character tag used
    // to round-trip to a 400 that nothing displayed. safeParse also trims for us.
    const parsed = tagNameSchema.safeParse(name)
    if (!parsed.success) {
      this.errorMessage.set(this.t.translations().errors.invalidTag)
      return false
    }
    return await this.mutate(() => this.api.projects.addTag(this.id(), parsed.data))
  }

  protected async onTagInput(event: Event): Promise<void> {
    const element = event.target as HTMLInputElement
    // Only wipe the field once the tag is in. A rejected one (too long, a duplicate, a
    // network failure) stays put next to the error, so it can be corrected rather than
    // retyped from scratch.
    if (await this.onAddTag(element.value)) element.value = ''
  }

  async onRemoveTag(name: string): Promise<void> {
    await this.mutate(() => this.api.projects.removeTag(this.id(), name))
  }

  startRename(file: FileDto): void {
    this.renamingId.set(file.id)
    this.renameDraft.set(file.name)
  }

  cancelRename(): void {
    this.renamingId.set(null)
  }

  async onRenameFile(file: FileDto, name: string): Promise<void> {
    // The server's own file-name validator (spec 2.3): path separators, the Windows-reserved
    // set and reserved device names never reach the network.
    const parsed = fileNameSchema.safeParse(name)
    if (!parsed.success) {
      this.errorMessage.set(this.t.translations().errors.invalidFileName)
      return
    }
    await this.mutate(async () => {
      await this.api.files.rename(file.id, parsed.data)
      this.renamingId.set(null)
    })
  }

  async onDeleteFile(file: FileDto): Promise<void> {
    await this.mutate(() => this.api.files.delete(file.id))
  }

  cancelDelete(): void {
    this.deleteArmed.set(false)
  }

  async onDeleteProject(deleteFiles: boolean): Promise<void> {
    this.errorMessage.set(null)
    if (!this.deleteArmed()) {
      // Ruling 67: arm only. Record the choice too, so the confirmation states the real
      // consequence even when the flag comes from the caller rather than the checkbox.
      this.deleteFiles.set(deleteFiles)
      this.deleteArmed.set(true)
      return
    }
    try {
      await this.api.projects.delete(this.id(), { deleteFiles })
      // Disarm as soon as the project is gone: whether the navigation lands or not, there is
      // nothing left here to confirm, and a live "yes, delete" button on an already-deleted
      // project is misleading at best.
      this.deleteArmed.set(false)
      if (!(await this.router.navigate(['/projects']))) {
        // A guard refused it, or the navigation failed. The delete did happen, so say
        // something rather than leaving the user on a page that no longer exists.
        this.errorMessage.set(this.t.translations().errors.generic)
      }
    } catch (error) {
      // Ruling 64: a Forbidden, a 404 or a network blip must show, not vanish. Disarm as
      // well — a live "yes, delete" button must not outlast a failure unexplained.
      this.errorMessage.set(this.describe(error))
      this.deleteArmed.set(false)
    }
  }

  async onSaveEdit(): Promise<void> {
    this.errorMessage.set(null)
    await submit(this.editForm, {
      // `submit` runs `action` only when the form is valid, and it is try/finally with no
      // catch — so a rejected network call inside `action` would otherwise escape as an
      // unhandled rejection (the same reason LoginPage/ProjectsPage catch inside theirs).
      action: async () => {
        const model = this.editModel()
        const patch: ProjectPatchInput = {
          name: model.name.trim(),
          // Nullable in the schema: an emptied field means "no website"/"no notes", which
          // has to reach the API as null rather than as ''. websiteOrNull is the same helper
          // the validator arm above is chosen by, so the two cannot disagree.
          website: websiteOrNull(model.website),
          notes: model.notes.trim() === '' ? null : model.notes,
          isArchived: model.isArchived,
        }
        try {
          await this.api.projects.update(this.id(), patch)
          this.project.reload()
        } catch (error) {
          this.errorMessage.set(this.describe(error))
        }
      },
      // jigErrors shows on `touched`, so an untouched invalid field would fail silently.
      onInvalid: (field) => {
        field().markAsTouched()
      },
    })
  }

  /**
   * Every mutation on this page routes through here (ruling 64): one error surface, one
   * reload, and nothing escaping as an unhandled rejection. Resolves to whether it worked,
   * for the callers that need to know (the tag input keeps its text on a failure).
   */
  private async mutate(action: () => Promise<unknown>): Promise<boolean> {
    this.errorMessage.set(null)
    try {
      await action()
      this.project.reload()
      return true
    } catch (error) {
      this.errorMessage.set(this.describe(error))
      return false
    }
  }

  private describe(error: unknown): string {
    const messages = this.t.translations().errors
    if (isAppError(error)) {
      if (error.code === 'QuotaExceeded') {
        const details = error.details as QuotaExceededDetails | undefined
        if (details) {
          // Ruling 63: TranslateService has no `interpolate` method — the package exports a
          // standalone function, and the InterpolatePipe is template-only.
          return interpolate(messages.quotaExceeded, {
            usage: this.formatBytes(details.usageBytes),
            quota: this.formatBytes(details.quotaBytes),
          })
        }
      }
      if (error.code === 'NotFound') return messages.notFound
    }
    return messages.generic
  }
}
