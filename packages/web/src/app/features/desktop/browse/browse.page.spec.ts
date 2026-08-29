import { TestBed } from '@angular/core/testing'
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import type {
  BrowseDownloadDto,
  BrowseNoticeDto,
  BrowseStateDto,
  Capabilities,
  FileDto,
  ModelSiteDto,
  ProjectDto,
} from '@spm/contract/dtos.ts'
import { AppError } from '@spm/contract/errors.ts'
import { API_CLIENT, SHELL_CLIENT } from '../../../core/api/api-client.token'
import { CapabilitiesStore } from '../../../core/capabilities.store'
import { TranslateService } from '../../../core/i18n/translate.service'
import { provideJigForTests } from '../../../../testing/jig'
import { BROWSE_INTERSTITIAL_TICKS, DesktopBrowsePage, truncateForDisplay } from './browse.page'

/**
 * The two capability columns this page can be rendered under, copied from
 * `packages/desktop/src/capabilities.ts`.
 *
 * Copied rather than imported for the reason `packages/desktop/test/capabilities.test.ts` gives
 * about its own copy in the other direction: this is an Angular suite and that is a Node one, and
 * the two packages share no test runner. What keeps them honest is that the desktop suite asserts
 * both columns **whole**.
 *
 * **The archive obligation is driven off `canPickLocalFolder` and off nothing else**, which is why
 * these are here as columns rather than as a boolean a test sets: spec 5.5's whole argument for the
 * remote message is that flag being false — the project folder is on the server, so there is no
 * folder on this machine to unzip into.
 */
const LOCAL_COLUMN: Capabilities = {
  requiresAuth: false,
  canManageUsers: false,
  canPickLocalFolder: true,
  canLaunchSlicer: true,
  canConfigureSlicers: true,
  canBrowseModelSites: true,
}

const REMOTE_COLUMN: Capabilities = {
  requiresAuth: true,
  canManageUsers: true,
  canPickLocalFolder: false,
  canLaunchSlicer: true,
  canConfigureSlicers: true,
  canBrowseModelSites: true,
}

const SITES: ModelSiteDto[] = [
  { id: 'thingiverse', displayName: 'Thingiverse', homeUrl: 'https://www.thingiverse.com/' },
  { id: 'printables', displayName: 'Printables', homeUrl: 'https://www.printables.com/' },
]

const IDLE: BrowseStateDto = {
  attached: true,
  url: 'https://www.thingiverse.com/thing:1234',
  title: 'A thing',
  isLoading: false,
  canGoBack: false,
  canGoForward: false,
  siteId: 'thingiverse',
  lastError: null,
}

/** The URL shape the spike recorded for a Thingiverse model page, verbatim. */
const THING_URL = 'https://www.thingiverse.com/thing:1234'

function project(over: Partial<ProjectDto> = {}): ProjectDto {
  return {
    id: 'p1',
    name: 'Benchy',
    isArchived: false,
    state: 'ok',
    tags: [],
    fileCounts: { model: 0, slicerProject: 0, other: 0 },
    createdAt: 0,
    updatedAt: 0,
    ...over,
  }
}

function download(over: Partial<BrowseDownloadDto> = {}): BrowseDownloadDto {
  return {
    downloadId: 'd1',
    fileName: 'benchy.zip',
    sourceUrl: 'blob:https://www.thingiverse.com/8c1f',
    pageUrl: THING_URL,
    siteId: 'thingiverse',
    mimeType: 'application/zip',
    state: 'completed',
    receivedBytes: 21_060_699,
    totalBytes: 21_060_699,
    hadUserGesture: true,
    startedAt: 0,
    isOrphan: false,
    isVerifiable: true,
    ...over,
  }
}

function landedFile(over: Partial<FileDto> = {}): FileDto {
  return {
    id: 'f1',
    name: 'benchy.zip',
    kind: 'other',
    sizeBytes: 21_060_699,
    previewState: 'unsupported',
    rawUrl: 'spm://file/f1/raw',
    ...over,
  }
}

type Fakes = {
  sites: ReturnType<typeof vi.fn>
  attach: ReturnType<typeof vi.fn>
  detach: ReturnType<typeof vi.fn>
  hide: ReturnType<typeof vi.fn>
  show: ReturnType<typeof vi.fn>
  setBounds: ReturnType<typeof vi.fn>
  navigate: ReturnType<typeof vi.fn>
  back: ReturnType<typeof vi.fn>
  forward: ReturnType<typeof vi.fn>
  reload: ReturnType<typeof vi.fn>
  state: ReturnType<typeof vi.fn>
  clearLastPage: ReturnType<typeof vi.fn>
  downloads: ReturnType<typeof vi.fn>
  discard: ReturnType<typeof vi.fn>
  notices: ReturnType<typeof vi.fn>
  dismissNotice: ReturnType<typeof vi.fn>
  land: ReturnType<typeof vi.fn>
}

