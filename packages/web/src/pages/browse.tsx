import { createEffect, createMemo, createSignal, onCleanup, onMount, Show } from 'solid-js'
import {
  BROWSE_TEXT_MAX,
  createBrowse,
  isArchiveName,
  isStillDownloading,
  truncateForDisplay,
  type BrowseDeps,
  type BrowseStore,
} from '../core/browse'
import { observeBounds } from '../core/browse-bounds'
import { formatBytes } from '../core/format-bytes'
import { t } from '../core/i18n'
import {
  Alert,
  ArrowLeft,
  ArrowRight,
  BrowserChrome,
  BrowserNotice,
  BrowserTabStrip,
  Button,
  Dialog,
  DownloadChip,
  DownloadTray,
  FormField,
  Globe,
  IconButton,
  Input,
  overlayOpen,
  RefreshCw,
  Select,
  Text,
  ViewportSlot,
  ViewStill,
  type DownloadItem,
} from '../ui'

/**
 * The model browser: several sites open at once, each a native view laid over this page, with
 * the app's own chrome around them.
 *
 * **The views are not in this document**, so everything the page draws lives outside their
 * rectangle: the tab strip and the address row above, the download tray between. The page
 * reports the placeholder's bounds (mount, resize, scroll, a sidebar collapsing), hides the
 * views while a dialog or menu is open, and takes them off screen — but does not destroy them —
 * when the route goes.
 *
 * **A download is decided when it starts, not when it arrives.** The dialog opens the moment a
 * site sends a file, over a still picture of the view (nothing the page draws can cover a native
 * view, so the view is swapped for a photograph of itself); the choice is recorded in the shell
 * and the file files itself when it lands, even if the user has walked away by then.
 *
 * **Every string a site chose is rendered as text**, bounded, and never as markup or a link: the
 * way to go somewhere is the address field, the start-site picker or a tab, which ask the shell.
 */
