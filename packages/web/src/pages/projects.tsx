import { useNavigate, useParams } from '@solidjs/router'
import { createEffect, createSignal, For, onCleanup, Show } from 'solid-js'
import { t } from '../core/i18n'
import { onLibraryChanged } from '../core/library-events'
import { errorMessage } from '../core/i18n/errors'
import { notify } from '../core/notify'
import { createProjectsStore, isFiltered } from '../core/projects-store'
import {
  clampPanelWidth,
  PANEL_MAX_WIDTH,
  PANEL_MIN_WIDTH,
  readPanelWidth,
  writePanelWidth,
} from '../core/panel-width'
import { settings } from '../core/stores'
import {
  current as currentView,
  resetCurrentView,
  setSaveViewOpen,
  updateCurrentView,
} from '../core/view-actions'
import { shapeOf } from '../core/views'
import { SEARCH_MAX_LENGTH, type ProjectDto, type SettingsDto } from '../api/generated'
import {
  Alert,
  ArrowDownWideNarrow,
  ArrowUpNarrowWide,
  Badge,
  BookmarkPlus,
  Button,
  CheckList,
  EmptyState,
  FilterPill,
  FilterPillButton,
  FilterPills,
  Funnel,
  Layers,
  LayoutGrid,
  List,
  MediaCard,
  MenuTrigger,
  Plus,
  Popover,
  PopoverDivider,
  PopoverSection,
  RefreshCw,
  ScrollSentinel,
  Search,
  Skeleton,
  Spinner,
  Splitter,
  SplitPane,
  Switch,
  Tag,
  Toolbar,
  ToolbarSearch,
  ToolbarSpacer,
  ToolButton,
  ToolToggleGroup,
  Undo2,
  ViewChanges,
  type MenuEntry,
} from '../ui'
import { cx } from '../ui'
import { ProjectDetail } from './project-detail'
import { ProjectFormDialog } from './project-form-dialog'

export const SEARCH_DEBOUNCE_MS = 250
const COVER_POLL_MS = 4000
/** About three minutes: a cover still missing by then is not coming while the page is open. */
const COVER_MAX_POLLS = 45
/** Tags shown on a card before the rest collapse into "+n". */
const CARD_TAGS = 3

/**
 * What a project card says in place of a cover: "pending" only while a preview can still come (the
 * folder is there and holds a model or a slicer project); otherwise there simply is none.
 */
function coverPlaceholderKey(
  project: ProjectDto,
): 'projects.previewPending' | 'projects.previewUnsupported' {
  const { model, slicerProject } = project.fileCounts
  return project.state === 'ok' && model + slicerProject > 0
    ? 'projects.previewPending'
    : 'projects.previewUnsupported'
}

function fileTotal(project: ProjectDto): number {
  const { model, slicerProject, other } = project.fileCounts
  return model + slicerProject + other
}

/**
 * The projects page (subsystem H): filter row, list or grid, infinite scroll, create dialog.
 *
 * Which element scrolls: the window. The app shell is a normal-flow column (a sticky sidebar, no
 * overflow container around the routed page), so nothing on this page is its own scroller. The end
 * of the list is therefore detected with an `IntersectionObserver` on a marker below the list
 * (`ScrollSentinel`), which reports the same thing whichever ancestor scrolls, and a "Load more"
 * button is always there while more rows exist: a keyboard or screen-reader user never scrolls.
 */
