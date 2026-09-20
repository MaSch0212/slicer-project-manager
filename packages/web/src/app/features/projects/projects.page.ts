import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  computed,
  inject,
  signal,
} from '@angular/core'
import { RouterLink } from '@angular/router'
import { FormField, form, submit, validateStandardSchema } from '@angular/forms/signals'
import { InterpolatePipe } from '@ngneers/signal-translate'
import { SEARCH_MAX_LENGTH, createProjectSchema } from '@spm/contract/schemas.ts'
import type { RescanResultDto, SettingsDto } from '@spm/contract/dtos.ts'
import { JigBadge } from '@awdlab/jig/badge'
import { JigButton } from '@awdlab/jig/button'
import { JigErrors } from '@awdlab/jig/errors'
import { JigHint } from '@awdlab/jig/hint'
import { JigIcon } from '@awdlab/jig/icon'
import { JigInput } from '@awdlab/jig/input'
import { JigInputField } from '@awdlab/jig/input-field'
import { JigListBox } from '@awdlab/jig/list-box'
import { JigMessage } from '@awdlab/jig/message'
import { JigPopover } from '@awdlab/jig/popover'
import { JigSelect } from '@awdlab/jig/select'
import { JigSpinner } from '@awdlab/jig/spinner'
import { JigTag } from '@awdlab/jig/tag'
import { JigTooltip } from '@awdlab/jig/tooltip'
import tablerArchive from '@iconify/icons-tabler/archive'
import tablerArchiveOff from '@iconify/icons-tabler/archive-off'
import tablerArrowsSort from '@iconify/icons-tabler/arrows-sort'
import tablerLayoutGrid from '@iconify/icons-tabler/layout-grid'
import tablerPlus from '@iconify/icons-tabler/plus'
import tablerRefresh from '@iconify/icons-tabler/refresh'
import tablerSearch from '@iconify/icons-tabler/search'
import tablerTag from '@iconify/icons-tabler/tag'
import { NotifyService } from '../../core/notify.service'
import { SettingsStore } from '../../core/settings.store'
import { TranslateService } from '../../core/i18n/translate.service'
import { ProjectsStore } from './projects.store'

/**
 * How long the search box waits after the last keystroke before it queries (spec 7.1).
 *
 * Exported so the page spec waits on the same number this uses rather than a copy of it.
 */
export const SEARCH_DEBOUNCE_MS = 250

