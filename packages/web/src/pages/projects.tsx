import { useNavigate } from '@solidjs/router'
import { createSignal, For, onCleanup, Show } from 'solid-js'
import { t } from '../core/i18n'
import { errorMessage } from '../core/i18n/errors'
import { notify } from '../core/notify'
import {
  createProjectsStore,
  isFiltered,
  parseSortValue,
  sortValueOf,
} from '../core/projects-store'
import { settings } from '../core/stores'
import { SEARCH_MAX_LENGTH, type ProjectDto } from '../api/generated'
import {
  Alert,
  Archive,
  ArchiveX,
  ArrowUpDown,
  Badge,
  Button,
  EmptyState,
  Input,
  Layers,
  LayoutGrid,
  List,
  MediaCard,
  MultiSelect,
  PageHeader,
  Plus,
  RefreshCw,
  ScrollSentinel,
  SegmentedControl,
  Search,
  Select,
  Skeleton,
  Spinner,
  Tag,
  ToggleIconButton,
  Upload,
  LinkButton,
} from '../ui'
import { ProjectFormDialog } from './project-form-dialog'

export const SEARCH_DEBOUNCE_MS = 250
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

  const [creating, setCreating] = createSignal(false)
  const [rescanning, setRescanning] = createSignal(false)
  // Updated after a user-triggered page so a screen reader hears that rows arrived.
  const [announced, setAnnounced] = createSignal<number | null>(null)

  let searchTimer: ReturnType<typeof setTimeout> | undefined
  onCleanup(() => clearTimeout(searchTimer))

  const viewMode = () => settings.settings().viewMode
  const sortOptions = () => [
    { value: 'updatedAt:desc', label: t('settings.sortUpdated') },
    { value: 'name:asc', label: t('settings.sortName') },
    { value: 'createdAt:desc', label: t('settings.sortNewest') },
  ]
  const selectedTags = () => store.query().tags ?? []
  const archivedShown = () => store.query().includeArchived === true

  function onSearch(value: string) {
    clearTimeout(searchTimer)
    searchTimer = setTimeout(() => store.setSearch(value), SEARCH_DEBOUNCE_MS)
  }

  async function onSort(value: string) {
    const parsed = parseSortValue(value)
    if (!parsed) return
    try {
      await store.setSort(parsed.sort, parsed.dir)
    } catch {
      // Applied locally, not remembered: the settings store already rolled the key back.
      notify.error(t('projects.filterNotRemembered'))
    }
  }

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

  const listClass = () =>
    viewMode() === 'grid'
      ? 'm-0 grid list-none grid-cols-2 gap-4 p-0 sm:grid-cols-3 lg:grid-cols-4'
      : 'm-0 flex list-none flex-col gap-2 p-0'

  return (
    <div class="flex flex-col gap-6">
      <PageHeader
        title={t('projects.title')}
        actions={
          <>
            <LinkButton href="/import" icon={Upload}>
              {t('import.title')}
            </LinkButton>
            <Button icon={RefreshCw} loading={rescanning()} onClick={() => void onRescan()}>
              {t('projects.rescan')}
            </Button>
            <Button variant="primary" icon={Plus} onClick={() => setCreating(true)}>
              {t('projects.newProject')}
            </Button>
          </>
        }
      />

      <div class="flex flex-wrap items-center gap-2">
        <div class="w-full min-w-0 sm:max-w-[350px] sm:flex-1">
          <Input
            type="search"
            leading={Search}
            aria-label={t('projects.search')}
            placeholder={t('projects.search')}
            maxLength={SEARCH_MAX_LENGTH}
            autocomplete="off"
            onInput={(event) => onSearch(event.currentTarget.value)}
          />
        </div>
        <div class="flex w-full flex-wrap items-center gap-2 sm:ml-auto sm:w-auto">
          <div class="w-full sm:w-auto">
            <Select
              aria-label={t('settings.sort')}
              leading={ArrowUpDown}
              class="sm:min-w-44"
              options={sortOptions()}
              value={sortValueOf(store.query())}
              onChange={(value) => void onSort(value)}
            />
          </div>
          <ToggleIconButton
            label={t('projects.includeArchived')}
            pressed={archivedShown()}
            onPressedChange={(next) => void store.setIncludeArchived(next)}
            iconOn={Archive}
            iconOff={ArchiveX}
          />
          <div class="min-w-0 flex-1 sm:w-36 sm:flex-none">
            <MultiSelect
              class="w-full"
              label={t('projects.tags')}
              emptyText={t('common.noOptions')}
              options={store.knownTags().map((tag) => ({ value: tag, label: tag }))}
              value={selectedTags()}
              onChange={(next) => void store.setTags(next)}
            />
          </div>
          <SegmentedControl
            iconOnly
            label={t('projects.viewMode')}
            value={viewMode()}
            onChange={(mode) => void onViewMode(mode)}
            options={[
              { value: 'grid', label: t('projects.viewModeGrid'), icon: LayoutGrid },
              { value: 'list', label: t('projects.viewModeList'), icon: List },
            ]}
          />
        </div>
      </div>

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
                    <Skeleton class={viewMode() === 'grid' ? 'aspect-4/5 w-full' : 'h-20 w-full'} />
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
