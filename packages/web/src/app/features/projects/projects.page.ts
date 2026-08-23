import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core'
import { RouterLink } from '@angular/router'
import { FormField, form, submit, validateStandardSchema } from '@angular/forms/signals'
import { InterpolatePipe } from '@ngneers/signal-translate'
import { createProjectSchema } from '@spm/contract/schemas.ts'
import type { RescanResultDto } from '@spm/contract/dtos.ts'
import { JigErrors } from '@awdlab/jig/errors'
import { JigHint } from '@awdlab/jig/hint'
import { JigInput } from '@awdlab/jig/input'
import { JigInputField } from '@awdlab/jig/input-field'
import { SettingsStore } from '../../core/settings.store'
import { TranslateService } from '../../core/i18n/translate.service'
import { ProjectsStore } from './projects.store'

@Component({
  selector: 'spm-projects-page',
  imports: [RouterLink, FormField, JigInputField, JigInput, JigHint, JigErrors, InterpolatePipe],
  providers: [ProjectsStore],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <header>
      <h1>{{ t.translations().projects.title }}</h1>
      <button type="button" (click)="onRescan()">{{ t.translations().projects.rescan }}</button>
      @if (rescanned()) {
        <p role="status">
          {{
            t.translations().projects.rescanned
              | interpolate: { adopted: rescanned()!.adopted, filesAdded: rescanned()!.filesAdded }
          }}
        </p>
      }
      @if (rescanError()) {
        <p role="alert">{{ t.translations().errors.generic }}</p>
      }
    </header>

    <section>
      <input
        type="search"
        [attr.aria-label]="t.translations().projects.search"
        (input)="store.setSearch($any($event.target).value)"
      />

      <label>
        <input
          type="checkbox"
          [checked]="store.query().includeArchived === true"
          (change)="store.setIncludeArchived($any($event.target).checked)"
        />
        {{ t.translations().projects.includeArchived }}
      </label>

      <!-- [value] reflects the persisted choice, so revisiting the page shows the sort the
           user actually saved rather than always the first option. -->
      <select
        [attr.aria-label]="t.translations().settings.sort"
        [value]="store.query().sort + ':' + store.query().dir"
        (change)="onSort($any($event.target).value)"
      >
        <option value="updatedAt:desc">{{ t.translations().settings.sortUpdated }}</option>
        <option value="name:asc">{{ t.translations().settings.sortName }}</option>
        <option value="createdAt:desc">{{ t.translations().settings.sortNewest }}</option>
      </select>
      @if (sortError()) {
        <p role="alert">{{ t.translations().errors.generic }}</p>
      }

      @for (tag of store.knownTags(); track tag) {
        <button
          type="button"
          [attr.aria-pressed]="(store.query().tags ?? []).includes(tag)"
          (click)="store.toggleTag(tag)"
        >
          {{ tag }}
        </button>
      }
    </section>

    <form (submit)="onCreate(); $event.preventDefault()">
      <jig-input-field [label]="t.translations().projects.name">
        <input jigInput [formField]="createForm.name" jigErrors [jigErrorsHint]="nameHint" />
        <jig-hint #nameHint />
      </jig-input-field>
      <button type="submit" [disabled]="createForm().submitting()">
        {{ t.translations().projects.newProject }}
      </button>
      @if (createError()) {
        <p role="alert">{{ t.translations().errors.generic }}</p>
      }
    </form>

    @if (store.loadFailed()) {
      <p role="alert">{{ t.translations().errors.generic }}</p>
    } @else if (store.projects.isLoading()) {
      <p>...</p>
    } @else if (store.projects.value().length === 0) {
      <p>{{ t.translations().projects.empty }}</p>
    } @else {
      <ul [class]="settings.settings().viewMode">
        @for (project of store.projects.value(); track project.id) {
          <li>
            <a [routerLink]="['/projects', project.id]">
              @if (project.coverThumbUrl) {
                <img [src]="project.coverThumbUrl" [alt]="project.name" width="256" height="256" />
              } @else {
                <span>{{ t.translations().projects.previewPending }}</span>
              }
              <h2>{{ project.name }}</h2>
            </a>
            <p>
              {{ project.fileCounts.model }} / {{ project.fileCounts.slicerProject }} /
              {{ project.fileCounts.other }}
            </p>
            @if (project.isArchived) {
              <span>{{ t.translations().projects.archived }}</span>
            }
            @if (project.state === 'missing') {
              <span role="alert">{{ t.translations().projects.missing }}</span>
            }
            @for (tag of project.tags; track tag) {
              <span>{{ tag }}</span>
            }
          </li>
        }
      </ul>
    }
  `,
})
export class ProjectsPage {
  protected readonly store = inject(ProjectsStore)
  protected readonly settings = inject(SettingsStore)
  protected readonly t = inject(TranslateService)

  readonly rescanned = signal<RescanResultDto | null>(null)
  readonly rescanError = signal(false)
  readonly sortError = signal(false)
  readonly createModel = signal({ name: '' })
  readonly createError = signal(false)
  // The same schema the server validates with (spec 2.3).
  protected readonly createForm = form(this.createModel, (path) => {
    validateStandardSchema(path, createProjectSchema)
  })

  // Public, like onCreate/onRescan: the spec drives it directly. `setSort` now also persists
  // the choice, so the rejection needs catching — a template `(change)` binding cannot
  // handle one, and the sort itself has already been applied locally regardless.
  async onSort(value: string): Promise<void> {
    this.sortError.set(false)
    const [sort, dir] = value.split(':')
    try {
      await this.store.setSort(sort as 'name' | 'createdAt' | 'updatedAt', dir as 'asc' | 'desc')
    } catch {
      this.sortError.set(true)
    }
  }

  // Public (like LoginPage.onSubmit / ActivatePage.onSubmit): the "does not call create when
  // invalid" test (ruling 58) and the create-rejection test (fix round 1) drive this directly,
  // the same way the auth pages' specs do.
  async onCreate(): Promise<void> {
    this.createError.set(false)
    await submit(this.createForm, {
      // Ruling 58: gate on the shared createProjectSchema via submit() — an invalid name
      // never reaches the network. Note `submit()`'s own guarantee stops there: it is
      // `try { … } finally { … }` with no catch, so a *rejected* `action` (a real network or
      // server failure, as opposed to a client-side validation failure) would otherwise
      // escape as an unhandled rejection — `jigErrors`/`onInvalid` only ever fire for
      // schema-validation failures, never for an exception thrown inside `action`. Hence the
      // try/catch below, matching LoginPage/ActivatePage's own pattern for their network
      // calls. A failed create leaves the typed name in place (it stays in `createModel`)
      // so the user can just retry, rather than having to retype it.
      action: async () => {
        try {
          await this.store.create(this.createModel())
          this.createModel.set({ name: '' })
        } catch {
          this.createError.set(true)
        }
      },
      onInvalid: (field) => {
        field().markAsTouched()
      },
    })
  }

  // Public, for the same reason as onCreate: the rescan-rejection test drives this directly.
  async onRescan(): Promise<void> {
    this.rescanError.set(false)
    // Clear the previous run's summary too: the banner and the alert are independent @if
    // blocks, so a stale success would otherwise render beside a fresh failure.
    this.rescanned.set(null)
    try {
      this.rescanned.set(await this.store.rescan())
    } catch {
      // A rescan is a one-shot action, not a form (spec: nothing to preserve on failure) —
      // it just needs to surface visibly instead of escaping as an unhandled rejection.
      this.rescanError.set(true)
    }
  }
}