@Component({
  selector: 'spm-projects-page',
  imports: [
    RouterLink,
    FormField,
    InterpolatePipe,
    JigBadge,
    JigButton,
    JigErrors,
    JigHint,
    JigIcon,
    JigInput,
    JigInputField,
    JigListBox,
    JigMessage,
    JigPopover,
    JigSelect,
    JigSpinner,
    JigTag,
    JigTooltip,
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

      <!-- One row: the search box leads, and the four controls that narrow or reshape the result
           set follow it. They are icon-first because the row has to survive a narrow window;
           every one of them still carries a name a screen reader can read, which is what
           constraint C6 asks of an icon-only control.

           No labelKind="on" anywhere in here any more. A visible label above each control is
           what made this a two-storey block rather than a row, and the user asked for the row. -->
      <section class="spm-card spm-stack spm-filters">
        <div class="spm-filter-bar">
          <!-- A placeholder is not an accessible name: it is announced as a hint, it is
               translated by the browser's own heuristics rather than ours, and it disappears the
               moment anything is typed. So the visible label goes and an aria-label stays.

               maxlength is half of a pair. projectQuerySchema caps the term at
               SEARCH_MAX_LENGTH and parseProjectQuery answers a query that fails validation with
               a 400, so a pasted 201st character would turn a search into a hard failure. This
               stops the typing case; ProjectsStore.setSearch truncates, which covers the paste
               and every caller that is not this box.

               No [value] binding back from the store, and that is deliberate now that the term
               is debounced: the store holds the term trimmed and truncated, so binding it back
               would rewrite the box a quarter of a second after typing stopped and eat a
               trailing space the user had just typed. Nothing else in the application writes the
               search term -- it is the one filter the store pointedly does not restore on a
               revisit -- so there is no state for the box to fall out of step with. -->
          <jig-input-field class="spm-search">
            <jig-icon [icon]="icons.search" />
            <input
              jigInput
              type="search"
              [attr.aria-label]="t.translations().projects.search"
              [placeholder]="t.translations().projects.search"
              [attr.maxlength]="searchMaxLength"
              (input)="onSearch($event)"
            />
          </jig-input-field>

          <div class="spm-filter-actions">
            <!-- The icon is projected into jig-input-field ahead of the select, which is how the
                 field takes a prefix adornment; measured against @awdlab/jig 0.0.5, the field
                 skips icons when it looks for the control it wraps, so the select is still the
                 thing the field is wired to. The select's own label input becomes its aria-label,
                 so dropping the visible label costs nothing in the accessibility tree.

                 sortPopover is what stops the popup wrapping "Recently updated". jig-select
                 defaults its popover width and max-width to 1 -- meaning exactly the trigger's
                 width -- so the longest option wraps whenever the trigger is narrow.

                 It is set here rather than in styles.css because jig's positioning engine writes
                 the popup's width as an INLINE style, not because a selector cannot reach the
                 element: the popover stays inside this component's DOM and matches selectors
                 normally. popoverOptions is the library's documented input for this.

                 No backticks in this comment: the template is a JS template literal, so a
                 backtick ends it before it is ever text. -->
            <jig-input-field class="spm-sort" inputId="projects-sort">
              <jig-icon [icon]="icons.sort" />
              <jig-select
                inputId="projects-sort"
                [label]="t.translations().settings.sort"
                [options]="sortOptions()"
                [value]="sortValue()"
                [popoverOptions]="sortPopover"
                (valueChange)="onSort($event)"
              />
            </jig-input-field>

            <!-- One control with a state, not two controls. The icon flips; the name does not,
                 because a name that flips is announced as a different control each press, which
                 is the job aria-pressed already does. The name comes from the tooltip rather
                 than an aria-label of our own: JigTooltip's autoAria writes aria-label in
                 "label" mode and removes any aria-label it did not write itself.

                 A plain button rather than jig-toggle-button, and the reason is the attribute
                 the spec asks for. Measured against @awdlab/jig 0.0.5: jig-toggle-button renders
                 role="switch" with aria-checked and offers no way to emit aria-pressed, so it
                 announces a switch rather than a pressed button. Its iconOn/iconOff pair is
                 exactly what this needs otherwise -- but a control that says the wrong thing to
                 a screen reader is not a saving. -->
            <button
              jigButton
              kind="icon"
              type="button"
              [attr.aria-pressed]="archivedShown()"
              [jigTooltip]="t.translations().projects.includeArchived"
              jigTooltipAutoAriaMode="label"
              (click)="onToggleArchived()"
            >
              <jig-icon [icon]="archivedShown() ? icons.archive : icons.archiveOff" />
            </button>

            <!-- The badge is bound to the count and nothing else: jigBadge renders nothing at 0
                 unless jigBadgeShowZero is set, so "no badge when nothing is selected" is the
                 directive's own behaviour rather than an @if wrapped round it. -->
            <button
              #tagsAnchor
              jigButton
              kind="icon"
              type="button"
              [jigBadge]="selectedTags().length"
              [attr.aria-expanded]="tagsOpen()"
              aria-haspopup="listbox"
              [attr.aria-controls]="tagListId"
              [jigTooltip]="t.translations().projects.tags"
              jigTooltipAutoAriaMode="label"
              (click)="tagsOpen.set(!tagsOpen())"
            >
              <jig-icon [icon]="icons.tags" />
            </button>
            <!-- jig-list-box with selectable + multiple: checkboxes, roving keyboard navigation
                 and aria-selected per option come with it, so the dropdown is operable without a
                 pointer. AND semantics are core's and are untouched -- this only reports which
                 tags are selected. -->
            <jig-popover [anchor]="tagsAnchor" [(open)]="tagsOpen" [options]="tagsPopover">
              <jig-list-box
                class="spm-tag-list"
                [inputId]="tagListId"
                [label]="t.translations().projects.tags"
                [items]="tagOptions()"
                [selectable]="true"
                [multiple]="true"
                [value]="selectedTags()"
                (valueChange)="onTags($event)"
              />
            </jig-popover>

            <!-- Moved here from the settings General tab (spec H 6). It is the control that
                 moved, not the setting: this still writes settings.viewMode through
                 SettingsStore.patch, and the list below still reads it from there. -->
            <jig-input-field class="spm-view-mode" inputId="projects-view-mode">
              <jig-icon [icon]="icons.viewMode" />
              <jig-select
                inputId="projects-view-mode"
                [label]="t.translations().projects.viewMode"
                [options]="viewModeOptions()"
                [value]="settings.settings().viewMode"
                (valueChange)="onViewMode($event)"
              />
            </jig-input-field>
          </div>
        </div>
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
  private readonly notify = inject(NotifyService)

  protected readonly icons = {
    rescan: tablerRefresh,
    add: tablerPlus,
    search: tablerSearch,
    sort: tablerArrowsSort,
    archive: tablerArchive,
    archiveOff: tablerArchiveOff,
    tags: tablerTag,
    viewMode: tablerLayoutGrid,
  }

  /** The cap the search box wears, from the schema that would otherwise refuse the query. */
  protected readonly searchMaxLength = SEARCH_MAX_LENGTH

  /**
   * What the sort popup is allowed to be, overriding jig-select's own defaults.
   *
   * Measured against @awdlab/jig 0.0.5: the select merges the caller's options over
   * `{ width: 1, maxWidth: 1 }`, and those two mean "exactly the width of the trigger" — which
   * is why "Recently updated" wrapped. `max-content` sizes the popup to its longest option
   * instead, and it is the longest *translated* option that decides, so this holds for
   * "Zuletzt geändert" too. The minimum keeps it from collapsing narrower than the trigger.
   */
  protected readonly sortPopover = {
    sizeConstraints: {
      width: 'max-content',
      // The same floor the trigger has, read from the same place rather than copied: a popup
      // narrower than the control it hangs off looks like a rendering fault, so the two are one
      // requirement. jig applies this as a CSS string on an element inside this component's own
      // DOM, so the custom property resolves exactly as it does for the trigger.
      minWidth: 'var(--spm-sort-min-width)',
      maxWidth: '24rem',
    },
  }

  /** The tag popup sizes to its content and scrolls once a library has many tags. */
  protected readonly tagsPopover = {
    sizeConstraints: { width: 'max-content', minWidth: '14rem', maxHeight: '20rem' },
  }

  /** Whether the tag dropdown is showing — also what the button's `aria-expanded` reports. */
  protected readonly tagsOpen = signal(false)

  /**
   * The id the tags button's `aria-controls` points at.
   *
   * jig-list-box puts its `inputId` on its own host, which already carries `role="listbox"`, so
   * there is a real element to name and the button's `aria-haspopup="listbox"` now says which
   * listbox. A constant rather than a generated id because there is exactly one of these on the
   * page — the same reasoning the sort and view-mode selects' ids already use.
   */
  protected readonly tagListId = 'projects-tag-list'

  /** The selected tags, in the shape the multi-select both reads and reports. */
  protected readonly selectedTags = computed(() => this.store.query().tags ?? [])

  /** Every tag the library knows, as list-box options. */
  protected readonly tagOptions = computed(() =>
    this.store.knownTags().map((tag) => ({ label: tag, value: tag })),
  )

  /** Whether archived projects are in the list — the toggle's pressed state. */
  protected readonly archivedShown = computed(() => this.store.query().includeArchived === true)

  protected readonly viewModeOptions = computed(() => {
    const p = this.t.translations().projects
    return [
      { label: p.viewModeGrid, value: 'grid' as const },
      { label: p.viewModeList, value: 'list' as const },
    ]
  })

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

  /**
   * Applies the typed term once the typing stops (spec 7.1).
   *
   * Every keystroke used to re-query. Under paging that is worse than it was: each one also
   * throws away every page accumulated so far and starts again at offset zero, so typing eight
   * characters costs eight requests whose results are all discarded but the last.
   *
   * Public, like onCreate/onRescan: the spec drives it directly.
   */
  onSearch(event: Event): void {
    const term = (event.target as HTMLInputElement).value
    if (this.searchTimer !== null) clearTimeout(this.searchTimer)
    this.searchTimer = setTimeout(() => {
      this.searchTimer = null
      this.store.setSearch(term)
    }, SEARCH_DEBOUNCE_MS)
  }

  private searchTimer: ReturnType<typeof setTimeout> | null = null

  constructor() {
    // A pending keystroke must not re-query a store that is being torn down with the page.
    inject(DestroyRef).onDestroy(() => {
      if (this.searchTimer !== null) clearTimeout(this.searchTimer)
    })
  }

  /**
   * Shows or hides archived projects. `setIncludeArchived` never rejects — it reports a
   * preference it could not save through the snackbar itself — so there is nothing to catch,
   * and `void` says the click handler is not waiting for it.
   */
  onToggleArchived(): void {
    void this.store.setIncludeArchived(!this.archivedShown())
  }

  /**
   * Takes the whole selection the multi-select reports. `null` is what the control emits when
   * nothing is left selected, which is an empty filter rather than no change.
   *
   * Never rejects, for the same reason as the archived toggle.
   */
  onTags(tags: readonly string[] | null): void {
    void this.store.setTags(tags ?? [])
  }

  /**
   * Writes `settings.viewMode` — the same key the settings General tab used to write, through
   * the same optimistic `SettingsStore.patch` (spec H 6: the control moved, the setting did not).
   *
   * `patch` rolls its own key back before rethrowing, so by the time this catches, the select
   * has already snapped back to the previous mode and all that was missing was saying why. A
   * snackbar rather than a banner: it is the result of an action the user just took (spec G 7).
   * Catching at all is load-bearing besides — this is handed straight to a template
   * `(valueChange)` binding, where a rejection escapes the component.
   */
  async onViewMode(mode: SettingsDto['viewMode'] | null): Promise<void> {
    if (mode === null) return
    try {
      await this.settings.patch({ viewMode: mode })
    } catch {
      this.notify.error(this.t.translations().errors.generic)
    }
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
