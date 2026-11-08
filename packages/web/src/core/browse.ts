import { createSignal } from 'solid-js'
import {
  PROJECT_LIMIT_MAX,
  type BrowseBounds,
  type BrowseDownloadDto,
  type BrowseNoticeDto,
  type BrowseStateDto,
  type BrowseTabsDto,
  type FileDto,
  type ModelSiteDto,
  type ProjectDto,
} from '../api/generated'
import { overlayOpen } from '../ui/overlay'
import { api, type ApiClient } from './api/client'
import { isApiError } from './api/error'
import { desktop, type DesktopClient } from './desktop'
import { t } from './i18n'

/**
 * The model browser's page logic: a native view laid over the page, its downloads, and landing one
 * of them in a project.
 *
 * ## The views are not elements
 *
 * Each tab is a native webview the shell lays over the window; it paints over whatever the page
 * draws and CSS cannot place it. So the page only *describes* where they should be: it reports
 * the placeholder's rectangle (see `browse-bounds.ts`), the shell intersects that with an area it
 * computes itself, shows the front tab's view there and hides the rest, and the page hides them
 * all (`hide`) for as long as a dialog or menu is open ({@link overlayOpen}).
 *
 * ## The tabs outlive the route
 *
 * Leaving `/browse` (`detach`) takes them off screen and keeps them, so coming back finds the
 * same pages; they die with the app, and nothing about where the user was is written down. While
 * the page is gone the shell refuses any download a tab tries to start, which is what used to be
 * guaranteed by destroying the view.
 *
 * ## Site strings are text
 *
 * `title`, `url`, `lastError`, a download's `fileName`, `sourceUrl` and `pageUrl` were all chosen
 * by a stranger. They are rendered as text only (never HTML, an `href`, a `src`) and bounded with
 * {@link truncateForDisplay}; the way to *go* somewhere is `navigate`, which the shell runs
 * through its policy, not an anchor in this document.
 */

/** How often the page asks the shell what the view is doing. A poll, because a site navigates and
 * downloads without the page having done anything and there is no channel back. */
export const BROWSE_POLL_MS = 500

/**
 * How many consecutive still-loading polls before the page says the site is verifying the
 * connection. **Not a timeout; nothing gives up when it is reached.** Two of the four sites answer
 * with Cloudflare's non-interactive challenge that clears itself in a few seconds, and a spinner
 * that gave up first would turn a working page into an error. A count of polls rather than a
 * duration: it is what the page observed, and an order a test can drive.
 */
export const BROWSE_INTERSTITIAL_TICKS = 16

/** How much of a stranger's string is rendered before it is cut. */
export const BROWSE_TEXT_MAX = 160

/** A stranger's string, bounded for display. */
export function truncateForDisplay(text: string, max = BROWSE_TEXT_MAX): string {
  const characters = Array.from(text)
  return characters.length <= max ? text : `${characters.slice(0, max).join('')}…`
}

/** The extensions this page calls an archive: about the name, because that is all there is. */
const ARCHIVE_EXTENSIONS = ['.zip', '.7z', '.rar', '.tar', '.gz', '.tgz', '.zipx']

export function isArchiveName(name: string): boolean {
  const lower = name.toLowerCase()
  return ARCHIVE_EXTENSIONS.some((extension) => lower.endsWith(extension))
}

/**
 * Whether the shell would refuse to discard this row: **both halves of its rule**. An orphan whose
 * record still says `progressing` is what a kill mid-download leaves, and is not running; gating
 * on the state alone leaves that row with no control at all.
 */
export function isStillDownloading(item: BrowseDownloadDto): boolean {
  return !item.isOrphan && item.state === 'progressing'
}

/** Whether a browsed page's URL may be written down as a project's `website`: `http(s)` only. */
export function isPersistableWebsite(value: string | null): value is string {
  if (value === null) return false
  try {
    const parsed = new URL(value)
    return parsed.protocol === 'http:' || parsed.protocol === 'https:'
  } catch {
    return false
  }
}

