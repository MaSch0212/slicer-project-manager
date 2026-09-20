import { TestBed } from '@angular/core/testing'
import { provideRouter } from '@angular/router'
import { describe, expect, it, vi } from 'vitest'
import { provideJigControls, withAutoColorScheme } from '@awdlab/jig/api/ng'
import { nova } from '@awdlab/jig-themes/nova'
import { DEFAULT_SETTINGS, type ProjectDto, type SettingsDto } from '@spm/contract/dtos.ts'
import { API_CLIENT } from '../../core/api/api-client.token'
import { TranslateService } from '../../core/i18n/translate.service'
import { NotifyService } from '../../core/notify.service'
import { ProjectsPage, SEARCH_DEBOUNCE_MS } from './projects.page'
import { PROJECTS_PAGE_SIZE, ProjectsStore } from './projects.store'
import { provideJigForTests } from '../../../testing/jig'
import en from '../../core/i18n/locales/en.json'

/** A full page of rows, which is what makes the store believe more of them exist. */
function fullPage(prefix = 'p'): ProjectDto[] {
  return Array.from({ length: PROJECTS_PAGE_SIZE }, (_, index) => ({
    id: `${prefix}${index}`,
    name: `Project ${index}`,
    isArchived: false,
    state: 'ok' as const,
    tags: [],
    fileCounts: { model: 0, slicerProject: 0, other: 0 },
    createdAt: 0,
    updatedAt: 0,
  }))
}

/** Longer than the debounce, so the search the test typed has actually been applied. */
function afterDebounce(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, SEARCH_DEBOUNCE_MS + 20))
}

async function setup(
  overrides: {
    create?: ReturnType<typeof vi.fn>
    rescan?: ReturnType<typeof vi.fn>
    putSettings?: ReturnType<typeof vi.fn>
    list?: ReturnType<typeof vi.fn>
  } = {},
) {
  const api = {
    projects: {
      list: overrides.list ?? vi.fn().mockResolvedValue([]),
      create: overrides.create ?? vi.fn(),
      rescan: overrides.rescan ?? vi.fn(),
      tags: vi.fn().mockResolvedValue([]),
    },
    settings: {
      get: vi.fn().mockResolvedValue(DEFAULT_SETTINGS),
      put:
        overrides.putSettings ??
        vi.fn((patch: Partial<SettingsDto>) => Promise.resolve({ ...DEFAULT_SETTINGS, ...patch })),
    },
  }
  // `NotifyService` is a double because jig's snackbar host attaches to
  // `ApplicationRef.components[0]`, which `TestBed` never populates; `ProjectsStore` injects it
  // to report a filter that could not be remembered. A page that could not be LOADED no longer
  // goes through it (spec H 7.5): that is a signal the footer renders, and two tests below assert
  // this double stays untouched.
  const notify = { success: vi.fn(), error: vi.fn(), info: vi.fn() }
  TestBed.configureTestingModule({
    providers: [
      ...provideJigForTests(),
      // The jig controls used by the template (jig-input-field, [jigInput], jigErrors) need
      // the app-level provider that app.config.ts installs — TestBed builds this component
      // in isolation, so it must be supplied here too.
      ...provideJigControls({ theme: { preset: nova } }, withAutoColorScheme()),
      // Each rendered card is a routerLink, so a spec whose fixture actually has rows needs a
      // router. The list used to be empty in every one of them, which is why this was not here.
      provideRouter([{ path: 'projects/:id', children: [] }]),
      { provide: API_CLIENT, useValue: api },
      { provide: NotifyService, useValue: notify },
    ],
  })
  // Awaited *before* the component exists: TestBed auto-detects changes, so creating it first
  // renders the template immediately, and the template reads t.translations() unguarded
  // (legitimately — app.config.ts awaits this same promise before bootstrap).
  await TestBed.inject(TranslateService).ready
  return { fixture: TestBed.createComponent(ProjectsPage), api, notify }
}