type Setup = {
  fixture: ReturnType<typeof TestBed.createComponent<DesktopBrowsePage>>
  page: DesktopBrowsePage
  browse: Fakes
  list: ReturnType<typeof vi.fn>
  create: ReturnType<typeof vi.fn>
  translate: TranslateService
}

/**
 * Both seams, faked: `SHELL_CLIENT` for the view and its downloads, `API_CLIENT` for the library.
 *
 * A page about a machine capability that lands its result in a library is correctly a page that
 * injects both, and a spec that fakes both is what proves neither is reached through the other.
 */
async function setup(
  options: {
    capabilities?: Capabilities
    projects?: ProjectDto[]
    downloads?: BrowseDownloadDto[]
    notices?: BrowseNoticeDto[]
    state?: BrowseStateDto
    overrides?: Partial<Fakes>
    /** `projects.list`, when a test needs to hold the opening sequence open inside it. */
    list?: ReturnType<typeof vi.fn>
    /**
     * Whether to await `ready` before returning. `false` hands back a page that is still opening,
     * which is the only way to destroy one *during* `#open` — and doing that by ordering rather
     * than by waiting is the point.
     */
    awaitReady?: boolean
  } = {},
): Promise<Setup> {
  const browse: Fakes = {
    sites: vi.fn().mockResolvedValue(SITES),
    attach: vi.fn().mockResolvedValue(options.state ?? IDLE),
    detach: vi.fn().mockResolvedValue(undefined),
    hide: vi.fn().mockResolvedValue(undefined),
    show: vi.fn().mockResolvedValue(options.state ?? IDLE),
    setBounds: vi.fn().mockResolvedValue(undefined),
    navigate: vi.fn().mockResolvedValue(options.state ?? IDLE),
    back: vi.fn().mockResolvedValue(options.state ?? IDLE),
    forward: vi.fn().mockResolvedValue(options.state ?? IDLE),
    reload: vi.fn().mockResolvedValue(options.state ?? IDLE),
    state: vi.fn().mockResolvedValue(options.state ?? IDLE),
    clearLastPage: vi.fn().mockResolvedValue(undefined),
    downloads: vi.fn().mockResolvedValue(options.downloads ?? []),
    discard: vi.fn().mockResolvedValue(undefined),
    notices: vi.fn().mockResolvedValue(options.notices ?? []),
    dismissNotice: vi.fn().mockResolvedValue(undefined),
    land: vi.fn().mockResolvedValue(landedFile()),
    ...options.overrides,
  }
  const list = options.list ?? vi.fn().mockResolvedValue(options.projects ?? [])
  const create = vi.fn().mockResolvedValue(project({ id: 'new', name: 'New' }))
  TestBed.configureTestingModule({
    providers: [
      ...provideJigForTests(),
      { provide: SHELL_CLIENT, useValue: { browse } },
      {
        provide: API_CLIENT,
        useValue: {
          projects: { list, create },
          capabilities: vi.fn().mockResolvedValue(options.capabilities ?? LOCAL_COLUMN),
        },
      },
    ],
  })
  const translate = TestBed.inject(TranslateService)
  // Before createComponent, as every page spec here does: TestBed auto-detects changes and the
  // template reads `t.translations()` unguarded.
  await translate.ready
  await TestBed.inject(CapabilitiesStore).load()
  const fixture = TestBed.createComponent(DesktopBrowsePage)
  fixture.detectChanges()
  // `ready` is what makes the attach awaitable rather than a microtask count, exactly as
  // `DesktopSlicersPage.ready` does for its first `slicers.get()`.
  if (options.awaitReady !== false) {
    await fixture.componentInstance.ready
    fixture.detectChanges()
  }
  return { fixture, page: fixture.componentInstance, browse, list, create, translate }
}

function host(fixture: Setup['fixture']): HTMLElement {
  fixture.detectChanges()
  return fixture.nativeElement as HTMLElement
}

function pageText(fixture: Setup['fixture']): string {
  return host(fixture).textContent?.replace(/\s+/g, ' ') ?? ''
}

/** A control found by the label a user reads on it, not by a class or a position. */
function buttonNamed(fixture: Setup['fixture'], label: string): HTMLButtonElement | null {
  const buttons = [...host(fixture).querySelectorAll('button')] as HTMLButtonElement[]
  return (
    buttons.find(
      (button) =>
        button.textContent?.replace(/\s+/g, ' ').trim() === label ||
        button.getAttribute('aria-label') === label,
    ) ?? null
  )
}