export type LibraryMode = 'local' | 'remote'

export type BrowseDeps = {
  browse: DesktopClient['browse']
  projects: Pick<ApiClient['projects'], 'list' | 'create'>
  /** Which library mode this is, for the sentence about a landed archive. */
  libraryMode: () => Promise<LibraryMode>
  pollMs: number
  interstitialTicks: number
}

export const defaultBrowseDeps = (): BrowseDeps => ({
  browse: desktop.browse,
  projects: api.projects,
  libraryMode: async () => ((await desktop.libraryState()).mode === 'remote' ? 'remote' : 'local'),
  pollMs: BROWSE_POLL_MS,
  interstitialTicks: BROWSE_INTERSTITIAL_TICKS,
})

/** What the page says after a landing. */
export type Landed = { name: string; project: string; archive: 'local' | 'remote' | null }

/**
 * The dialog that decides where one download goes.
 *
 * It opens the moment a download starts, before the bytes are there, so the choice is made once
 * and the file files itself when it arrives. For a download that is *already* complete — one a
 * previous run left behind — there is nothing left to wait for and confirming lands it at once.
 */
export type LandingPanel = {
  download: BrowseDownloadDto
  /** Projects whose website is the page this came from: a suggestion, never applied silently. */
  suggested: string[]
  /** What was chosen in the list ('' for nothing). */
  projectId: string
  fileName: string
  newName: string
  busy: boolean
  error: string | null
}

function errorSentence(error: unknown, creating: boolean): string {
  if (!isApiError(error)) return t('browse.errorRefused')
  switch (error.code) {
    case 'Conflict':
      return t('browse.errorClash')
    case 'QuotaExceeded':
      return t('browse.errorQuota')
    case 'Validation':
      return creating ? t('browse.errorCreateName') : t('browse.errorName')
    case 'NotFound':
      return t('browse.errorGone')
    default:
      return creating ? t('browse.errorCreateRefused') : t('browse.errorRefused')
  }
}

