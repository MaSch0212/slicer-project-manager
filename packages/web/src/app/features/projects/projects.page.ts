import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core'
import { RouterLink } from '@angular/router'
import { FormField, form, submit, validateStandardSchema } from '@angular/forms/signals'
import { InterpolatePipe } from '@ngneers/signal-translate'
import { createProjectSchema } from '@spm/contract/schemas.ts'
import type { RescanResultDto } from '@spm/contract/dtos.ts'
import { JigButton } from '@awdlab/jig/button'
import { JigCheckbox } from '@awdlab/jig/checkbox'
import { JigErrors } from '@awdlab/jig/errors'
import { JigHint } from '@awdlab/jig/hint'
import { JigIcon } from '@awdlab/jig/icon'
import { JigInput } from '@awdlab/jig/input'
import { JigInputField } from '@awdlab/jig/input-field'
import { JigMessage } from '@awdlab/jig/message'
import { JigSelect } from '@awdlab/jig/select'
import { JigSpinner } from '@awdlab/jig/spinner'
import { JigTag } from '@awdlab/jig/tag'
import { JigToggleButton } from '@awdlab/jig/toggle-button'
import tablerPlus from '@iconify/icons-tabler/plus'
import tablerRefresh from '@iconify/icons-tabler/refresh'
import tablerSearch from '@iconify/icons-tabler/search'
import { SettingsStore } from '../../core/settings.store'
import { TranslateService } from '../../core/i18n/translate.service'
import { ProjectsStore } from './projects.store'

