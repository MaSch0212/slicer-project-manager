import { createEffect, createSignal, For, onCleanup, onMount, Show } from 'solid-js'
import type { BrowseDownloadDto } from '../api/generated'
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
  Badge,
  BrowserChrome,
  BrowserNotice,
  BrowserPanel,
  BrowserTabStrip,
  Button,
  Card,
  FormField,
  Globe,
  Heading,
  IconButton,
  Input,
  overlayOpen,
  Progress,
  RefreshCw,
  Select,
  Text,
  ViewportSlot,
} from '../ui'

/**
 * The model browser: several sites open at once, each a native view laid over this page, with the
 * app's own chrome around them.
 *
 * **The views are not in this document**, so everything the page draws lives outside their
 * rectangle: the tab strip and the address row above it. The page reports the placeholder's
 * bounds (mount, resize, scroll, a sidebar collapsing), hides the views while a dialog or menu is
 * open, and takes them off screen — but does not destroy them — when the route goes.
 *
 * **Every string a site chose is rendered as text**, bounded, and never as markup or a link: the
 * way to go somewhere is the address field, the start-site picker or a tab, which ask the shell.
 */
export default function BrowsePage(props: { deps?: Partial<BrowseDeps> }) {
  const browse = createBrowse(props.deps)
  const [address, setAddress] = createSignal('')
  const [editing, setEditing] = createSignal(false)
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
      </BrowserChrome>

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

      <ViewportSlot
        ref={(element: HTMLDivElement) => (slot = element)}
        label={t('browse.title')}
        fill
      >
        {t('browse.noPage')}
      </ViewportSlot>

      {/*
        The downloads, still a list under the view. The decide-when-it-starts dialog that replaces
        this needs the choice to live in the shell rather than here (a file has to land even if
        you left the page while it was coming down), which is its own piece of work; until then
        this is the only way to file what a site sent, so it stays.
      */}
      <Show when={browse.notices().length > 0 || browse.downloads().length > 0 || browse.landed()}>
        <BrowserPanel label={t('browse.downloadsTitle')}>
          <For each={browse.notices()}>
            {(notice) => (
              <Alert
                variant={notice.kind === 'refused' ? 'warning' : 'info'}
                title={t('browse.noticesTitle')}
              >
                <Text as="span">{truncateForDisplay(notice.fileName)}</Text>
                <Text as="span" variant="muted">
                  {truncateForDisplay(notice.detail)}
                </Text>
                <div class="mt-2 flex flex-wrap gap-2">
                  <Button
                    size="sm"
                    variant="secondary"
                    onClick={() => void browse.dismissNotice(notice.id)}
                  >
                    {t('browse.dismiss')}
                  </Button>
                  <Show when={notice.kind === 'refused' && browse.roomMakers().length > 0}>
                    <Button size="sm" variant="secondary" onClick={() => void browse.makeRoom()}>
                      {t('browse.makeRoom', { count: browse.roomMakers().length })}
                    </Button>
                  </Show>
                </div>
              </Alert>
            )}
          </For>

          <Show when={browse.landed()}>
            {(landed) => (
              <>
                <Alert variant="success">
                  {t('browse.landed', {
                    name: truncateForDisplay(landed().name),
                    project: truncateForDisplay(landed().project),
                  })}
                </Alert>
                <Show when={landed().archive}>
                  {(mode) => (
                    <Alert variant="warning">
                      {mode() === 'remote' ? t('browse.archiveRemote') : t('browse.archiveLocal')}
                    </Alert>
                  )}
                </Show>
              </>
            )}
          </Show>

          <Show when={browse.downloads().length > 0}>
            <Heading level={2}>{t('browse.downloadsTitle')}</Heading>
            <ul class="m-0 flex list-none flex-col gap-3 p-0">
              <For each={browse.downloads()}>
                {(item) => <DownloadRow item={item} browse={browse} />}
              </For>
            </ul>
          </Show>
        </BrowserPanel>
      </Show>
    </div>
  )
}