export default function BrowsePage(props: { deps?: Partial<BrowseDeps> }) {
  const browse = createBrowse(props.deps)
  const [address, setAddress] = createSignal('')
  const [editing, setEditing] = createSignal(false)
  const [trayOpen, setTrayOpen] = createSignal(false)
  let slot: HTMLDivElement | undefined
  let stopObserving: (() => void) | null = null

  onMount(() => {
    if (!slot) return
    const rect = slot.getBoundingClientRect()
    void browse.open({ x: rect.x, y: rect.y, width: rect.width, height: rect.height }).then(() => {
      if (slot) stopObserving = observeBounds(slot, (bounds) => void browse.reportBounds(bounds))
    })
  })
  onCleanup(() => {
    stopObserving?.()
    browse.dispose()
  })

  // A dialog or menu opened over the page hides the views, and closing it puts the front one back.
  createEffect(() => {
    overlayOpen()
    void browse.syncOverlay()
  })
  // The address follows the page, unless the user is typing in it.
  createEffect(() => {
    const url = browse.state()?.url ?? ''
    if (!editing()) setAddress(url)
  })

  const state = () => browse.state()
  const tabs = () => browse.tabs()
  const go = (event: SubmitEvent) => {
    event.preventDefault()
    if (address().trim() !== '') void browse.navigate(address())
    setEditing(false)
  }

  /** A tab's name: what the page calls itself, else its host, else the placeholder. */
  const tabLabel = (tab: { title: string | null; url: string | null }) => {
    if (tab.title) return truncateForDisplay(tab.title, 60)
    if (tab.url) {
      try {
        return new URL(tab.url).host
      } catch {
        return truncateForDisplay(tab.url, 60)
      }
    }
    return t('browse.newTab')
  }

  /**
   * Everything the browser currently has to say, newest first: files on their way, files waiting
   * to be filed (what a previous run left), and the problems. One list, because from where the
   * user sits they are one thing — "what happened to my download".
   */
  const items = createMemo<DownloadItem[]>(() => {
    const downloads = browse.downloads()
    const running: DownloadItem[] = downloads.filter(isStillDownloading).map((item) => ({
      id: item.downloadId,
      title: truncateForDisplay(item.fileName),
      detail: t('browse.downloadRunningUnknownSize', {
        received: formatBytes(item.receivedBytes),
      }),
      kind: 'running',
      // WebView2 reports no content length, so there is a total only once it has finished.
      progress: item.totalBytes > 0 ? item.receivedBytes / item.totalBytes : undefined,
      dismissLabel: `${t('browse.cancelDownload')} ${item.fileName}`,
      onDismiss: () => void browse.cancelDownload(item),
    }))
    const waiting: DownloadItem[] = downloads
      .filter((item) => !isStillDownloading(item))
      .map((item) => ({
        id: item.downloadId,
        title: truncateForDisplay(item.fileName),
        // Both facts matter and neither replaces the other: where it came from, and whether
        // anything can vouch for the bytes.
        detail: [
          item.isOrphan ? t('browse.downloadOrphan') : t('browse.waitingToFile'),
          item.isVerifiable ? null : t('browse.downloadUnverifiable'),
        ]
          .filter((part) => part !== null)
          .join(' · '),
        kind: item.isVerifiable ? 'waiting' : 'problem',
        action: item.isVerifiable ? (
          <Button size="sm" variant="secondary" onClick={() => void browse.openPanel(item)}>
            {t('browse.fileIt')}
          </Button>
        ) : undefined,
        dismissLabel: `${t('browse.discard')} ${item.fileName}`,
        onDismiss: () => void browse.discard(item),
      }))
    const notices: DownloadItem[] = browse.notices().map((notice) => ({
      id: notice.id,
      title: truncateForDisplay(notice.fileName),
      detail: truncateForDisplay(notice.detail),
      kind: 'problem',
      // A refusal is the cap saying there is no room; the way out is to clear what is staged.
      action:
        notice.kind === 'refused' && browse.roomMakers().length > 0 ? (
          <Button size="sm" variant="secondary" onClick={() => void browse.makeRoom()}>
            {t('browse.makeRoom', { count: browse.roomMakers().length })}
          </Button>
        ) : undefined,
      dismissLabel: `${t('browse.dismiss')} ${notice.fileName}`,
      onDismiss: () => void browse.dismissNotice(notice.id),
    }))
    return [...running, ...waiting, ...notices]
  })

  const problem = () => items().some((item) => item.kind === 'problem')
  // Nothing to say, nothing to open: the tray shuts itself rather than leaving an empty strip.
  createEffect(() => {
    if (items().length === 0) setTrayOpen(false)
  })

  const panel = () => browse.panel()
  const deciding = () => {
    const current = panel()
    return current !== null && isStillDownloading(current.download)
  }

  return (
    <div class="flex min-h-0 flex-1 flex-col">
      <BrowserTabStrip
        label={t('browse.tabs')}
        tabs={(tabs()?.tabs ?? []).map((tab) => ({
          id: tab.tabId,
          label: tabLabel(tab),
          loading: tab.isLoading,
        }))}
        activeId={tabs()?.activeTabId ?? null}
        canOpenMore={tabs()?.canOpenMore ?? false}
        labels={{
          newTab: t('browse.newTab'),
          atCap: t('browse.tabCap'),
          close: t('browse.closeTab'),
          loading: t('browse.loading'),
        }}
        onSelect={(id) => void browse.selectTab(id)}
        onClose={(id) => void browse.closeTab(id)}
        onOpen={() => void browse.openTab()}
      />

      <BrowserChrome label={t('browse.title')} onSubmit={go}>
        <IconButton
          icon={ArrowLeft}
          label={t('browse.back')}
          disabled={!state()?.canGoBack}
          onClick={() => void browse.back()}
        />
        <IconButton
          icon={ArrowRight}
          label={t('browse.forward')}
          disabled={!state()?.canGoForward}
          onClick={() => void browse.forward()}
        />
        <IconButton
          icon={RefreshCw}
          label={t('browse.reload')}
          disabled={!tabs()?.attached}
          onClick={() => void browse.reload()}
        />
        <div class="min-w-48 flex-1">
          <Input
            aria-label={t('browse.addressLabel')}
            value={address()}
            onInput={(event) => {
              setEditing(true)
              setAddress(event.currentTarget.value)
            }}
            onBlur={() => setEditing(false)}
            spellcheck={false}
            autocomplete="off"
          />
        </div>
        <Select
          class="w-44"
          aria-label={t('browse.startOn')}
          leading={Globe}
          placeholder={t('browse.startOn')}
          value={undefined}
          options={browse.sites().map((site) => ({ value: site.id, label: site.displayName }))}
          onChange={(id) => {
            const site = browse.sites().find((entry) => entry.id === id)
            if (site) void browse.goToSite(site)
          }}
        />
        <Show when={items().length > 0}>
          <DownloadChip
            label={t('browse.downloadsTitle')}
            summary={items()[0]!.title}
            count={items().length}
            problem={problem()}
            open={trayOpen()}
            onToggle={() => setTrayOpen(!trayOpen())}
          />
        </Show>
      </BrowserChrome>

      <Show when={trayOpen() && items().length > 0}>
        <DownloadTray label={t('browse.downloadsTitle')} items={items()} />
      </Show>

      <Show when={browse.failure()}>
        {(message) => (
          <BrowserNotice>
            <Alert variant="danger">{truncateForDisplay(message())}</Alert>
          </BrowserNotice>
        )}
      </Show>
      <Show when={state()?.lastError}>
        {(error) => (
          <BrowserNotice>
            <Alert variant="warning">
              {t('browse.pageFailed')} {truncateForDisplay(error(), BROWSE_TEXT_MAX)}
            </Alert>
          </BrowserNotice>
        )}
      </Show>
      {/*
        Two of the four sites answer with a challenge that clears itself after several seconds.
        Nothing gives up when this appears; it exists so that a long wait does not look broken.
      */}
      <Show when={browse.verifying()}>
        <BrowserNotice>
          <Alert variant="info">{t('browse.verifying')}</Alert>
        </BrowserNotice>
      </Show>
      <Show when={browse.landed()}>
        {(landed) => (
          <BrowserNotice>
            <Alert variant="success">
              {t('browse.landed', {
                name: truncateForDisplay(landed().name),
                project: truncateForDisplay(landed().project),
              })}
              <Show when={landed().archive}>
                {(mode) => (
                  <Text as="span" variant="small">
                    {mode() === 'remote' ? t('browse.archiveRemote') : t('browse.archiveLocal')}
                  </Text>
                )}
              </Show>
            </Alert>
          </BrowserNotice>
        )}
      </Show>

      <ViewportSlot
        ref={(element: HTMLDivElement) => (slot = element)}
        label={t('browse.title')}
        fill
        bare={browse.still() !== null}
      >
        <Show when={browse.still()} fallback={t('browse.noPage')}>
          {(src) => <ViewStill src={src()} label={t('browse.stillLabel')} />}
        </Show>
      </ViewportSlot>

      <ChoiceDialog browse={browse} deciding={deciding()} />
    </div>
  )
}

