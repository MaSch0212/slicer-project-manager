import { createSignal } from 'solid-js'
import {
  PROJECT_LIMIT_MAX,
  type BrowseBounds,
  type BrowseDownloadDto,
  type BrowseNoticeDto,
  type BrowseStateDto,
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
 * ## The view is not an element
 *
 * It is a native webview the shell lays over the window; it paints over whatever the page draws
 * and CSS cannot place it. So the page only *describes* where it should be: it reports the
 * placeholder's rectangle (see `browse-bounds.ts`), the shell intersects that with an area it
 * computes itself, and the page hides the view (`hide`) for as long as a dialog or menu is open
 * ({@link overlayOpen}) and destroys it (`detach`) when the route goes.
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

/** The panel that adds one download to a project. */
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
  const [state, setState] = createSignal<BrowseStateDto | null>(null)
  const [downloads, setDownloads] = createSignal<BrowseDownloadDto[]>([])
  const [notices, setNotices] = createSignal<BrowseNoticeDto[]>([])
  const [projects, setProjects] = createSignal<ProjectDto[]>([])
  const [failure, setFailure] = createSignal<string | null>(null)
  const [verifying, setVerifying] = createSignal(false)
  const [panel, setPanel] = createSignal<LandingPanel | null>(null)
  const [landed, setLanded] = createSignal<Landed | null>(null)

  let destroyed = false
  let attached = false
  let timer: ReturnType<typeof setInterval> | null = null
  let loadingTicks = 0
  let lastBounds: BrowseBounds | null = null
  let overlayHidden = false

  const same = (a: BrowseBounds | null, b: BrowseBounds) =>
    a !== null && a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height

  async function poll(): Promise<void> {
    if (destroyed || !attached) return
    try {
      const [nextState, nextDownloads, nextNotices] = await Promise.all([
        deps.browse.state(),
        deps.browse.downloads(),
        deps.browse.notices(),
      ])
      if (destroyed) return
      setState(nextState)
      setDownloads(nextDownloads)
      setNotices(nextNotices)
      loadingTicks = nextState.isLoading ? loadingTicks + 1 : 0
      setVerifying(loadingTicks >= deps.interstitialTicks)
    } catch {
      // A poll that fails is the next poll's to repeat; the page has nothing better to say.
    }
  }

  return {
    sites,
    state,
    downloads,
    notices,
    projects,
    failure,
    verifying,
    panel,
    landed,

    /**
     * Creates the view where the placeholder is and starts polling. If the page is destroyed
     * while this is still waiting for the shell, the view is detached again and nothing starts.
     */
    async open(bounds: BrowseBounds): Promise<void> {
      try {
        lastBounds = bounds
        const [siteList, first] = await Promise.all([
          deps.browse.sites(),
          deps.browse.attach(bounds, null),
        ])
        if (destroyed) {
          void deps.browse.detach().catch(() => {})
          return
        }
        attached = true
        setSites(siteList)
        setState(first)
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
          setState(await deps.browse.show())
          // The rectangle may have changed while it was hidden; the shell reapplied the last one.
        }
      } catch {
        // Hiding failed: the next change of overlay tries again.
      }
    },

    async navigate(url: string): Promise<void> {
      setFailure(null)
      try {
        setState(await deps.browse.navigate(url.trim()))
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
        setState(await deps.browse.back())
      } catch {
        /* nothing to go back to */
      }
    },
    async forward() {
      try {
        setState(await deps.browse.forward())
      } catch {
        /* nothing to go forward to */
      }
    },
    async reload() {
      try {
        setState(await deps.browse.reload())
      } catch {
        /* nothing open */
      }
    },
    async forgetLastPage() {
      await deps.browse.clearLastPage()
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
     * Opens the panel for one download. **Lands nothing.** The projects (archived included) come
     * from the library the app is on, and the shell answers which of them the page the download
     * came from may be the source of: a suggestion, preselected, and the user confirms.
     */
    async openPanel(item: BrowseDownloadDto) {
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
      setPanel({
        download: item,
        suggested,
        projectId: suggested[0] ?? '',
        fileName: item.fileName,
        newName: '',
        busy: false,
        error: null,
      })
    },
    closePanel: () => setPanel(null),
    editPanel(patch: Partial<Pick<LandingPanel, 'projectId' | 'fileName' | 'newName'>>) {
      const current = panel()
      if (current) setPanel({ ...current, ...patch })
    },

    /** Lands into the chosen project, or creates the named one first. */
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
        let file: FileDto
        try {
          file = await deps.browse.land(
            current.download.downloadId,
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
        setLanded({ name: file.name, project: project.name, archive: mode })
        await poll()
      } catch (error) {
        setPanel({ ...current, busy: false, error: errorSentence(error, creating) })
      }
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