@Component({
  selector: 'spm-projects-page',
  imports: [
    RouterLink,
    FormField,
    InterpolatePipe,
    JigButton,
    JigCheckbox,
    JigErrors,
    JigHint,
    JigIcon,
    JigInput,
    JigInputField,
    JigMessage,
    JigSelect,
    JigSpinner,
    JigTag,
    JigToggleButton,
  ],
  providers: [ProjectsStore],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <main class="spm-main">
      <div class="spm-page-head">
        <h1>{{ t.translations().projects.title }}</h1>
        <button jigButton kind="secondary" type="button" (click)="onRescan()">
          <jig-icon [icon]="icons.rescan" />
          {{ t.translations().projects.rescan }}
        </button>
      </div>

      @if (rescanned(); as summary) {
        <jig-message color="info" role="status" class="spm-block-mb">
          {{
            t.translations().projects.rescanned
              | interpolate: { adopted: summary.adopted, filesAdded: summary.filesAdded }
          }}
        </jig-message>
      }
      @if (rescanError()) {
        <jig-message color="error" role="alert" class="spm-block-mb">
          {{ t.translations().errors.generic }}
        </jig-message>
      }

      <section class="spm-card spm-stack spm-filters">
        <div class="spm-row">
          <jig-input-field
            class="spm-grow"
            [label]="t.translations().projects.search"
            labelKind="on"
          >
            <jig-icon [icon]="icons.search" />
            <input jigInput [value]="store.query().search ?? ''" (input)="onSearch($event)" />
          </jig-input-field>

          <jig-input-field
            inputId="projects-sort"
            [label]="t.translations().settings.sort"
            labelKind="on"
          >
            <jig-select
              inputId="projects-sort"
              [label]="t.translations().settings.sort"
              [options]="sortOptions()"
              [value]="sortValue()"
              (valueChange)="onSort($event)"
            />
          </jig-input-field>

          <span class="spm-check">
            <jig-checkbox
              #archivedBox
              [value]="store.query().includeArchived === true"
              (valueChange)="store.setIncludeArchived($event === true)"
            />
            <label [for]="archivedBox.inputId()">
              {{ t.translations().projects.includeArchived }}
            </label>
          </span>
        </div>

        @if (store.knownTags().length > 0) {
          <div class="spm-row spm-tags">
            @for (tag of store.knownTags(); track tag) {
              <jig-toggle-button
                [label]="tag"
                [value]="activeTags().has(tag)"
                (valueChange)="store.toggleTag(tag)"
              />
            }
          </div>
        }
        @if (sortError()) {
          <jig-message color="error" role="alert">{{
            t.translations().errors.generic
          }}</jig-message>
        }
      </section>

      <form class="spm-row spm-new-project" (submit)="onCreate(); $event.preventDefault()">
        <div class="spm-field spm-grow">
          <jig-input-field [label]="t.translations().projects.name" labelKind="on">
            <input jigInput [formField]="createForm.name" jigErrors [jigErrorsHint]="nameHint" />
          </jig-input-field>
          <jig-hint #nameHint />
        </div>
        <button jigButton kind="primary" type="submit" [disabled]="createForm().submitting()">
          <jig-icon [icon]="icons.add" />
          {{ t.translations().projects.newProject }}
        </button>
      </form>
      @if (createError()) {
        <jig-message color="error" role="alert" class="spm-block-mb">
          {{ t.translations().errors.generic }}
        </jig-message>
      }

      @if (store.loadFailed()) {
        <jig-message color="error" role="alert">{{ t.translations().errors.generic }}</jig-message>
      } @else if (store.projects.isLoading()) {
        <jig-spinner centered [size]="40" />
      } @else if (store.items().length === 0) {
        <div class="spm-empty">
          <jig-icon [icon]="icons.search" style="font-size: 2rem" />
          <p>{{ t.translations().projects.empty }}</p>
        </div>
      } @else {
        <ul class="spm-projects" [class]="settings.settings().viewMode">
          @for (project of store.items(); track project.id) {
            <li class="spm-project">
              <a class="spm-project-link" [routerLink]="['/projects', project.id]">
                <span class="spm-thumb">
                  @if (project.coverThumbUrl) {
                    <img
                      [src]="project.coverThumbUrl"
                      [alt]="project.name"
                      width="256"
                      height="256"
                    />
                  } @else {
                    <span>{{ t.translations().projects.previewPending }}</span>
                  }
                </span>
                <span class="spm-project-body">
                  <!-- A heading, not a styled span: the card grid is how the library is
                       navigated, so each project has to be reachable by heading. -->
                  <h2 class="spm-project-title">{{ project.name }}</h2>
                  <span class="spm-muted">
                    {{ project.fileCounts.model }} / {{ project.fileCounts.slicerProject }} /
                    {{ project.fileCounts.other }}
                  </span>
                  <span class="spm-tags">
                    @if (project.isArchived) {
                      <jig-tag color="surface">{{ t.translations().projects.archived }}</jig-tag>
                    }
                    @if (project.state === 'missing') {
                      <jig-tag color="error" role="alert">
                        {{ t.translations().projects.missing }}
                      </jig-tag>
                    }
                    @for (tag of project.tags; track tag) {
                      <jig-tag color="primary">{{ tag }}</jig-tag>
                    }
                  </span>
                </span>
              </a>
            </li>
          }
        </ul>

        <!-- The list only ever holds the pages fetched so far, so it needs a floor that says
             whether there is more and offers a way to get it.

             The button is required, not a fallback (spec 7.5, constraint C6): a list that grows
             only on a scroll event cannot be reached by someone navigating with a keyboard or a
             screen reader, both of which move focus without ever scrolling a container. It is
             also the only path to rows 49 and beyond until the scroll trigger lands.

             The button is NOT disabled while its page loads, and that is the accessibility fix
             rather than an omission (fix round 1, finding 2): disabling the element that
             currently has focus drops focus to the body, so the next page would cost a keyboard
             user a re-tab through every card already on screen -- the precise cost C6 exists to
             avoid, paid once per page. loadMore already refuses a second request while one is in
             flight, so the attribute was preventing nothing; aria-busy says the same thing to a
             screen reader without taking focus away.

             The status region is the other half: a press whose result is 48 more rows further
             down the page is otherwise silent. It is outside the hasMore block so it survives
             the last page, which is when its final message is the one that matters. -->
        <div class="spm-list-footer">
          @if (store.isLoadingMore()) {
            <jig-spinner centered [size]="32" />
          }
          @if (store.hasMore()) {
            <button
              jigButton
              kind="secondary"
              type="button"
              [attr.aria-busy]="store.isLoadingMore() ? 'true' : null"
              (click)="onLoadMore()"
            >
              {{ t.translations().projects.loadMore }}
            </button>
          }
          <p class="spm-sr-only" role="status">
            @if (shownCount(); as count) {
              {{ t.translations().projects.showing | interpolate: { count: count } }}
            }
          </p>
        </div>
      }
    </main>
  `,
})
export class ProjectsPage {
  protected readonly store = inject(ProjectsStore)
  protected readonly settings = inject(SettingsStore)
  protected readonly t = inject(TranslateService)

  protected readonly icons = { rescan: tablerRefresh, add: tablerPlus, search: tablerSearch }

  // A Set rather than `.includes()` in the template: with N tags rendered and N in the
  // filter that binding is O(N²) re-evaluated on every change detection pass.
  protected readonly activeTags = computed(() => new Set(this.store.query().tags ?? []))

  protected readonly sortOptions = computed(() => {
    const s = this.t.translations().settings
    return [
      { label: s.sortUpdated, value: 'updatedAt:desc' },
      { label: s.sortName, value: 'name:asc' },
      { label: s.sortNewest, value: 'createdAt:desc' },
    ]
  })
  /** Mirrors the persisted choice, so revisiting the page shows the sort actually saved. */
  protected readonly sortValue = computed(
    () => `${this.store.query().sort}:${this.store.query().dir}`,
  )

  onSearch(event: Event): void {
    this.store.setSearch((event.target as HTMLInputElement).value)
  }

  /**
   * How many projects are on screen, published only after a press that actually loaded rows.
   *
   * `null` until then, so the status region starts empty: a live region that already holds text
   * when the list first renders announces nothing anyway (only later changes are spoken), and an
   * empty one cannot be mistaken for a count that was never updated.
   */
  protected readonly shownCount = signal<number | null>(null)

  /**
   * Public, like onCreate/onRescan: the page spec drives it directly. `store.loadMore` never
   * rejects, so there is nothing to catch here -- it reports its own failure.
   *
   * **The count is compared, not just re-read.** Fix round 2: this used to publish the total
   * unconditionally, so a Load more that FAILED still moved the region from empty to "Showing 48
   * projects" while the error snackbar fired — two messages for one press, saying opposite
   * things, on the very press most likely to confuse. Only the first failure did it, which is
   * exactly the kind of defect a comment claiming otherwise keeps alive. Announcing the change
   * rather than the state also keeps a page that arrived as pure duplicates silent, which is
   * honest: nothing new appeared on screen.
   */
  async onLoadMore(): Promise<void> {
    const before = this.store.items().length
    await this.store.loadMore()
    const after = this.store.items().length
    if (after !== before) this.shownCount.set(after)
  }

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
  async onSort(value: string | null): Promise<void> {
    if (!value) return
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