describe('ProjectsPage', () => {
  // Ruling 58: the brief's original onCreate trimmed createModel().name by hand and skipped
  // createForm entirely — the same defect ruling 53 fixed in LoginPage. Gating on the shared
  // createProjectSchema via submit() means an invalid model never reaches the network.
  it('does not call create when the model is invalid', async () => {
    const create = vi.fn()
    const { fixture } = await setup({ create })
    fixture.componentInstance.createModel.set({ name: '   ' })

    await fixture.componentInstance.onCreate()

    expect(create).not.toHaveBeenCalled()
  })

  it('creates the project and clears the form on a valid submit', async () => {
    const create = vi.fn().mockResolvedValue({ id: 'p1', name: 'New' })
    const { fixture } = await setup({ create })
    fixture.componentInstance.createModel.set({ name: 'New' })

    await fixture.componentInstance.onCreate()

    expect(create).toHaveBeenCalledWith({ name: 'New' })
    expect(fixture.componentInstance.createModel()).toEqual({ name: '' })
  })

  // Fix round 1, finding 2: submit() is `try { … } finally { … }` with no catch, so a
  // rejection from `action` used to propagate as an unhandled rejection with zero visual
  // feedback. A failed create should leave the typed name in place (unlike a failed rescan,
  // a create retry re-uses what the user already typed), so this also proves the model is
  // NOT cleared on failure.
  it('sets an error instead of throwing when create rejects, and keeps the typed name', async () => {
    const create = vi.fn().mockRejectedValue(new Error('boom'))
    const { fixture } = await setup({ create })
    fixture.componentInstance.createModel.set({ name: 'New' })

    await expect(fixture.componentInstance.onCreate()).resolves.toBeUndefined()

    expect(fixture.componentInstance.createError()).toBe(true)
    expect(fixture.componentInstance.createModel()).toEqual({ name: 'New' })
  })

  it('publishes the summary of a successful rescan', async () => {
    const summary = {
      adopted: 2,
      markedMissing: 0,
      filesAdded: 7,
      filesRemoved: 0,
      previewsQueued: 7,
    }
    const rescan = vi.fn().mockResolvedValue(summary)
    const { fixture } = await setup({ rescan })

    await fixture.componentInstance.onRescan()

    expect(fixture.componentInstance.rescanned()).toEqual(summary)
    expect(fixture.componentInstance.rescanError()).toBe(false)
  })

  // A rescan is one-shot (spec: no form/model to preserve), so its failure only needs to
  // surface visibly rather than escape as an unhandled rejection.
  //
  // Final review: the `rescanned()` assertion here used to be unfalsifiable. `rescanned`
  // starts as signal(null) and the test never populated it, so `toBeNull()` held whether or
  // not onRescan cleared it — and clearing it was itself added with no test at all. Driving
  // a *resolving* rescan first is what makes the second half of this test mean something:
  // the banner and the alert are independent @if blocks, so a stale success would otherwise
  // render beside a fresh failure.
  it('clears the previous summary and sets an error when a later rescan rejects', async () => {
    const rescan = vi
      .fn()
      .mockResolvedValueOnce({
        adopted: 2,
        markedMissing: 0,
        filesAdded: 7,
        filesRemoved: 0,
        previewsQueued: 7,
      })
      .mockRejectedValueOnce(new Error('boom'))
    const { fixture } = await setup({ rescan })

    await fixture.componentInstance.onRescan()
    expect(fixture.componentInstance.rescanned()).not.toBeNull()

    await expect(fixture.componentInstance.onRescan()).resolves.toBeUndefined()

    expect(fixture.componentInstance.rescanError()).toBe(true)
    expect(fixture.componentInstance.rescanned()).toBeNull()
  })

  it('persists the chosen sort', async () => {
    const { fixture, api } = await setup()

    await fixture.componentInstance.onSort('name:asc')

    expect(api.settings.put).toHaveBeenCalledWith({ sort: 'name', dir: 'asc' })
    expect(fixture.componentInstance.sortError()).toBe(false)
  })

  // onSort is bound to a template (change) handler, so a rejection from persisting the
  // preference has nowhere to go; the sort itself is already applied locally either way.
  it('surfaces a failure to persist the sort instead of rejecting', async () => {
    const { fixture } = await setup({ putSettings: vi.fn().mockRejectedValue(new Error('boom')) })

    await expect(fixture.componentInstance.onSort('name:asc')).resolves.toBeUndefined()

    expect(fixture.componentInstance.sortError()).toBe(true)
  })

  /**
   * Spec H 7.5 and constraint C6: a keyboard-reachable control for the next page is required,
   * not a nicety. A list that only grows on a scroll event is unreachable for anyone moving by
   * keyboard or screen reader — focus moves without ever scrolling a container — and until the
   * scroll trigger lands this button is also the only path to rows 49 and beyond.
   *
   * The assertion is on the rendered DOM rather than on a component field because what is being
   * proved is exactly that the control EXISTS on the page: a store that knows more rows are
   * there, with nothing rendered to ask for them, is the defect.
   */
  it('renders a keyboard-reachable control for the next page when more rows exist', async () => {
    const list = vi.fn().mockResolvedValue(fullPage())
    const { fixture, api } = await setup({ list })
    await fixture.whenStable()
    fixture.detectChanges()

    const footer = [
      ...(fixture.nativeElement as HTMLElement).querySelectorAll<HTMLButtonElement>(
        '.spm-list-footer button',
      ),
    ]
    expect(footer).toHaveLength(1)
    const loadMore = footer[0]
    expect(loadMore?.textContent?.trim()).toBe(en.projects.loadMore)

    loadMore?.click()
    await fixture.whenStable()

    expect(api.projects.list).toHaveBeenLastCalledWith(
      expect.objectContaining({ limit: PROJECTS_PAGE_SIZE, offset: PROJECTS_PAGE_SIZE }),
    )
  })

  // The other edge of the same control: a library that fits on one page must not offer a next
  // one, or the user is handed a button that does nothing. The fixture is deliberately a
  // NON-empty short page — an empty one renders the empty state instead of the list, so the
  // footer would be absent for a reason that has nothing to do with paging.
  it('renders no next-page control when the first page is already the whole library', async () => {
    const { fixture } = await setup({ list: vi.fn().mockResolvedValue(fullPage().slice(0, 3)) })
    await fixture.whenStable()
    fixture.detectChanges()

    expect(
      (fixture.nativeElement as HTMLElement).querySelectorAll('.spm-list-footer'),
    ).toHaveLength(1)

    expect(
      (fixture.nativeElement as HTMLElement).querySelectorAll('.spm-list-footer button'),
    ).toHaveLength(0)
  })

  /**
   * Fix round 1, finding 2. Disabling the control that currently has focus drops focus to the
   * body, so a keyboard user would pay a re-tab through every card on screen for each page — the
   * exact cost the button exists to avoid (C6). `loadMore`'s own in-flight guard already refuses
   * the second request, so the attribute prevented nothing and cost focus; `aria-busy` says the
   * same thing to a screen reader and takes nothing away.
   *
   * The assertion is taken mid-flight, with the page deliberately left pending — after it
   * resolves, `isLoadingMore()` is false again and a disabled binding would read as enabled.
   */
  it('keeps the pressed control enabled while its page loads, and marks it busy', async () => {
    let release: (rows: ProjectDto[]) => void = () => {}
    const list = vi
      .fn()
      .mockResolvedValueOnce(fullPage())
      .mockImplementationOnce(
        () =>
          new Promise<ProjectDto[]>((resolve) => {
            release = resolve
          }),
      )
    const { fixture } = await setup({ list })
    await fixture.whenStable()
    fixture.detectChanges()
    const button = (fixture.nativeElement as HTMLElement).querySelector<HTMLButtonElement>(
      '.spm-list-footer button',
    )

    button?.click()
    await Promise.resolve()
    fixture.detectChanges()

    expect(button?.disabled).toBe(false)
    expect(button?.getAttribute('aria-busy')).toBe('true')

    release([])
    await fixture.whenStable()
  })

  /**
   * The press has to say it did something. Its whole result is 48 more rows below the fold, which
   * a screen-reader user has no way to notice; a polite status region is the announcement.
   *
   * The two pages carry different ids on purpose: identical ones would be de-duplicated away and
   * the total would not move, so the region would have nothing to say and the test would pass
   * against a page that never announced anything.
   */
  it('announces the new total once more projects have loaded', async () => {
    const list = vi.fn().mockResolvedValueOnce(fullPage('a')).mockResolvedValueOnce(fullPage('b'))
    const { fixture } = await setup({ list })
    await fixture.whenStable()
    fixture.detectChanges()
    const region = (fixture.nativeElement as HTMLElement).querySelector(
      '.spm-list-footer [role="status"]',
    )
    expect(region?.textContent?.trim()).toBe('')

    await fixture.componentInstance.onLoadMore()
    fixture.detectChanges()

    expect(region?.textContent?.trim()).toBe(
      en.projects.showing.replace('{{ count }}', String(PROJECTS_PAGE_SIZE * 2)),
    )
  })

  /**
   * Spec H 7.1-7.4 and constraint C6. Every control in the filter bar lost its visible label to
   * the user's request for one row, so each one has to carry its name some other way -- and the
   * way differs per control: the search box sets aria-label itself, the two selects get theirs
   * from jig-select's label input, and the two icon buttons from JigTooltip's autoAria, which
   * writes aria-label and removes any it did not write.
   *
   * The second half is what keeps the first half honest: an assertion that five names exist
   * would also pass against a bar that had kept its five visible labels and changed nothing.
   */
  it('names every filter control without a visible label on any of them', async () => {
    const { fixture } = await setup()
    await fixture.whenStable()
    fixture.detectChanges()
    const bar = (fixture.nativeElement as HTMLElement).querySelector('.spm-filter-bar')

    // Addressed by what each control IS rather than by the name it carries: a search for the
    // name alone would answer with whatever happened to hold it, and the tag list box inside
    // the dropdown carries the same string as the button that opens it.
    const named: [string, string][] = [
      ['input[type="search"]', en.projects.search],
      ['jig-select[inputid="projects-sort"] [role="combobox"]', en.settings.sort],
      ['button[aria-pressed]', en.projects.includeArchived],
      ['button[aria-haspopup="listbox"]', en.projects.tags],
      ['jig-select[inputid="projects-view-mode"] [role="combobox"]', en.projects.viewMode],
    ]
    for (const [selector, name] of named) {
      const matches = bar?.querySelectorAll(selector)
      expect(matches).toHaveLength(1)
      expect(matches?.[0]?.getAttribute('aria-label')).toBe(name)
    }

    expect(bar?.querySelectorAll('label')).toHaveLength(0)
  })

  /**
   * The sort select keeps its name AND gains the icon the user asked for inside the control.
   * jig-input-field discovers the control it wraps and skips icons while doing so, so the icon
   * is a prefix adornment rather than something that shadows the select -- this asserts both
   * halves, because an icon that displaced the select would leave the field wired to nothing.
   */
  it('renders a sort icon inside the field, beside a select that keeps its name', async () => {
    const { fixture } = await setup()
    await fixture.whenStable()
    fixture.detectChanges()
    const field = (fixture.nativeElement as HTMLElement).querySelector('.spm-sort')

    // Only the adornment: jig-select renders a dropdown chevron of its own inside the field, so
    // an unfiltered count of jig-icon elements here is 1 whether or not the sort icon was added.
    const adornments = [...(field?.querySelectorAll('jig-icon') ?? [])].filter(
      (icon) => icon.closest('jig-select') === null,
    )
    expect(adornments).toHaveLength(1)
    const select = field?.querySelector('jig-select')
    expect(select).not.toBeNull()
    expect(select?.querySelector('[role="combobox"]')?.getAttribute('aria-label')).toBe(
      en.settings.sort,
    )
  })

  /**
   * Spec H 7.3. One control with a state, not two controls: the icon flips, aria-pressed follows
   * the filter, and the accessible name is the same string in both states.
   *
   * Asserting the name in both states is the half that catches the usual mistake -- a control
   * whose name flips between "Show archived" and "Hide archived" is announced as a different
   * control on every press, which is exactly what aria-pressed exists to say instead.
   */
  it('tracks the archived filter with aria-pressed and keeps one name in both states', async () => {
    const { fixture } = await setup()
    await fixture.whenStable()
    fixture.detectChanges()
    const button = (fixture.nativeElement as HTMLElement).querySelector<HTMLButtonElement>(
      `.spm-filter-bar button[aria-label="${en.projects.includeArchived}"]`,
    )
    expect(button?.getAttribute('aria-pressed')).toBe('false')

    button?.click()
    await fixture.whenStable()
    fixture.detectChanges()

    expect(button?.getAttribute('aria-pressed')).toBe('true')
    expect(button?.getAttribute('aria-label')).toBe(en.projects.includeArchived)

    button?.click()
    await fixture.whenStable()
    fixture.detectChanges()

    expect(button?.getAttribute('aria-pressed')).toBe('false')
    expect(button?.getAttribute('aria-label')).toBe(en.projects.includeArchived)
  })

  /**
   * Spec H 7.4: a count badge when tags are selected, and none at zero.
   *
   * The zero case alone is unfalsifiable -- it passes just as well against a badge that never
   * renders at all -- so the same test drives the count up afterwards and reads the number back.
   * The badge element is jigBadge's own, and jigBadge renders nothing at 0 unless told to.
   */
  it('shows no tag badge at zero selected, and the count above it', async () => {
    const { fixture } = await setup()
    await fixture.whenStable()
    fixture.detectChanges()
    const button = (fixture.nativeElement as HTMLElement).querySelector<HTMLButtonElement>(
      `.spm-filter-bar button[aria-label="${en.projects.tags}"]`,
    )
    const store = fixture.debugElement.injector.get(ProjectsStore)
    expect(button?.getAttribute('aria-expanded')).toBe('false')
    expect(button?.querySelector('jig-badge-indicator')).toBeNull()

    await store.setTags(['petg'])
    await fixture.whenStable()
    fixture.detectChanges()
    expect(button?.querySelector('jig-badge-indicator')?.textContent?.trim()).toBe('1')

    await store.setTags(['petg', 'boat'])
    await fixture.whenStable()
    fixture.detectChanges()
    expect(button?.querySelector('jig-badge-indicator')?.textContent?.trim()).toBe('2')
  })

  /**
   * Spec H 7.4 and constraint C6. The dropdown has to list the library's tags as selectable
   * options and report a choice back — a badge and an `aria-expanded` attribute over a list box
   * that never rendered would satisfy every other test here.
   *
   * The options are read by their ARIA role rather than by a class, because `role="option"` with
   * `aria-selected` is what makes the list keyboard- and screen-reader-operable in the first
   * place; both are jig-list-box's own, given `selectable` and `multiple`.
   *
   * **The popover is deliberately not opened, and that is a limit of the runner rather than a
   * choice.** jig's popover calls `togglePopover`, and jsdom 28 implements no part of the Popover
   * API, so the call throws inside a `requestAnimationFrame` where it lands as an unhandled
   * error rather than a failed assertion. The list box is projected eagerly, so it is in the DOM
   * either way and every wire this test cares about is reachable without the native call.
   *
   * The tag is seeded through the filter rather than through the tags resource: `knownTags`
   * folds the selected tags into the library's own list (ruling 59), so this stays a test of the
   * dropdown rather than of how the tag list is fetched.
   */
  it('offers each tag as a selectable option, and applies the one that is chosen', async () => {
    const { fixture } = await setup()
    await fixture.whenStable()
    fixture.detectChanges()
    const host = fixture.nativeElement as HTMLElement
    const store = fixture.debugElement.injector.get(ProjectsStore)
    await store.setTags(['petg'])
    await fixture.whenStable()
    fixture.detectChanges()

    // The disclosure names the thing it discloses (fix round 1, finding 5): aria-haspopup says
    // there is a listbox, aria-controls says which one, and the assertion follows the id to a
    // real element carrying role="listbox" rather than just comparing two strings.
    const button = host.querySelector<HTMLButtonElement>('button[aria-haspopup="listbox"]')
    const controlled = host.querySelector(`#${button?.getAttribute('aria-controls')}`)
    expect(controlled?.getAttribute('role')).toBe('listbox')

    const options = [...host.querySelectorAll('jig-list-box [role="option"]')]
    expect(options.map((option) => option.textContent?.trim())).toEqual(['petg'])
    expect(options[0]?.getAttribute('aria-selected')).toBe('true')

    options[0]?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await fixture.whenStable()
    fixture.detectChanges()

    expect(store.query().tags).toBeUndefined()
  })

  /**
   * Spec H 6: the control moved to this page; the setting did not move anywhere. The assertion
   * is on the key that reaches the transport, because that is the whole claim -- a view-mode
   * control here that wrote something else would render identically.
   */
  it('writes settings.viewMode from the control now on this page', async () => {
    const { fixture, api } = await setup()
    await fixture.whenStable()
    fixture.detectChanges()
    expect(
      (fixture.nativeElement as HTMLElement).querySelectorAll(
        '.spm-filter-bar jig-select[inputid="projects-view-mode"]',
      ),
    ).toHaveLength(1)

    await fixture.componentInstance.onViewMode('list')

    expect(api.settings.put).toHaveBeenCalledWith({ viewMode: 'list' })
  })

  // onViewMode is handed straight to a template (valueChange) binding, so a rejected save has
  // nowhere to go; SettingsStore.patch has already rolled the control back by then, and all
  // that was missing was saying why.
  it('reports a view mode that could not be saved instead of rejecting', async () => {
    const { fixture, notify } = await setup({
      putSettings: vi.fn().mockRejectedValue(new Error('boom')),
    })

    await expect(fixture.componentInstance.onViewMode('list')).resolves.toBeUndefined()

    expect(notify.error).toHaveBeenCalledWith(en.errors.generic)
  })

  /**
   * Ruling H-6. parseProjectQuery answers a query that fails validation with a 400, and
   * projectQuerySchema caps the search term at 200 characters -- so a 201-character paste would
   * turn a search into a hard failure rather than a narrower result set. The box carries the cap
   * as maxlength and the store truncates; this is the end-to-end half, asserting that what
   * actually reaches the transport is a term the schema accepts.
   */
  it('never sends a search term longer than the query schema accepts', async () => {
    const { fixture, api } = await setup()
    await fixture.whenStable()
    fixture.detectChanges()
    const input = (fixture.nativeElement as HTMLElement).querySelector<HTMLInputElement>(
      'input[type="search"]',
    )
    expect(input?.getAttribute('maxlength')).toBe('200')

    input!.value = 'x'.repeat(201)
    input!.dispatchEvent(new Event('input'))
    await afterDebounce()
    await fixture.whenStable()

    const sent = api.projects.list.mock.calls.at(-1)?.[0] as { search?: string }
    expect(sent.search).toHaveLength(200)
  })

  /**
   * Spec H 7.1. Every keystroke used to re-query, and under paging each one also throws away
   * every page accumulated so far. Three keystrokes in quick succession must cost one request.
   *
   * The count is taken as a delta from the page-zero load rather than absolutely, so the test
   * says what it means: how many requests the typing caused.
   */
  it('queries once for a burst of keystrokes rather than once per keystroke', async () => {
    const { fixture, api } = await setup()
    await fixture.whenStable()
    fixture.detectChanges()
    const input = (fixture.nativeElement as HTMLElement).querySelector<HTMLInputElement>(
      'input[type="search"]',
    )
    const before = api.projects.list.mock.calls.length

    // A pause between the keystrokes, shorter than the debounce. Dispatching all three
    // synchronously would not prove anything: three writes to the query signal inside one tick
    // are coalesced into a single resource load whether or not anything debounced them.
    for (const term of ['b', 'be', 'ben']) {
      input!.value = term
      input!.dispatchEvent(new Event('input'))
      await new Promise((resolve) => setTimeout(resolve, 20))
      await fixture.whenStable()
    }
    await afterDebounce()
    await fixture.whenStable()

    expect(api.projects.list.mock.calls.length - before).toBe(1)
    expect(api.projects.list.mock.calls.at(-1)?.[0]).toMatchObject({ search: 'ben' })
  })

  /**
   * Fix round 2. The announcement used to be published unconditionally, so a Load more that
   * FAILED moved the region from empty to "Showing 48 projects" while an error was reported:
   * two messages for one press, saying opposite things. Only the FIRST press showed it — after
   * that the total is already published and re-publishing the same number changes no text — so
   * the fixture fails the first press deliberately, which is the only press that catches it.
   *
   * The failure now renders in the footer instead of firing a snackbar (spec H 7.5), so this
   * also asserts the message that replaced it — and that `NotifyService` was left alone, which
   * is what a page keeping both would fail on.
   */
  it('shows the failure in the footer and says nothing in the status region', async () => {
    const list = vi.fn().mockResolvedValueOnce(fullPage()).mockRejectedValueOnce(new Error('boom'))
    const { fixture, notify } = await setup({ list })
    await fixture.whenStable()
    fixture.detectChanges()
    const footer = (fixture.nativeElement as HTMLElement).querySelector('.spm-list-footer')
    const region = footer?.querySelector('[role="status"]')
    expect(footer?.querySelectorAll('[role="alert"]')).toHaveLength(0)

    await fixture.componentInstance.onLoadMore()
    fixture.detectChanges()

    const alerts = [...(footer?.querySelectorAll('[role="alert"]') ?? [])]
    expect(alerts).toHaveLength(1)
    expect(alerts[0]?.textContent?.trim()).toBe(en.projects.loadMoreFailed)
    // The button is still there beside it: a failed page is not the end of the library, and the
    // message is only useful next to the control it asks the user to press again.
    expect(footer?.querySelectorAll('button')).toHaveLength(1)
    expect(region?.textContent?.trim()).toBe('')
    expect(notify.error).not.toHaveBeenCalled()
  })
})