export function createBrowse(depsOverride: Partial<BrowseDeps> = {}) {
  const deps: BrowseDeps = { ...defaultBrowseDeps(), ...depsOverride }
  const [sites, setSites] = createSignal<ModelSiteDto[]>([])
  const [tabs, setTabs] = createSignal<BrowseTabsDto | null>(null)
  const [downloads, setDownloads] = createSignal<BrowseDownloadDto[]>([])
  const [notices, setNotices] = createSignal<BrowseNoticeDto[]>([])
  const [projects, setProjects] = createSignal<ProjectDto[]>([])
  const [failure, setFailure] = createSignal<string | null>(null)
  const [verifying, setVerifying] = createSignal(false)
  const [panel, setPanel] = createSignal<LandingPanel | null>(null)
  const [landed, setLanded] = createSignal<Landed | null>(null)
  /** A picture of the front tab, shown in the view's place while the dialog is over it. */
  const [still, setStill] = createSignal<string | null>(null)

  /**
   * The project each decided download is going to, by id, so that when the shell has filed one
   * and it leaves the list the page can say where it went. The shell knows the project's id; the
   * name is the page's, from the dialog the user just confirmed.
   */
  const going = new Map<string, string>()
  /** Which downloads the dialog has already been opened for, so it opens once per download. */
  const asked = new Set<string>()

  let destroyed = false
  let attached = false
  let timer: ReturnType<typeof setInterval> | null = null
  let loadingTicks = 0
  let lastBounds: BrowseBounds | null = null
  let overlayHidden = false

  /** The tab in front, which is the one every control on the page drives. */
  const active = (): BrowseStateDto | null => {
    const all = tabs()
    if (!all) return null
    return all.tabs.find((tab) => tab.tabId === all.activeTabId) ?? null
  }

  const same = (a: BrowseBounds | null, b: BrowseBounds) =>
    a !== null && a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height

  async function poll(): Promise<void> {
    if (destroyed || !attached) return
    try {
      const [nextTabs, nextDownloads, nextNotices] = await Promise.all([
        deps.browse.tabs(),
        deps.browse.downloads(),
        deps.browse.notices(),
      ])
      if (destroyed) return
      setTabs(nextTabs)
      announceLandings(nextDownloads)
      setDownloads(nextDownloads)
      setNotices(nextNotices)
      void askAboutNewDownloads(nextDownloads)
      const front = nextTabs.tabs.find((tab) => tab.tabId === nextTabs.activeTabId)
      loadingTicks = front?.isLoading ? loadingTicks + 1 : 0
      setVerifying(loadingTicks >= deps.interstitialTicks)
    } catch {
      // A poll that fails is the next poll's to repeat; the page has nothing better to say.
    }
  }

  /**
   * A download the shell has filed has simply left the list. Say where it went, once, using the
   * project the user chose in the dialog.
   */
  function announceLandings(next: readonly BrowseDownloadDto[]): void {
    if (going.size === 0) return
    const here = new Set(next.map((item) => item.downloadId))
    // A snapshot on purpose: the loop deletes from the map it is walking.
    for (const [downloadId, project] of Array.from(going)) {
      if (here.has(downloadId)) continue
      const name = downloads().find((item) => item.downloadId === downloadId)?.fileName
      going.delete(downloadId)
      if (name === undefined) continue
      void (async () => {
        const mode = isArchiveName(name)
          ? await deps.libraryMode().catch((): LibraryMode => 'local')
          : null
        if (!destroyed) setLanded({ name, project, archive: mode })
      })()
    }
  }

  /**
   * Opens the dialog for a download nobody has decided about yet: the one that just started.
   *
   * One at a time and once each — a site that starts three downloads gets three dialogs in turn,
   * not three at once. An orphan from a previous run is left alone; it is listed, and the user
   * can file it by hand, but it must not throw a dialog in front of somebody who has just opened
   * the page.
   */
  async function askAboutNewDownloads(next: readonly BrowseDownloadDto[]): Promise<void> {
    if (panel() !== null) return
    const waiting = next.find(
      (item) => !item.isDecided && !item.isOrphan && !asked.has(item.downloadId),
    )
    if (!waiting) return
    asked.add(waiting.downloadId)
    await openPanelFor(waiting)
  }

  /** The dialog's own body: the suggestions, and the picture it will be drawn over. */
  async function openPanelFor(item: BrowseDownloadDto): Promise<void> {
    setLanded(null)
    let list = projects()
    let suggested: string[] = []
    try {
      if (list.length === 0) {
        list = await deps.projects.list({ includeArchived: true, limit: PROJECT_LIMIT_MAX })
        setProjects(list)
      }
      const match = await deps.browse.match(item.pageUrl)
      suggested = match.projects.map((project) => project.id)
    } catch {
      // No suggestion is an honest answer; choosing by hand still works.
    }
    if (destroyed) return
    // Taken **before** the dialog opens, so the picture is in the page by the time the views are
    // hidden for it. A capture that cannot be taken is not an error: the slot shows its own
    // surface, which is what it did every time before this existed.
    try {
      setStill(await deps.browse.capture())
    } catch {
      setStill(null)
    }
    if (destroyed) return
    setPanel({
      download: item,
      suggested,
      projectId: suggested[0] ?? '',
      fileName: item.fileName,
      newName: '',
      busy: false,
      error: null,
    })
  }

  return {
    sites,
    tabs,
    still,
    /** The tab in front: what the address, the history buttons and the still picture are about. */
    state: active,
    downloads,
    notices,
    projects,
    failure,
    verifying,
    panel,
    landed,

    /**
     * Puts the tabs on screen at the placeholder and starts polling. If the page is destroyed
     * while this is still waiting for the shell, they are taken off again and nothing starts.
     */
    async open(bounds: BrowseBounds): Promise<void> {
      try {
        lastBounds = bounds
        const [siteList, first] = await Promise.all([
          deps.browse.sites(),
          deps.browse.attach(bounds),
        ])
        if (destroyed) {
          void deps.browse.detach().catch(() => {})
          return
        }
        attached = true
        setSites(siteList)
        setTabs(first)
        timer = setInterval(() => void poll(), deps.pollMs)
        void poll()
        if (overlayOpen()) void this.syncOverlay()
      } catch {
        if (!destroyed) setFailure(t('browse.openFailed'))
      }
    },

    /** Reports the placeholder's rectangle, only when it changed. */
    async reportBounds(bounds: BrowseBounds): Promise<void> {
      if (!attached || destroyed || same(lastBounds, bounds)) return
      lastBounds = bounds
      try {
        await deps.browse.setBounds(bounds)
      } catch {
        // The next report repeats it.
      }
    },

    /** Hides the view while a dialog or menu is open, and puts it back when none is. */
    async syncOverlay(): Promise<void> {
      if (!attached || destroyed) return
      const open = overlayOpen()
      if (open === overlayHidden) return
      overlayHidden = open
      try {
        if (open) await deps.browse.hide()
        else {
          setTabs(await deps.browse.show())
          // The rectangle may have changed while it was hidden; the shell reapplied the last one.
        }
      } catch {
        // Hiding failed: the next change of overlay tries again.
      }
    },

    async navigate(url: string): Promise<void> {
      setFailure(null)
      try {
        setTabs(await deps.browse.navigate(url.trim()))
      } catch (error) {
        setFailure(isApiError(error) ? error.message : t('browse.pageFailed'))
        void poll()
      }
    },
    async goToSite(site: ModelSiteDto): Promise<void> {
      await this.navigate(site.homeUrl)
    },
    async back() {
      try {
        setTabs(await deps.browse.back())
      } catch {
        /* nothing to go back to */
      }
    },
    async forward() {
      try {
        setTabs(await deps.browse.forward())
      } catch {
        /* nothing to go forward to */
      }
    },
    async reload() {
      try {
        setTabs(await deps.browse.reload())
      } catch {
        /* nothing open */
      }
    },

    // --- the tabs ------------------------------------------------------------------------------

    /** Opens a tab on the registry's start page and brings it to the front. */
    async openTab(): Promise<void> {
      setFailure(null)
      try {
        setTabs(await deps.browse.openTab(null))
      } catch (error) {
        // The cap is the one refusal a user can cause, and it has a sentence of its own.
        setFailure(isApiError(error) ? t('browse.tabCap') : t('browse.openFailed'))
      }
    },
    async selectTab(tabId: string): Promise<void> {
      try {
        setTabs(await deps.browse.selectTab(tabId))
      } catch {
        // Gone between the render and the click; the next poll says so.
      }
    },
    async closeTab(tabId: string): Promise<void> {
      try {
        setTabs(await deps.browse.closeTab(tabId))
      } catch {
        // As above.
      }
    },

    // --- notices and the staged downloads ------------------------------------------------------

    async dismissNotice(id: string) {
      await deps.browse.dismissNotice(id)
      setNotices(notices().filter((notice) => notice.id !== id))
    },

    /** The downloads a refusal's "make room" control would discard: everything not running. */
    roomMakers(): BrowseDownloadDto[] {
      return downloads().filter((item) => !isStillDownloading(item))
    },
    async makeRoom() {
      for (const item of this.roomMakers()) {
        try {
          await deps.browse.discard(item.downloadId)
        } catch {
          // Already gone, or started running between the poll and now.
        }
      }
      await poll()
    },
    async discard(item: BrowseDownloadDto) {
      try {
        await deps.browse.discard(item.downloadId)
      } catch {
        // Already gone.
      }
      if (panel()?.download.downloadId === item.downloadId) setPanel(null)
      await poll()
    },

    // --- landing -------------------------------------------------------------------------------

    /**
     * Opens the dialog for one download by hand — the way to file an orphan a previous run left.
     * **Lands nothing.** The projects (archived included) come from the library the app is on,
     * and the shell answers which of them the page the download came from may be the source of:
     * a suggestion, preselected, and the user confirms.
     */
    async openPanel(item: BrowseDownloadDto) {
      asked.add(item.downloadId)
      await openPanelFor(item)
    },

    /**
     * Closing the dialog without choosing cancels the download — but only the one that opened
     * it. A download that is still coming down was never asked for by name, and a file nobody
     * has a use for must not sit in the staging directory waiting to be noticed. One that is
     * already on disk was opened by hand from the tray, and backing out of that dialog has to
     * leave the file where it was.
     */
    async closePanel() {
      const current = panel()
      setPanel(null)
      setStill(null)
      if (!current || !isStillDownloading(current.download)) return
      try {
        await deps.browse.cancel(current.download.downloadId)
      } catch {
        // Already gone, which is the same outcome.
      }
      await poll()
    },
    editPanel(patch: Partial<Pick<LandingPanel, 'projectId' | 'fileName' | 'newName'>>) {
      const current = panel()
      if (current) setPanel({ ...current, ...patch })
    },

    /**
     * Confirms the dialog: the file goes to the chosen project, or to the one named here, which
     * is created now so that it exists the moment the user asked for it.
     *
     * A download still coming down is **decided**, and the shell files it when it arrives —
     * which is why this works even if the user leaves the page. One that is already on disk (an
     * orphan from a previous run) has nothing to wait for and is landed here.
     */
    async land(): Promise<void> {
      const current = panel()
      if (!current || current.busy) return
      const creating = current.projectId === '' && current.newName.trim() !== ''
      if (current.projectId === '' && !creating) return
      setPanel({ ...current, busy: true, error: null })
      try {
        let project: { id: string; name: string }
        if (creating) {
          const website = isPersistableWebsite(current.download.pageUrl)
            ? current.download.pageUrl
            : undefined
          project = await deps.projects.create({ name: current.newName.trim(), website })
          setProjects([...projects(), project as ProjectDto])
        } else {
          const chosen = projects().find((entry) => entry.id === current.projectId)
          project = { id: current.projectId, name: chosen?.name ?? '' }
        }
        const downloadId = current.download.downloadId
        if (isStillDownloading(current.download)) {
          try {
            await deps.browse.decide(downloadId, project.id, current.fileName)
          } catch (error) {
            setPanel({
              ...current,
              projectId: project.id,
              newName: '',
              busy: false,
              error: errorSentence(error, false),
            })
            return
          }
          going.set(downloadId, project.name)
          setPanel(null)
          setStill(null)
          await poll()
          return
        }
        let file: FileDto
        try {
          file = await deps.browse.land(
            downloadId,
            project.id,
            current.fileName === current.download.fileName ? null : current.fileName,
          )
        } catch (error) {
          // The project exists now: say that the file was not added, and keep the panel on it.
          setPanel({
            ...current,
            projectId: project.id,
            newName: '',
            busy: false,
            error: errorSentence(error, false),
          })
          return
        }
        const mode = isArchiveName(file.name)
          ? await deps.libraryMode().catch((): LibraryMode => 'local')
          : null
        setPanel(null)
        setStill(null)
        setLanded({ name: file.name, project: project.name, archive: mode })
        await poll()
      } catch (error) {
        setPanel({ ...current, busy: false, error: errorSentence(error, creating) })
      }
    },

    /** Stops caring about a download from the chip, without opening the dialog for it. */
    async cancelDownload(item: BrowseDownloadDto) {
      try {
        await deps.browse.cancel(item.downloadId)
      } catch {
        // Already gone.
      }
      going.delete(item.downloadId)
      await poll()
    },

    /** Stops everything: the page is gone. Nothing may start after this. */
    dispose() {
      destroyed = true
      if (timer !== null) clearInterval(timer)
      timer = null
      if (attached) {
        attached = false
        void deps.browse.detach().catch(() => {})
      }
    },
  }
}

export type BrowseStore = ReturnType<typeof createBrowse>