/**
 * Where this file goes, asked once.
 *
 * For a download still on its way the answer is recorded and the shell carries it out, so the
 * dialog closes and browsing goes on. Closing it without answering cancels that download —
 * there is no third state in which a file sits unclaimed. A download that is already on disk
 * (what a previous run left) is filed when the dialog is confirmed, and backing out of it
 * leaves the file alone.
 */
function ChoiceDialog(props: { browse: BrowseStore; deciding: boolean }) {
  const panel = () => props.browse.panel()
  return (
    <Show when={panel()}>
      {(current) => (
        <Dialog
          open
          onOpenChange={(open) => {
            if (!open) void props.browse.closePanel()
          }}
          title={t('browse.addToProject')}
          description={props.deciding ? t('browse.decideLead') : t('browse.fileItLead')}
          closeLabel={t('common.close')}
          footer={
            <>
              <Button variant="secondary" onClick={() => void props.browse.closePanel()}>
                {props.deciding ? t('browse.cancelDownload') : t('browse.cancel')}
              </Button>
              <Button
                variant="primary"
                loading={current().busy}
                disabled={current().projectId === '' && current().newName.trim() === ''}
                onClick={() => void props.browse.land()}
              >
                {current().projectId === '' ? t('browse.createAndAdd') : t('browse.addHere')}
              </Button>
            </>
          }
        >
          <div class="flex flex-col gap-4">
            <Text variant="label">{truncateForDisplay(current().download.fileName)}</Text>
            {/* Where it came from, which is also what the suggestion below was matched on. */}
            <Show
              when={current().download.pageUrl}
              fallback={<Text variant="small">{t('browse.fromNoPage')}</Text>}
            >
              {(page) => (
                <Text variant="small">
                  {t('browse.fromPage', { url: truncateForDisplay(page()) })}
                </Text>
              )}
            </Show>
            <Show when={current().suggested.length > 0}>
              <Alert variant="info" title={t('browse.suggested')}>
                {t('browse.suggestedLead')}
              </Alert>
            </Show>
            <Show when={current().error}>
              {(error) => <Alert variant="danger">{error()}</Alert>}
            </Show>
            <FormField label={t('browse.chooseProject')}>
              <Select
                placeholder={t('browse.chooseProjectPlaceholder')}
                value={current().projectId || undefined}
                options={props.browse.projects().map((project) => ({
                  value: project.id,
                  label: current().suggested.includes(project.id)
                    ? `${truncateForDisplay(project.name)} (${t('browse.suggested')})`
                    : truncateForDisplay(project.name),
                }))}
                onChange={(projectId) => props.browse.editPanel({ projectId })}
              />
            </FormField>
            <Show when={props.browse.projects().length === 0}>
              <Text variant="muted">{t('browse.noProjects')}</Text>
            </Show>
            <FormField label={t('browse.orCreate')}>
              <Input
                aria-label={t('browse.newProjectName')}
                placeholder={t('browse.newProjectName')}
                value={current().newName}
                onInput={(event) =>
                  props.browse.editPanel({ newName: event.currentTarget.value, projectId: '' })
                }
              />
            </FormField>
            <FormField label={t('browse.fileNameLabel')}>
              <Input
                value={current().fileName}
                onInput={(event) => props.browse.editPanel({ fileName: event.currentTarget.value })}
              />
            </FormField>
            <Show when={isArchiveName(current().fileName)}>
              <Text variant="small">{t('browse.archiveLocal')}</Text>
            </Show>
          </div>
        </Dialog>
      )}
    </Show>
  )
}