export default function ProjectsPage() {
  const navigate = useNavigate()
  const store = createProjectsStore({
    onRememberFailed: () => notify.error(t('projects.filterNotRemembered')),
  })
  void store.start()

  /**
   * The list follows the settings. Picking a saved view in the sidebar writes them, and this is
   * how that reaches a page that is already open; it also corrects a list built from the defaults
   * because the settings had not loaded yet when the page mounted.
   */
  createEffect(() => store.applyShape(shapeOf(settings.settings())))

  // A folder made in Explorer, a file a slicer saved, a change synced down: the list follows.
  onLibraryChanged(() => void store.refreshInPlace())

  // Covers are made after a project is found, so a fresh library shows "Preview pending" on every
  // card. While any card still waits for one, ask again now and then, as the project panel does
  // for its files, and stop once none does or after a few minutes.
  let coverPolls = 0
  createEffect(() => {
    const waiting = store
      .items()
      .some(
        (project) =>
          !project.coverThumbUrl && coverPlaceholderKey(project) === 'projects.previewPending',
      )
    if (!waiting) coverPolls = 0
    if (!waiting || coverPolls >= COVER_MAX_POLLS) return
    const timer = setTimeout(() => {
      coverPolls++
      void store.refreshInPlace()
    }, COVER_POLL_MS)
    onCleanup(() => clearTimeout(timer))
  })

  const [creating, setCreating] = createSignal(false)
  const [rescanning, setRescanning] = createSignal(false)
  // Updated after a user-triggered page so a screen reader hears that rows arrived.
  const [announced, setAnnounced] = createSignal<number | null>(null)

  let searchTimer: ReturnType<typeof setTimeout> | undefined
  onCleanup(() => clearTimeout(searchTimer))

  const viewMode = () => settings.settings().viewMode
  const selectedTags = () => store.query().tags ?? []
  const archivedShown = () => store.query().includeArchived === true
  /** What the funnel's badge counts: each chosen tag, and showing archived projects. */
  const filterCount = () => selectedTags().length + (archivedShown() ? 1 : 0)

  /**
   * The open view and whether it was changed since. The pills under the toolbar spell the filters
   * out only then — or with no view at all — as the app this follows does: a saved view's own
   * filters are its business, and show as the count on the funnel.
   */
  const view = () => currentView()
  const showPills = () => filterCount() > 0 && (view() === null || view()?.modified === true)

  function onSearch(value: string) {
    clearTimeout(searchTimer)
    searchTimer = setTimeout(() => store.setSearch(value), SEARCH_DEBOUNCE_MS)
  }

  async function onSort(sort: SettingsDto['sort'], dir: SettingsDto['dir']) {
    try {
      await store.setSort(sort, dir)
    } catch {
      // Applied locally, not remembered: the settings store already rolled the key back.
      notify.error(t('projects.filterNotRemembered'))
    }
  }

  /**
   * The sort menu: the field, then the direction. Picking a field takes the direction that field
   * reads naturally in (names A to Z, dates newest first); the two entries below turn it round.
   */
  const SORT_FIELDS: readonly { key: SettingsDto['sort']; dir: SettingsDto['dir'] }[] = [
    { key: 'updatedAt', dir: 'desc' },
    { key: 'name', dir: 'asc' },
    { key: 'createdAt', dir: 'desc' },
  ]
  // The query always carries both once the store has started; the defaults only satisfy the type.
  const sortKey = (): SettingsDto['sort'] => store.query().sort ?? 'updatedAt'
  const sortDir = (): SettingsDto['dir'] => store.query().dir ?? 'desc'
  const sortField = (key: SettingsDto['sort']) =>
    t(('projects.sortField_' + key) as 'projects.sortField_name')
  const sortDirection = () =>
    sortDir() === 'asc' ? t('projects.sortAscending') : t('projects.sortDescending')
  const sortLabel = () =>
    t('projects.sortedBy', { field: sortField(sortKey()), direction: sortDirection() })
  const sortMenu = (): MenuEntry[] => [
    ...SORT_FIELDS.map((field) => ({
      label: sortField(field.key),
      checked: sortKey() === field.key,
      onSelect: () => void onSort(field.key, field.dir),
    })),
    { type: 'separator' },
    {
      label: t('projects.sortAscending'),
      checked: sortDir() === 'asc',
      onSelect: () => void onSort(sortKey(), 'asc'),
    },
    {
      label: t('projects.sortDescending'),
      checked: sortDir() === 'desc',
      onSelect: () => void onSort(sortKey(), 'desc'),
    },
  ]

  async function onViewMode(mode: 'grid' | 'list') {
    try {
      await settings.patch({ viewMode: mode })
    } catch (error) {
      notify.error(errorMessage(error))
    }
  }

  async function onLoadMore() {
    const before = store.items().length
    await store.loadMore()
    const after = store.items().length
    if (after !== before) setAnnounced(after)
  }

  async function onRescan() {
    setRescanning(true)
    try {
      const result = await store.rescan()
      notify.success(
        t('projects.rescanned', { adopted: result.adopted, filesAdded: result.filesAdded }),
      )
    } catch (error) {
      notify.error(errorMessage(error))
    } finally {
      setRescanning(false)
    }
  }

  const fileCountLabel = (project: ProjectDto) => {
    const count = fileTotal(project)
    return count === 1 ? t('projects.fileCountOne') : t('projects.fileCountMany', { count })
  }

  const card = (project: ProjectDto) => (
    <li>
      <MediaCard
        layout={viewMode()}
        href={`/projects/${project.id}`}
        title={project.name}
        image={project.coverThumbUrl}
        imageAlt=""
        placeholder={t(coverPlaceholderKey(project))}
        meta={fileCountLabel(project)}
        badges={
          <>
            <Show when={project.isArchived}>
              <Badge>{t('projects.archived')}</Badge>
            </Show>
            <Show when={project.state === 'missing'}>
              <Badge variant="danger">{t('projects.missing')}</Badge>
            </Show>
            <For each={project.tags.slice(0, CARD_TAGS)}>{(tag) => <Tag>{tag}</Tag>}</For>
            <Show when={project.tags.length > CARD_TAGS}>
              <Badge>+{project.tags.length - CARD_TAGS}</Badge>
            </Show>
          </>
        }
      />
    </li>
  )

  /**
   * Which project is open beside the list. **It is the route**, not a signal of its own:
   * `/projects/abc` is the list with that one selected, so a link, the back button and a reload
   * all land where the user expects, and there is no second copy of the selection to drift.
   */
  const params = useParams<{ id?: string; fileId?: string }>()
  const selected = () => params.id ?? null
  const [panelWidth, setPanelWidth] = createSignal(readPanelWidth())
  const resize = (width: number) => {
    const next = clampPanelWidth(width)
    setPanelWidth(next)
    writePanelWidth(next)
  }

  const listClass = () =>
    viewMode() === 'grid'
      ? 'm-0 grid list-none grid-cols-[repeat(auto-fill,minmax(13rem,1fr))] gap-4 p-0'
      : 'm-0 flex list-none flex-col gap-2 p-0'

  return (
    <div class="flex min-h-0 flex-1">
      <div
        class={cx(
          '@container/list flex min-h-0 min-w-0 flex-1 flex-col',
          // On a phone there is no room for two columns: the panel is the page while it is open.
          selected() !== null && 'hidden md:flex',
        )}
      >
        <h1 class="sr-only">{t('projects.title')}</h1>
        {/* The toolbar and the pills are outside the scroller: the list moves, they never do. */}
        <Toolbar label={t('projects.toolbar')}>
          <ToolbarSearch
            label={t('projects.search')}
            clearLabel={t('projects.clearSearch')}
            value={store.query().search ?? ''}
            maxLength={SEARCH_MAX_LENGTH}
            onInput={onSearch}
          />
          <Popover
            label={t('projects.filters')}
            trigger={({ trigger, expanded }) => (
              <ToolButton
                icon={Funnel}
                label={
                  filterCount() > 0
                    ? t('projects.filtersActive', { count: filterCount() })
                    : t('projects.filters')
                }
                badge={filterCount()}
                expanded={expanded}
                trigger={trigger}
              />
            )}
          >
            <PopoverSection title={t('projects.tags')} class="min-h-0 flex-1">
              <CheckList
                label={t('projects.tags')}
                searchLabel={t('projects.findTag')}
                emptyText={t('projects.noTags')}
                noMatchText={t('projects.noTagMatches')}
                options={store.knownTags()}
                value={selectedTags()}
                onChange={(next) => void store.setTags(next)}
              />
            </PopoverSection>
            <PopoverDivider />
            <div class="p-3">
              <Switch
                label={t('projects.includeArchived')}
                checked={archivedShown()}
                onChange={(next) => void store.setIncludeArchived(next)}
              />
            </div>
          </Popover>
          <MenuTrigger label={t('settings.sort')} items={sortMenu()}>
            {({ trigger, expanded }) => (
              <ToolButton
                icon={sortDir() === 'asc' ? ArrowUpNarrowWide : ArrowDownWideNarrow}
                label={sortLabel()}
                expanded={expanded}
                trigger={trigger}
              />
            )}
          </MenuTrigger>
          <Show when={view()?.modified ? view() : null}>
            {(changed) => (
              <ViewChanges
                label={t('views.unsavedChangesTo', { name: changed().view.name })}
                text={t('views.unsaved')}
                reset={{
                  label: t('views.resetTo', { name: changed().view.name }),
                  icon: Undo2,
                  onClick: resetCurrentView,
                }}
                save={{
                  label: t('views.saveChanges'),
                  icon: BookmarkPlus,
                  items: [
                    {
                      label: t('views.updateNamed', { name: changed().view.name }),
                      onSelect: () => void updateCurrentView(),
                    },
                    { label: t('views.saveAsNew'), onSelect: () => setSaveViewOpen(true) },
                  ],
                }}
              />
            )}
          </Show>
          <ToolbarSpacer />
          <ToolToggleGroup
            label={t('projects.viewMode')}
            value={viewMode()}
            onChange={(mode) => void onViewMode(mode)}
            options={[
              { value: 'grid', label: t('projects.viewModeGrid'), icon: LayoutGrid },
              { value: 'list', label: t('projects.viewModeList'), icon: List },
            ]}
          />
          <ToolButton
            icon={RefreshCw}
            label={t('projects.rescan')}
            disabled={rescanning()}
            onClick={() => void onRescan()}
          />
          <Button
            variant="primary"
            size="sm"
            icon={Plus}
            aria-label={t('projects.newProject')}
            title={t('projects.newProject')}
            onClick={() => setCreating(true)}
          >
            <span class="hidden @2xl/list:inline">{t('projects.newProject')}</span>
          </Button>
        </Toolbar>
        <Show when={showPills()}>
          <FilterPills label={t('projects.activeFilters')}>
            <For each={selectedTags()}>
              {(tag) => (
                <FilterPill
                  name={t('projects.tagFilterName')}
                  value={tag}
                  removeLabel={t('projects.removeFilter', { name: tag })}
                  onRemove={() =>
                    void store.setTags(selectedTags().filter((selected) => selected !== tag))
                  }
                />
              )}
            </For>
            <Show when={archivedShown()}>
              <FilterPill
                value={t('projects.archivedShown')}
                removeLabel={t('projects.removeFilter', { name: t('projects.archivedShown') })}
                onRemove={() => void store.setIncludeArchived(false)}
              />
            </Show>
            <FilterPillButton
              onClick={() => {
                void store.setTags([])
                if (archivedShown()) void store.setIncludeArchived(false)
              }}
            >
              {t('projects.clearFilters')}
            </FilterPillButton>
          </FilterPills>
        </Show>
        {/*
          `relative` is load-bearing: an absolutely positioned descendant with no positioned
          ancestor is laid out against the initial containing block, so the `sr-only` status line
          at the foot of a long list ends up at the foot of the *document* and gives the window a
          scrollbar beside the title bar. Positioning the scroller contains them.
        */}
        <div class="relative min-h-0 flex-1 overflow-y-auto">
          <div class="@container mx-auto flex w-full max-w-6xl flex-col gap-6 px-4 py-5 md:px-6">
            <Show
              when={!store.loadFailed()}
              fallback={
                <div class="flex flex-col items-start gap-3">
                  <Alert variant="danger" class="w-full">
                    {t('projects.loadFailed')}
                  </Alert>
                  <Button icon={RefreshCw} onClick={() => void store.reload()}>
                    {t('common.retry')}
                  </Button>
                </div>
              }
            >
              <Show
                when={!store.loadingFirst()}
                fallback={
                  <ul class={listClass()} aria-busy="true" aria-label={t('common.loading')}>
                    <For each={Array.from({ length: 8 })}>
                      {() => (
                        <li>
                          <Skeleton
                            class={viewMode() === 'grid' ? 'aspect-4/5 w-full' : 'h-20 w-full'}
                          />
                        </li>
                      )}
                    </For>
                  </ul>
                }
              >
                <Show
                  when={store.items().length > 0}
                  fallback={
                    isFiltered(store.query()) ? (
                      <EmptyState
                        icon={Search}
                        title={t('projects.noMatches')}
                        description={t('projects.noMatchesHint')}
                      />
                    ) : (
                      <EmptyState
                        icon={Layers}
                        title={t('projects.empty')}
                        description={t('projects.emptyHint')}
                        action={
                          <Button variant="primary" icon={Plus} onClick={() => setCreating(true)}>
                            {t('projects.newProject')}
                          </Button>
                        }
                      />
                    )
                  }
                >
                  <ul class={listClass()}>
                    <For each={store.items()}>{card}</For>
                  </ul>
                  <div class="flex flex-col items-center gap-3">
                    <Show when={store.loadingMore()}>
                      <Spinner label={t('common.loading')} />
                    </Show>
                    <Show when={store.loadMoreFailed()}>
                      <Alert variant="danger">{t('projects.loadMoreFailed')}</Alert>
                    </Show>
                    <Show when={store.hasMore()}>
                      {/* Never disabled while loading: that would drop keyboard focus to the page. */}
                      <Button
                        aria-busy={store.loadingMore() ? 'true' : undefined}
                        onClick={() => void onLoadMore()}
                      >
                        {t('projects.loadMore')}
                      </Button>
                    </Show>
                    <ScrollSentinel
                      onReach={() => void onLoadMore()}
                      disabled={!store.hasMore() || store.loadMoreFailed()}
                      rearmKey={store.items().length}
                    />
                    <p class="sr-only" role="status">
                      <Show when={announced()}>
                        {(count) => t('projects.showing', { count: count() })}
                      </Show>
                    </p>
                  </div>
                </Show>
              </Show>
            </Show>
          </div>
        </div>
      </div>
      <Show when={selected()}>
        {(id) => (
          <>
            <div class="hidden md:flex">
              <Splitter
                label={t('projects.panelWidth')}
                value={panelWidth()}
                min={PANEL_MIN_WIDTH}
                max={PANEL_MAX_WIDTH}
                grows="left"
                onChange={resize}
              />
            </div>
            <SplitPane label={t('projects.detailPanel')} width={panelWidth()}>
              <ProjectDetail
                id={id()}
                onClose={() => navigate('/projects')}
                onChanged={() => void store.reload()}
                previewFileId={params.fileId ?? null}
                onPreview={(fileId) =>
                  navigate(fileId ? `/projects/${id()}/view/${fileId}` : `/projects/${id()}`)
                }
              />
            </SplitPane>
          </>
        )}
      </Show>
      <ProjectFormDialog
        open={creating()}
        onOpenChange={setCreating}
        title={t('projects.createTitle')}
        description={t('projects.createLead')}
        submitLabel={t('projects.create')}
        withTags
        tagSuggestions={store.knownTags()}
        onSubmit={async (values) => {
          const created = await store.create({
            name: values.name,
            ...(values.website ? { website: values.website } : {}),
            ...(values.notes.trim() ? { notes: values.notes } : {}),
            ...(values.tags.length > 0 ? { tags: values.tags } : {}),
          })
          navigate(`/projects/${created.id}`)
        }}
      />
    </div>
  )
}
