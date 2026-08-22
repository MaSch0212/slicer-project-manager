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

      <select (change)="onSort($any($event.target).value)">
        <option value="updatedAt:desc">{{ t.translations().settings.sort }}</option>
        <option value="name:asc">A–Z</option>
        <option value="createdAt:desc">Newest</option>
      </select>

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
    </form>

    @if (store.projects.isLoading()) {
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
  readonly createModel = signal({ name: '' })
  // The same schema the server validates with (spec 2.3).
  protected readonly createForm = form(this.createModel, (path) => {
    validateStandardSchema(path, createProjectSchema)
  })

  protected onSort(value: string): void {
    const [sort, dir] = value.split(':')
    this.store.setSort(sort as 'name' | 'createdAt' | 'updatedAt', dir as 'asc' | 'desc')
  }

  // Public (like LoginPage.onSubmit / ActivatePage.onSubmit): the "does not call create when
  // invalid" test (ruling 58) drives this directly, the same way the auth pages' specs do.
  async onCreate(): Promise<void> {
    // Ruling 58: gate on the shared createProjectSchema via submit(), the same way ruling 53
    // fixed LoginPage — an invalid name never reaches the network, and a rejected attempt
    // surfaces its error in the jig hint instead of the submit silently doing nothing.
    await submit(this.createForm, {
      action: async () => {
        await this.store.create(this.createModel())
        this.createModel.set({ name: '' })
      },
      onInvalid: (field) => {
        field().markAsTouched()
      },
    })
  }

  protected async onRescan(): Promise<void> {
    this.rescanned.set(await this.store.rescan())
  }
}