describe('DesktopBrowsePage', () => {
  describe('the native view is not a DOM element', () => {
    /*
     * Spec 4.3, and the reason both halves are one test: `attach` without `detach` leaves a
     * third-party page painted over whatever route the user went to next, and Angular unmounting
     * this component does nothing at all to it. Call *counts*, not "was called": a page that
     * attached twice would leave the first view orphaned in the shell, which is the same defect
     * from the other side.
     */
    it('attaches once on init and detaches once on teardown', async () => {
      const { fixture, browse } = await setup()

      expect(browse.attach).toHaveBeenCalledTimes(1)
      expect(browse.detach).not.toHaveBeenCalled()

      fixture.destroy()

      expect(browse.attach).toHaveBeenCalledTimes(1)
      expect(browse.detach).toHaveBeenCalledTimes(1)
    })

    /*
     * The modal rule (spec 4.1). The view paints over the renderer unconditionally, so a dialog
     * drawn under its rectangle is invisible — and `detach` is not the answer, because it destroys
     * the page the user was on. Asserted as "hide was called and detach was not", because the
     * tempting wrong implementation passes any test that only checks something happened.
     */
    it('hides the view for a modal and never detaches it', async () => {
      const { page, browse } = await setup({ downloads: [download()] })

      await page.onOpenLanding(download())

      expect(browse.hide).toHaveBeenCalledTimes(1)
      expect(browse.detach).not.toHaveBeenCalled()

      await page.onCloseLanding()

      expect(browse.show).toHaveBeenCalledTimes(1)
      expect(browse.detach).not.toHaveBeenCalled()
    })

    /*
     * Spec 4.2: the renderer owns the intent and reports it on element resize, window resize and
     * its own scroll. jsdom's `getBoundingClientRect` answers all zeros, so the element is given a
     * rectangle of its own — otherwise every report would be the same zero rect and the
     * de-duplication below would swallow the second one for the wrong reason.
     */
    it('reports the placeholder rectangle on a window resize and on a scroll', async () => {
      const { fixture, page, browse } = await setup()
      const placeholder = host(fixture).querySelector('[data-browse-viewport]') as HTMLElement
      expect(placeholder).not.toBeNull()
      let rect = { x: 0, y: 120, width: 900, height: 600 }
      placeholder.getBoundingClientRect = (() => rect) as never

      window.dispatchEvent(new Event('resize'))
      expect(browse.setBounds).toHaveBeenLastCalledWith({
        x: 0,
        y: 120,
        width: 900,
        height: 600,
      })

      const afterResize = browse.setBounds.mock.calls.length
      // The same rectangle again is not news, and a scroll fires on every wheel notch.
      window.dispatchEvent(new Event('scroll'))
      expect(browse.setBounds).toHaveBeenCalledTimes(afterResize)

      rect = { x: 0, y: 40, width: 900, height: 600 }
      window.dispatchEvent(new Event('scroll'))
      expect(browse.setBounds).toHaveBeenLastCalledWith({ x: 0, y: 40, width: 900, height: 600 })

      // And the listeners come off with the component, or a destroyed page goes on driving the
      // shell's view from a route it is no longer on.
      const beforeDestroy = browse.setBounds.mock.calls.length
      fixture.destroy()
      rect = { x: 0, y: 0, width: 10, height: 10 }
      window.dispatchEvent(new Event('resize'))
      expect(browse.setBounds).toHaveBeenCalledTimes(beforeDestroy)
      void page
    })

    /*
     * **Destroyed while `#open` is still awaiting, which is where the registrations leak.**
     *
     * `#close` clears the interval, disconnects the observer and removes both listeners — but
     * `#open` *registers* all of them after two awaits, so a destroy landing inside either one ran
     * teardown first and setup second, against a component nothing would ever tear down again.
     * What leaks is permanent (an interval making three IPC calls every 500 ms for the life of the
     * window), cumulative (a second visit to `/browse` starts another) and silent (`state`, `show`
     * and `setBounds` do not go through the host's `#requireView()`, so a zombie polls a detached
     * view and logs nothing).
     *
     * **Driven by ordering and never by a clock.** The shell fake holds the await open and the
     * test resolves it by hand, so "destroyed mid-open" is a sequence this test controls rather
     * than a race it hopes for — the wall-clock version is what CI has twice caught here.
     *
     * Two tests because there are two awaits and each has its own guard: below `attach`, nothing
     * should even be *loaded*; below `projects.list` — the wide one, HTTP in remote mode — nothing
     * should be *registered*.
     */
    it('loads nothing more when the page is destroyed while attach is still outstanding', async () => {
      let landAttach: (state: BrowseStateDto) => void = () => {}
      let attachCalled = (): void => {}
      const attaching = new Promise<void>((resolve) => {
        attachCalled = resolve
      })
      const attach = vi.fn().mockImplementation(() => {
        attachCalled()
        return new Promise<BrowseStateDto>((resolve) => {
          landAttach = resolve
        })
      })

      const { fixture, page, browse, list } = await setup({
        overrides: { attach },
        awaitReady: false,
      })
      // Awaited rather than counted in microtasks: the fake itself says when the page got here.
      await attaching

      fixture.destroy()
      landAttach(IDLE)
      await page.ready

      expect(browse.detach).toHaveBeenCalledTimes(1)
      // Nothing past the first await ran at all — no project list, no first poll.
      expect(list).not.toHaveBeenCalled()
      expect(browse.state).not.toHaveBeenCalled()
    })

    it('registers no timer and no listeners when the page is destroyed while the project list is outstanding', async () => {
      let landProjects: (projects: ProjectDto[]) => void = () => {}
      let listCalled = (): void => {}
      const listing = new Promise<void>((resolve) => {
        listCalled = resolve
      })
      const list = vi.fn().mockImplementation(() => {
        listCalled()
        return new Promise<ProjectDto[]>((resolve) => {
          landProjects = resolve
        })
      })
      // The interval is the leak with no other observable surface: jsdom has no `ResizeObserver`,
      // so the page's own guard skips the observer here, and an interval that was scheduled cannot
      // be seen from the shell fake without waiting for it to fire.
      const scheduled = vi.spyOn(globalThis, 'setInterval')
      onTestFinished(() => scheduled.mockRestore())

      const { fixture, page, browse } = await setup({ list, awaitReady: false })
      await listing
      const placeholder = (fixture.nativeElement as HTMLElement).querySelector(
        '[data-browse-viewport]',
      ) as HTMLElement
      let rect = { x: 0, y: 120, width: 900, height: 600 }
      placeholder.getBoundingClientRect = (() => rect) as never
      const scheduledBefore = scheduled.mock.calls.length
      const boundsBefore = browse.setBounds.mock.calls.length
      const statesBefore = browse.state.mock.calls.length

      fixture.destroy()
      landProjects([])
      await page.ready

      expect(browse.detach).toHaveBeenCalledTimes(1)
      // No poll was ever scheduled, so the state call count cannot grow either.
      expect(scheduled.mock.calls.length).toBe(scheduledBefore)
      expect(browse.state).toHaveBeenCalledTimes(statesBefore)
      // And neither window listener is on: a rectangle that really moved reports nothing.
      rect = { x: 0, y: 40, width: 900, height: 600 }
      window.dispatchEvent(new Event('resize'))
      window.dispatchEvent(new Event('scroll'))
      expect(browse.setBounds).toHaveBeenCalledTimes(boundsBefore)
    })
  })

  describe('site-controlled strings', () => {
    /*
     * Constraint 13 and spec 3.10, as the assertion rather than as the sentence. Angular escapes
     * interpolated text by default, which is exactly why this is written down: the two things a
     * browse chrome wants are a URL rendered as a link and a favicon rendered as an image, and
     * those are the two places the default does not save you.
     */
    it('renders a hostile title and a javascript: URL as text, and creates no element from either', async () => {
      const hostile: BrowseStateDto = {
        ...IDLE,
        title: '<img src=x onerror=alert(1)>',
        url: 'javascript:alert(1)',
      }
      const { fixture } = await setup({ state: hostile })

      const root = host(fixture)
      expect(pageText(fixture)).toContain('<img src=x onerror=alert(1)>')
      expect(pageText(fixture)).toContain('javascript:alert(1)')
      // Nothing was parsed as markup...
      expect(root.querySelector('img')).toBeNull()

      /*
       * ...and the page has no navigable target of any kind. Asserted as **no anchor and no
       * `href` or `src` attribute anywhere**, rather than as "no href holds this value", and the
       * difference is the whole assertion: a first version checked that the hrefs on the page did
       * not include `javascript:alert(1)`, and it passed with the URL bound straight into an
       * `[href]` — because Angular's DomSanitizer had rewritten it to `unsafe:javascript:alert(1)`,
       * which is a *different string*. That test was green on the design being violated, and it
       * was measured going green that way. This one is about the page having no `[href]`, `[src]`
       * or anchor to put a stranger's string into in the first place, which is the property the
       * page is built on: every control here is a button, and the way to go somewhere is
       * `browse.navigate`.
       */
      expect([...root.querySelectorAll('a')]).toEqual([])
      expect([...root.querySelectorAll('[href]')]).toEqual([])
      expect([...root.querySelectorAll('[src]')]).toEqual([])
    })

    /*
     * The other strings under the same rule — `fileName` and `pageUrl` off a download, which reach
     * a different code path from `title` and `url` and would otherwise be covered by nothing.
     * Measured: deleting the truncation from the page's own helper left the two assertions above
     * green, because those read `displayUrl`/`displayTitle` instead.
     */
    it('renders a download name and its page as bounded text', async () => {
      const longPage = `https://example.com/${'q'.repeat(4000)}`
      const nasty = download({ fileName: `<b>${'z'.repeat(4000)}</b>.zip`, pageUrl: longPage })
      const { fixture } = await setup({ downloads: [nasty] })

      const root = host(fixture)
      expect(root.querySelector('b')).toBeNull()
      expect(pageText(fixture)).not.toContain('z'.repeat(400))
      expect(pageText(fixture)).not.toContain('q'.repeat(400))
      expect(pageText(fixture)).toContain(truncateForDisplay(longPage))
    })

    /*
     * The other half of "rendered as text only": truncated for display, because a page can set a
     * title of any length and the app's own chrome must not be re-laid-out by one.
     */
    it('truncates a very long site string rather than laying the chrome out around it', async () => {
      const long = `https://example.com/${'a'.repeat(4000)}`
      const { fixture } = await setup({ state: { ...IDLE, url: long, title: 'x'.repeat(4000) } })

      expect(pageText(fixture)).not.toContain('a'.repeat(400))
      expect(pageText(fixture)).not.toContain('x'.repeat(400))
      expect(pageText(fixture)).toContain(truncateForDisplay(long))
    })

    it('goes somewhere through browse.navigate rather than through an anchor', async () => {
      const { page, browse } = await setup()

      page.address.set('https://www.printables.com/model/999')
      await page.onGo()

      expect(browse.navigate).toHaveBeenCalledWith('https://www.printables.com/model/999')
    })
  })

  describe('loading and the interstitial', () => {
    /*
     * Spec 4.5. Two of the four sites answer 403 with Cloudflare's non-interactive managed
     * challenge and clear themselves in about 5.6 s and 6.4 s, so a spinner that gives up first
     * converts a working page into an error message.
     *
     * **Driven by counted polls rather than by a clock.** What is waited for is a navigation, and
     * the count is ordering this test controls; a wall-clock bound would be the thing CI has twice
     * caught. Nothing here times out: the view stays attached in both arms.
     */
    it('shows an ordinary loading state first and says the site is verifying only after a generous wait', async () => {
      const loading: BrowseStateDto = { ...IDLE, isLoading: true }
      const { fixture, page, browse, translate } = await setup({ state: loading })
      const strings = translate.translations().browse

      // Opening the page polls once itself, so the sequence is stated rather than counted from a
      // guess about where it starts.
      expect(page.loadingPolls()).toBe(1)
      expect(pageText(fixture)).toContain(strings.loading)
      expect(pageText(fixture)).not.toContain(strings.verifying)

      while (page.loadingPolls() < BROWSE_INTERSTITIAL_TICKS - 1) await page.refresh()
      expect(pageText(fixture)).not.toContain(strings.verifying)
      expect(pageText(fixture)).toContain(strings.loading)

      await page.refresh()
      expect(pageText(fixture)).toContain(strings.verifying)
      // Never a timeout: the view is a browser and the user can look at it.
      expect(browse.detach).not.toHaveBeenCalled()
      expect(browse.reload).not.toHaveBeenCalled()
    })

    it('drops the interstitial the moment the page finishes loading', async () => {
      const loading: BrowseStateDto = { ...IDLE, isLoading: true }
      const { fixture, page, browse, translate } = await setup({ state: loading })
      while (page.loadingPolls() < BROWSE_INTERSTITIAL_TICKS) await page.refresh()
      expect(pageText(fixture)).toContain(translate.translations().browse.verifying)

      browse.state.mockResolvedValue(IDLE)
      await page.refresh()

      expect(pageText(fixture)).not.toContain(translate.translations().browse.verifying)
      expect(pageText(fixture)).not.toContain(translate.translations().browse.loading)
    })
  })

  describe('the landing UI', () => {
    /*
     * Spec 6.3's core rule, and the two halves have to be one test: a page that preselected the
     * match by landing the file would satisfy "it matched" and be the defect the whole design is
     * written against — `matchKey` is derived rather than measured, and a wrong silent match puts
     * someone's file in someone else's project.
     */
    it('preselects the project whose website matches the page, and lands nothing', async () => {
      const match = project({ id: 'p-match', name: 'Thing 1234', website: THING_URL })
      const other = project({ id: 'p-other', name: 'Something else' })
      const { page, browse } = await setup({
        projects: [other, match],
        downloads: [download()],
      })

      await page.onOpenLanding(download())

      expect(page.selectedProjectId()).toBe('p-match')
      expect(page.suggestedProjectIds()).toEqual(['p-match'])
      expect(browse.land).not.toHaveBeenCalled()
    })

    /*
     * The placeholder above the panels is `min-height: 60vh` and stays in flow while the view is
     * hidden, so on a short window a panel opens below a screenful of empty dashed box and the
     * click reads as having done nothing at all.
     *
     * jsdom implements no scrolling and does not define `scrollIntoView`, which is why the page
     * guards the call — so the assertion is that the call is made, on the panel, with the argument
     * that scrolls the least.
     */
    it('scrolls an opened panel into view, past the screenful of placeholder above it', async () => {
      const scrolled = vi.fn()
      Element.prototype.scrollIntoView = function (this: Element, ...args: unknown[]): void {
        scrolled(this, ...args)
      } as never
      onTestFinished(() => {
        delete (Element.prototype as { scrollIntoView?: unknown }).scrollIntoView
      })
      const { fixture, page } = await setup({ downloads: [download()] })

      await page.onOpenLanding(download())

      const panel = host(fixture).querySelector('[aria-labelledby="browse-landing-title"]')
      expect(panel).not.toBeNull()
      expect(scrolled).toHaveBeenCalledWith(panel, { block: 'nearest' })
    })

    /*
     * **The panels claim no modality, because nothing here implements any.**
     *
     * Both are inline sections in the page flow. While either is up everything outside stays
     * rendered, focusable and operable — the toolbar really does drive the hidden view — and there
     * is no focus trap, no inert subtree, no Escape handling and no focus move into the panel. An
     * `aria-modal="true"` would tell assistive technology that all of that is inert, which is a
     * lying docblock expressed in ARIA rather than in a comment. Asserted as **no `role="dialog"`
     * and no `aria-modal` attribute anywhere**, plus the fact the claim would deny: a control
     * outside the panel that is still enabled.
     */
    it('labels the landing panel as a region and claims no modality it does not implement', async () => {
      const { fixture, page, translate } = await setup({ downloads: [download()] })

      await page.onOpenLanding(download())

      const root = host(fixture)
      expect([...root.querySelectorAll('[role="dialog"]')]).toEqual([])
      expect([...root.querySelectorAll('[aria-modal]')]).toEqual([])
      expect(root.querySelector('[aria-labelledby="browse-landing-title"]')).not.toBeNull()
      // The claim aria-modal would make, measured: the chrome outside is still operable.
      expect(buttonNamed(fixture, translate.translations().browse.reload)?.disabled).toBe(false)
    })

    /*
     * Spec 6.4: matching runs in the renderer, over the project list the picker needs anyway, and
     * `includeArchived` is not incidental — a project the user archived is still the project this
     * model belongs to, and landing into it beats a duplicate beside it.
     */
    it('reads the project list from API_CLIENT, archived ones included', async () => {
      const { page, list } = await setup({ downloads: [download()] })

      await page.onOpenLanding(download())

      expect(list).toHaveBeenCalledWith({ includeArchived: true })
    })

    /*
     * The `land` count asserted from the other end: a download reaching `completed` is not an
     * instruction. Landing is only ever a `land` call after an explicit user action.
     */
    it('lands nothing when a download completes, however many times the page polls', async () => {
      const match = project({ id: 'p-match', name: 'Thing 1234', website: THING_URL })
      const { page, browse } = await setup({ projects: [match], downloads: [download()] })

      await page.refresh()
      await page.refresh()

      expect(browse.land).toHaveBeenCalledTimes(0)
    })

    /*
     * Spec 6.3: two projects sharing a key is possible, is not an error, and all of them are
     * offered, ordered by name. `website` is not unique in the schema and nothing says it should
     * be.
     */
    it('offers every project sharing the key, ordered by name, and reports none of it as an error', async () => {
      const b = project({ id: 'p-b', name: 'Benchy, the second', website: THING_URL })
      const a = project({ id: 'p-a', name: 'Benchy', website: `${THING_URL}?from=recommend` })
      const { fixture, page } = await setup({ projects: [b, a], downloads: [download()] })

      await page.onOpenLanding(download())

      expect(page.suggestedProjectIds()).toEqual(['p-a', 'p-b'])
      expect(host(fixture).querySelector('[role="alert"]')).toBeNull()
    })

    /*
     * **The cost of the seam, pinned so it is visible rather than remembered.**
     *
     * `matchKey` matches on `ModelSiteIdentity`, whose `identity` is a function; `browse.sites()`
     * answers `ModelSiteDto`, which deliberately carries no `hosts` and no `identity`, because a
     * function cannot cross IPC. So the renderer has no registry rows and every key it computes is
     * `matchKey`'s fallback — lowercased `hostname + pathname`, with any port joined on as
     * `_<port>` rather than `:<port>`.
     *
     * The fallback spans a query and a fragment (asserted above, with the measured
     * `?from=recommend`) and does **not** span MakerWorld's locale *path* segment, which is a
     * registry row's job. That is a narrowing and never a widening: the user picks from the same
     * list a first-time download uses, and no file goes anywhere it was not sent.
     *
     * This test exists so that giving the renderer real rows — the only fix — turns it red rather
     * than passing unnoticed. If it fails because a suggestion appeared, that is the seam being
     * closed and this test being finished, not a regression.
     */
    it('does not span a locale path segment, because the renderer has no registry rows', async () => {
      const german = project({
        id: 'p-de',
        name: 'Box',
        website: 'https://makerworld.com/de/models/2093108-the-box',
      })
      const english = download({
        downloadId: 'd-mw',
        pageUrl: 'https://makerworld.com/en/models/2093108-the-box',
        siteId: 'makerworld',
      })
      const { page } = await setup({ projects: [german], downloads: [english] })

      await page.onOpenLanding(english)

      expect(page.suggestedProjectIds()).toEqual([])
      expect(page.selectedProjectId()).toBeNull()
    })

    /*
     * Spec 6.3, and the shape the whole section exists to get right: a first-time download matches
     * nothing **by definition** — the project does not exist yet, which is why the user is on the
     * site. "Create a new project" is offered beside "choose a project" and not after a failure.
     */
    it('offers creating a project beside choosing one, with nothing reported as an error', async () => {
      const { fixture, page, translate } = await setup({
        projects: [project({ id: 'p1', name: 'Unrelated' })],
        downloads: [download()],
      })

      await page.onOpenLanding(download())

      const text = pageText(fixture)
      expect(text).toContain(translate.translations().browse.chooseProject)
      expect(text).toContain(translate.translations().browse.orCreate)
      expect(host(fixture).querySelector('[role="alert"]')).toBeNull()
      expect(page.selectedProjectId()).toBeNull()
    })

    /*
     * Spec 6.3: a project created here gets its `website` set to the canonical URL of the page the
     * download came from, and that is the whole reason the *second* download from that model
     * matches.
     */
    it('sets a new project website to the page the download came from, then lands into it', async () => {
      const { page, browse, create } = await setup({ downloads: [download()] })
      create.mockResolvedValue(project({ id: 'p-new', name: 'Benchy' }))
      await page.onOpenLanding(download())
      page.newProjectName.set('Benchy')

      await page.onCreateAndLand()

      expect(create).toHaveBeenCalledWith({ name: 'Benchy', website: THING_URL })
      expect(browse.land).toHaveBeenCalledWith('d1', 'p-new', { name: 'benchy.zip' })
    })

    /*
     * Spec 6.3 and open question 9.19's second surface. A `window.open(blobUrl)` download carries
     * the popup's `webContents`, and a popup whose navigation became a download never committed a
     * document — so it is staged, verifiable and landable with **no attribution at all**.
     *
     * Asserted three ways because a blank field passes a test that only looks for the absence of a
     * URL: the page must say what happened, must not render the word `null`, and must not invent a
     * `website` for a project created from it.
     */
    it('says a popup download named no page, rather than rendering a blank field or the word null', async () => {
      const popup = download({ downloadId: 'd-pop', pageUrl: null, siteId: null })
      const { fixture, page, browse, create, translate } = await setup({ downloads: [popup] })
      create.mockResolvedValue(project({ id: 'p-new', name: 'From a popup' }))

      await page.onOpenLanding(popup)

      const text = pageText(fixture)
      expect(text).toContain(translate.translations().browse.fromNoPage)
      expect(text).not.toContain('null')
      expect(page.selectedProjectId()).toBeNull()

      page.newProjectName.set('From a popup')
      await page.onCreateAndLand()

      // No `website` key at all, rather than `website: null` or an empty string: there is no
      // canonical URL, and inventing one is what would make a later download match the wrong thing.
      expect(create).toHaveBeenCalledWith({ name: 'From a popup' })
      expect(browse.land).toHaveBeenCalledWith('d-pop', 'p-new', { name: 'benchy.zip' })
    })

    /*
     * Constraint 14 and spec 5.3. `land` refuses an unverifiable record before it opens anything,
     * so a page that offered the control would be offering a button that cannot work — and the
     * bytes behind it are byte-for-byte indistinguishable from a complete file.
     */
    it('offers discard and not landing for a download whose record cannot vouch for it', async () => {
      const bad = download({ downloadId: 'd-bad', isVerifiable: false })
      const { fixture, browse, translate } = await setup({ downloads: [bad] })
      const strings = translate.translations().browse

      expect(pageText(fixture)).toContain(strings.downloadUnverifiable)
      expect(buttonNamed(fixture, strings.addToProject)).toBeNull()
      const discard = buttonNamed(fixture, strings.discard)
      expect(discard).not.toBeNull()

      discard?.click()
      await Promise.resolve()

      expect(browse.discard).toHaveBeenCalledWith('d-bad')
      expect(browse.land).not.toHaveBeenCalled()
    })

    /*
     * A name clash is reported, not worked around. `benchy-1.zip` beside `benchy.zip` hides exactly
     * the fact the user was trying to discover, so the UI's job is to let them rename and retry —
     * asserted as "the second call carried the name the user typed", because a page that merely
     * showed a message and dropped the panel would pass a text-only assertion.
     */
    it('reports a refused landing and adds again under the name the user types', async () => {
      const { fixture, page, browse, translate } = await setup({
        projects: [project({ id: 'p1', name: 'Benchy' })],
        downloads: [download()],
        overrides: {
          land: vi
            .fn()
            .mockRejectedValueOnce(new AppError('Conflict', 'a file called that is already here'))
            .mockResolvedValue(landedFile({ name: 'benchy (2).zip' })),
        },
      })
      await page.onOpenLanding(download())
      page.selectedProjectId.set('p1')

      await page.onLand()

      expect(pageText(fixture)).toContain(translate.translations().browse.errorClash)
      // Nothing was renamed for the user, and the panel is still open to be retried.
      expect(browse.land).toHaveBeenCalledWith('d1', 'p1', { name: 'benchy.zip' })
      expect(page.landing()).not.toBeNull()

      page.fileName.set('benchy (2).zip')
      await page.onLand()

      expect(browse.land).toHaveBeenLastCalledWith('d1', 'p1', { name: 'benchy (2).zip' })
    })
  })

  describe('the archive obligation', () => {
    /*
     * Spec 5.5 and open question 9.1. This bullet is not a nicety: it is the whole reason the
     * extraction deferral is honest. A remote user who takes the one download flow that was ever
     * measured end to end gets an opaque file in their library with no models, no previews and no
     * route to the contents from inside the app.
     *
     * **Driven off the capability column and not off a boolean the test sets**, because the
     * argument for the remote message *is* `canPickLocalFolder` being false there.
     */
    it('names what a landed archive costs in remote mode', async () => {
      const { fixture, page, translate } = await setup({
        capabilities: REMOTE_COLUMN,
        projects: [project({ id: 'p1', name: 'Benchy' })],
        downloads: [download()],
      })
      await page.onOpenLanding(download())
      page.selectedProjectId.set('p1')

      await page.onLand()

      const strings = translate.translations().browse
      expect(pageText(fixture)).toContain(strings.archiveRemote)
      expect(pageText(fixture)).not.toContain(strings.archiveLocal)
    })

    it('names the remedy for a landed archive in local mode', async () => {
      const { fixture, page, translate } = await setup({
        capabilities: LOCAL_COLUMN,
        projects: [project({ id: 'p1', name: 'Benchy' })],
        downloads: [download()],
      })
      await page.onOpenLanding(download())
      page.selectedProjectId.set('p1')

      await page.onLand()

      const strings = translate.translations().browse
      expect(pageText(fixture)).toContain(strings.archiveLocal)
      expect(pageText(fixture)).not.toContain(strings.archiveRemote)
    })

    /*
     * The pair that keeps the two above from passing for the wrong reason: a page that showed the
     * archive message for every landed file would be green on both, and would be saying something
     * false about an `.stl`.
     */
    it('says nothing about archives when what landed is not one', async () => {
      const { fixture, page, translate } = await setup({
        capabilities: REMOTE_COLUMN,
        projects: [project({ id: 'p1', name: 'Benchy' })],
        downloads: [download({ fileName: 'benchy.stl' })],
        overrides: { land: vi.fn().mockResolvedValue(landedFile({ name: 'benchy.stl' })) },
      })
      await page.onOpenLanding(download({ fileName: 'benchy.stl' }))
      page.selectedProjectId.set('p1')

      await page.onLand()

      const strings = translate.translations().browse
      expect(pageText(fixture)).not.toContain(strings.archiveRemote)
      expect(pageText(fixture)).not.toContain(strings.archiveLocal)
    })
  })

  describe('notices', () => {
    /*
     * E decision 7, and the only surface a refusal has: `preventDefault()` gives the page no error,
     * no failed entry and no DOM change, so the click simply appears to have done nothing.
     */
    it('renders a notice, dismisses it, and offers to make room beside a refusal', async () => {
      const refused: BrowseNoticeDto = {
        id: 'n1',
        kind: 'refused',
        fileName: 'huge.zip',
        detail: 'there is no room to stage another download',
        at: 0,
      }
      const { fixture, browse, translate } = await setup({
        notices: [refused],
        downloads: [download()],
      })
      const strings = translate.translations().browse

      expect(pageText(fixture)).toContain('huge.zip')
      expect(pageText(fixture)).toContain('there is no room to stage another download')

      const makeRoom = buttonNamed(
        fixture,
        strings.makeRoom.replace('{{ count }}', '1').replace('{{ count }}', '1'),
      )
      expect(makeRoom).not.toBeNull()
      makeRoom?.click()
      await Promise.resolve()
      expect(browse.discard).toHaveBeenCalledWith('d1')

      buttonNamed(fixture, strings.dismiss)?.click()
      await Promise.resolve()
      expect(browse.dismissNotice).toHaveBeenCalledWith('n1')
    })

    /*
     * `discard` refuses a still-running download with `Conflict`; a user must wait or quit. So the
     * bulk control must not offer to take one with it — a control that always failed on a page
     * where something is downloading is a control that reads as broken.
     */
    it('leaves a still-running download out of the make-room control', async () => {
      const running = download({ downloadId: 'd-run', state: 'progressing', receivedBytes: 10 })
      const finished = download({ downloadId: 'd-done' })
      const { browse, page } = await setup({
        notices: [{ id: 'n1', kind: 'refused', fileName: 'x.zip', detail: 'no room', at: 0 }],
        downloads: [running, finished],
      })

      await page.onMakeRoom()

      expect(browse.discard).toHaveBeenCalledTimes(1)
      expect(browse.discard).toHaveBeenCalledWith('d-done')
    })
  })
})

describe('truncateForDisplay', () => {
  it('leaves a short string alone and bounds a long one', () => {
    expect(truncateForDisplay('https://example.com/x')).toBe('https://example.com/x')
    const long = 'y'.repeat(5000)
    expect(truncateForDisplay(long).length).toBeLessThan(200)
    // The ellipsis is what says the value was cut, rather than the app rendering a different URL
    // as if it were the whole one.
    expect(truncateForDisplay(long).endsWith('…')).toBe(true)
  })
})