function DownloadRow(props: { item: BrowseDownloadDto; browse: BrowseStore }) {
  const item = () => props.item
  const running = () => isStillDownloading(item())
  const open = () => props.browse.panel()?.download.downloadId === item().downloadId
  return (
    <li>
      <Card class="flex flex-col gap-3">
        <div class="flex flex-wrap items-center gap-2">
          <Text as="span" variant="label">
            {truncateForDisplay(item().fileName)}
          </Text>
          <Show when={item().isOrphan}>
            <Badge variant="warning">{t('browse.downloadOrphan')}</Badge>
          </Show>
        </div>

        <Show when={running()}>
          <Text variant="small">
            {item().totalBytes > 0
              ? t('browse.downloadRunning', {
                  received: formatBytes(item().receivedBytes),
                  total: formatBytes(item().totalBytes),
                })
              : t('browse.downloadRunningUnknownSize', {
                  received: formatBytes(item().receivedBytes),
                })}
          </Text>
          <Progress
            label={truncateForDisplay(item().fileName)}
            value={item().totalBytes > 0 ? item().receivedBytes / item().totalBytes : undefined}
          />
        </Show>
        <Show when={!running() && !item().isVerifiable}>
          <Alert variant="warning">
            {item().state === 'completed' ? '' : `${t('browse.downloadFailed')} `}
            {t('browse.downloadUnverifiable')}
          </Alert>
        </Show>

        <Show
          when={item().pageUrl}
          fallback={<Text variant="small">{t('browse.fromNoPage')}</Text>}
        >
          {(page) => (
            <Text variant="small">{t('browse.fromPage', { url: truncateForDisplay(page()) })}</Text>
          )}
        </Show>

        <div class="flex flex-wrap gap-2">
          <Show when={!running() && item().state === 'completed' && item().isVerifiable}>
            <Button
              size="sm"
              variant="primary"
              onClick={() => void props.browse.openPanel(item())}
              aria-expanded={open()}
            >
              {t('browse.addToProject')}
            </Button>
          </Show>
          <Show when={!running()}>
            <Button size="sm" variant="secondary" onClick={() => void props.browse.discard(item())}>
              {t('browse.discard')}
            </Button>
          </Show>
        </div>

        <Show when={open()}>
          <LandingPanelView browse={props.browse} />
        </Show>
      </Card>
    </li>
  )
}

function LandingPanelView(props: { browse: BrowseStore }) {
  const panel = () => props.browse.panel()
  return (
    <Show when={panel()}>
      {(current) => (
        <div
          role="region"
          aria-label={t('browse.addToProject')}
          class="flex flex-col gap-4"
          ref={(element: HTMLDivElement) =>
            queueMicrotask(() => element.scrollIntoView?.({ block: 'nearest' }))
          }
        >
          <Show when={current().suggested.length > 0}>
            <Alert variant="info" title={t('browse.suggested')}>
              {t('browse.suggestedLead')}
            </Alert>
          </Show>
          <Show when={current().error}>{(error) => <Alert variant="danger">{error()}</Alert>}</Show>
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
          <FormField label={t('browse.fileNameLabel')}>
            <Input
              value={current().fileName}
              onInput={(event) => props.browse.editPanel({ fileName: event.currentTarget.value })}
            />
          </FormField>
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
          <Show when={isArchiveName(current().fileName)}>
            <Text variant="small">{t('browse.archiveLocal')}</Text>
          </Show>
          <div class="flex flex-wrap gap-2">
            <Button
              variant="primary"
              loading={current().busy}
              disabled={current().projectId === '' && current().newName.trim() === ''}
              onClick={() => void props.browse.land()}
            >
              {current().projectId === '' ? t('browse.createAndAdd') : t('browse.addHere')}
            </Button>
            <Button variant="secondary" onClick={() => props.browse.closePanel()}>
              {t('browse.cancel')}
            </Button>
          </div>
        </div>
      )}
    </Show>
  )
}
