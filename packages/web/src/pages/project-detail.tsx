import { createEffect, createSignal, For, on, onCleanup, Show } from 'solid-js'
import type { FileDto } from '../api/generated'
import { api } from '../core/api/client'
import { formatBytes } from '../core/format-bytes'
import { t } from '../core/i18n'
import { onLibraryChanged } from '../core/library-events'
import { filesViewMode, setFilesViewMode } from '../core/files-view'
import {
  createProjectDetail,
  fileKindKey,
  isPreviewPending,
  previewStateKey,
  siteLabel,
  TAG_MAX_LENGTH,
  webLink,
} from '../core/project-detail'
import { createSlicerLaunch, handedMessage } from '../core/slicer-launch'
import { slicerDisplayName } from '../core/slicer-names'
import { capabilities } from '../core/stores'
import { createUploadQueue } from '../core/upload-queue'
import { validateFileName } from '../core/validation'
import {
  Alert,
  AlertTriangle,
  Archive,
  ArchiveRestore,
  Badge,
  Button,
  buttonClass,
  Card,
  Checkbox,
  CheckList,
  Clock,
  ConfirmDialog,
  Dialog,
  Download,
  DropTarget,
  EmptyState,
  FileBox,
  FilePickButton,
  FilePlus,
  FormField,
  Heading,
  IconButton,
  IconLinkButton,
  ImageOff,
  Input,
  LayoutGrid,
  Link,
  LinkButton,
  List as ListIcon,
  MediaCard,
  Menu,
  PanelHeader,
  Pencil,
  Popover,
  Printer,
  Progress,
  RefreshCw,
  Select,
  Skeleton,
  Tag,
  Tags as TagsIcon,
  Text,
  ToolToggleGroup,
  Trash2,
  type BadgeVariant,
  type IconComponent,
} from '../ui'
import { FilePreview } from './file-preview'
import { ProjectFormDialog } from './project-form-dialog'

const POLL_MS = 4000
/** A preview that is still pending after this many polls is left alone until the next visit. */
const MAX_POLLS = 45

const KIND_VARIANT: Record<FileDto['kind'], BadgeVariant> = {
  model: 'neutral',
  slicer_project: 'accent',
  other: 'neutral',
}

const PREVIEW_ICON: Record<FileDto['previewState'], IconComponent> = {
  pending: Clock,
  ready: Clock,
  failed: AlertTriangle,
  unsupported: ImageOff,
}

/**
 * One project: its details, tags, files (list or grid, with thumbnails), uploads, and the actions
 * that change it (edit, archive, delete). Every change goes through `createProjectDetail`, which
 * reports one error message and reloads. While any preview is still pending the page refetches now
 * and then, so a thumbnail appears without a manual reload.
 */
export function ProjectDetail(props: {
  id: string
  /** The panel's close. Without one there is none: the panel is the page. */
  onClose?: () => void
  /**
   * Something changed that the list behind the panel shows: the name, the tags, whether it is
   * archived, or the project itself going away.
   *
   * The panel does not replace the list any more, so a change made here has to reach it. On the
   * old page this came free, because leaving it remounted the list.
   */
  onChanged?: () => void
  /** The file in the preview popup, which is part of the address so the back button closes it. */
  previewFileId?: string | null
  /** Opens a file's preview, or closes it with `null`. */
  onPreview?: (fileId: string | null) => void
}) {
  const detail = createProjectDetail(() => props.id)

  const [editing, setEditing] = createSignal(false)
  const [deleting, setDeleting] = createSignal(false)
  const [deleteFiles, setDeleteFiles] = createSignal(false)
  const [deleteBusy, setDeleteBusy] = createSignal(false)
  const [renaming, setRenaming] = createSignal<FileDto | null>(null)
  const [renameDraft, setRenameDraft] = createSignal('')
  const [renameError, setRenameError] = createSignal<string | undefined>()
  const [renameBusy, setRenameBusy] = createSignal(false)
  const [deletingFile, setDeletingFile] = createSignal<FileDto | null>(null)
  const [fileDeleteBusy, setFileDeleteBusy] = createSignal(false)
  // The tag editor shows the user's change at once; the page refetches behind it.
  const [tags, setTags] = createSignal<string[]>([])
  // Every tag in the library, for the picker: loaded as it opens, so it is never stale.
  const [libraryTags, setLibraryTags] = createSignal<string[]>([])

  const viewMode = filesViewMode

  async function loadLibraryTags(): Promise<void> {
    try {
      setLibraryTags(await api.projects.tags())
    } catch {
      // The picker still offers this project's own tags, and adding new ones works regardless.
    }
  }
  const tagOptions = () =>
    [...new Set([...libraryTags(), ...tags()])].sort((a, b) => a.localeCompare(b))

  // Handing a file to a slicer, where the shell can (the desktop app). The configuration is loaded
  // because the page needs the facts the shell reads: which products are bound, and the default.
  const slicerLaunch = createSlicerLaunch(
    () => props.id,
    () => capabilities.capabilities().canLaunchSlicer,
  )
  createEffect(
    on(
      () => capabilities.capabilities().canLaunchSlicer,
      () => void slicerLaunch.load(),
    ),
  )

  const uploads = createUploadQueue({
    upload: (file, onProgress) =>
      api.files.uploadWithProgress(props.id, file.name, file, onProgress),
    onFileDone: () => void detail.load(),
  })

  // Follow the route: a different project starts from nothing.
  createEffect(
    on(
      () => props.id,
      () => {
        detail.reset()
        void detail.load()
      },
    ),
  )
  createEffect(() => setTags(detail.detail()?.tags ?? []))

  // A file saved next to this project's others by a slicer, or synced down, appears in place.
  onLibraryChanged(() => void detail.load())

  // Poll while a preview is pending, then stop.
  let polls = 0
  createEffect(() => {
    // A missing folder never gets its previews made, so there is nothing to wait for.
    const current = detail.detail()
    const waiting = current?.state === 'ok' && current.files.some(isPreviewPending)
    if (!waiting) polls = 0
    if (!waiting || polls >= MAX_POLLS) return
    const timer = setTimeout(() => {
      polls++
      void detail.load()
    }, POLL_MS)
    onCleanup(() => clearTimeout(timer))
  })

  async function onTagsChange(next: string[]) {
    setTags(next)
    if (await detail.setTags(next)) props.onChanged?.()
    else setTags(detail.detail()?.tags ?? [])
  }

  async function onDeleteProject() {
    setDeleteBusy(true)
    try {
      if (await detail.deleteProject(deleteFiles())) {
        props.onChanged?.()
        props.onClose?.()
      }
    } finally {
      setDeleteBusy(false)
      setDeleting(false)
    }
  }

  async function onRename() {
    const file = renaming()
    if (!file) return
    const problem = validateFileName(renameDraft())
    setRenameError(problem)
    if (problem) return
    setRenameBusy(true)
    try {
      await detail.renameFile(file, renameDraft().trim())
    } finally {
      setRenameBusy(false)
      setRenaming(null)
    }
  }

  async function onDeleteFile() {
    const file = deletingFile()
    if (!file) return
    setFileDeleteBusy(true)
    try {
      await detail.deleteFile(file)
      // Deleted from inside its own preview: there is nothing left to look at.
      if (props.previewFileId === file.id) props.onPreview?.(null)
    } finally {
      setFileDeleteBusy(false)
      setDeletingFile(null)
    }
  }

  function startRename(file: FileDto): void {
    setRenameDraft(file.name)
    setRenameError(undefined)
    setRenaming(file)
  }

  /*
   * What can be done with a file: the same set on its card, in the preview's header (both as
   * icons) and under the picture of a file with no 3D view (labelled, because there it *is* the
   * content). One function, so the three cannot drift apart.
   *
   * Two launch paths, and the difference is visible because it has to be: one opens the user's
   * own project where it lives, the other starts a new slicer project from the file (a .3mf is
   * handed over with its embedded slicer configuration stripped, so the slicer does not ask to
   * adopt someone else's settings). "As it is" is offered for a slicer project alone, which is
   * what the shell accepts on that path: for a mesh it would launch the file in place and let the
   * slicer propose its project over the top of it.
   */
  /** "Open benchy.3mf in Bambu Studio": which file, and where it is going. */
  const openLabel = (file: FileDto) => {
    const slicer = slicerLaunch.targetName(file, 'as-is')
    return slicer
      ? t('projects.openInSlicer', { file: file.name, slicer })
      : t('projects.openInAnySlicer', { file: file.name })
  }
  const newProjectLabel = (file: FileDto) => {
    const slicer = slicerLaunch.targetName(file, 'new-project')
    return slicer
      ? t('projects.newSlicerProjectIn', { file: file.name, slicer })
      : t('projects.newSlicerProject', { file: file.name })
  }

  const fileActions = (file: FileDto, compact: boolean) => (
    <Show
      when={compact}
      fallback={
        <>
          <Show when={slicerLaunch.available() && file.kind === 'slicer_project'}>
            <Button
              icon={Printer}
              disabled={slicerLaunch.busy()}
              onClick={() => void slicerLaunch.request(file, 'as-is')}
            >
              {t('projects.openInSlicerShort')}
            </Button>
          </Show>
          <Show when={slicerLaunch.available() && file.kind !== 'other'}>
            <Button
              icon={FilePlus}
              disabled={slicerLaunch.busy()}
              onClick={() => void slicerLaunch.request(file, 'new-project')}
            >
              {t('projects.newSlicerProjectShort')}
            </Button>
          </Show>
          <LinkButton href={file.rawUrl} external download={file.name} icon={Download}>
            {t('projects.download')}
          </LinkButton>
          <Button icon={Pencil} onClick={() => startRename(file)}>
            {t('projects.rename')}
          </Button>
          <Button icon={Trash2} onClick={() => setDeletingFile(file)}>
            {t('projects.deleteFile')}
          </Button>
        </>
      }
    >
      <Show when={slicerLaunch.available()}>
        <Show when={file.kind === 'slicer_project'}>
          <IconButton
            icon={Printer}
            label={openLabel(file)}
            size="sm"
            disabled={slicerLaunch.busy()}
            onClick={() => void slicerLaunch.request(file, 'as-is')}
          />
        </Show>
        {/* A text file or a picture is nothing a slicer can start a project from. */}
        <Show when={file.kind !== 'other'}>
          <IconButton
            icon={FilePlus}
            label={newProjectLabel(file)}
            size="sm"
            disabled={slicerLaunch.busy()}
            onClick={() => void slicerLaunch.request(file, 'new-project')}
          />
        </Show>
      </Show>
      <IconLinkButton
        href={file.rawUrl}
        icon={Download}
        label={`${t('projects.download')}: ${file.name}`}
        size="sm"
        external
        download={file.name}
      />
      <Menu
        iconOnly
        label={t('projects.fileActions', { name: file.name })}
        items={[
          { label: t('projects.rename'), icon: Pencil, onSelect: () => startRename(file) },
          { type: 'separator' },
          {
            label: t('projects.deleteFile'),
            icon: Trash2,
            danger: true,
            onSelect: () => setDeletingFile(file),
          },
        ]}
      />
    </Show>
  )

  const listClass = () =>
    viewMode() === 'grid'
      ? 'm-0 grid list-none grid-cols-[repeat(auto-fill,minmax(10rem,1fr))] gap-3 p-0'
      : 'm-0 flex list-none flex-col gap-2 p-0'

  // Every file opens its preview from its card, the ones with no 3D view included: the popup is
  // where their picture and their actions are.
  const fileCard = (file: FileDto, folderMissing: boolean) => (
    <li>
      <MediaCard
        layout={viewMode()}
        as="h3"
        title={file.name}
        onOpen={() => props.onPreview?.(file.id)}
        image={file.previewState === 'ready' ? file.thumbUrl : undefined}
        placeholder={t(previewStateKey(file, folderMissing))}
        placeholderIcon={
          file.kind === 'other' || folderMissing ? ImageOff : PREVIEW_ICON[file.previewState]
        }
        meta={formatBytes(file.sizeBytes)}
        badges={
          <>
            <Badge variant={KIND_VARIANT[file.kind]}>{t(fileKindKey(file.kind))}</Badge>
            <Show when={file.slicer}>
              {(slicer) => <Badge>{slicerDisplayName(slicer())}</Badge>}
            </Show>
          </>
        }
        actions={fileActions(file, true)}
      />
    </li>
  )

  return (
    /*
     * The header stays put and the body scrolls under it, so the project's name and its actions
     * never scroll away. The whole body takes dropped files; the target only shows while files
     * are dragged over it.
     */
    <div class="flex min-h-0 flex-1 flex-col">
      <PanelHeader
        title={detail.detail()?.name ?? t('projects.detailPanel')}
        actions={
          <Show when={detail.detail()}>
            {(project) => (
              <>
                <IconButton
                  icon={Pencil}
                  label={t('projects.edit')}
                  onClick={() => setEditing(true)}
                />
                <IconButton
                  icon={project().isArchived ? ArchiveRestore : Archive}
                  label={project().isArchived ? t('projects.unarchive') : t('projects.archive')}
                  onClick={() =>
                    void detail
                      .update({ isArchived: !project().isArchived })
                      .then(() => props.onChanged?.())
                  }
                />
                <IconButton
                  icon={Trash2}
                  label={t('projects.delete')}
                  onClick={() => {
                    setDeleteFiles(false)
                    setDeleting(true)
                  }}
                />
              </>
            )}
          </Show>
        }
        close={props.onClose ? { label: t('common.close'), onClick: props.onClose } : undefined}
      />
      <DropTarget
        class="flex min-h-0 flex-1 flex-col"
        label={t('projects.dropToAdd')}
        disabled={!detail.detail() || detail.detail()?.state === 'missing'}
        onFiles={(files) => uploads.add(files)}
      >
        <div class="relative min-h-0 flex-1 overflow-y-auto">
          {/*
            A container, so everything inside sizes itself against *this column* rather than the
            window. In a 460px panel a `lg:grid-cols-4` file grid makes four hundred-pixel cards
            and clips their own buttons away; the viewport is 1280 and knows nothing about it.
          */}
          <div class="@container flex flex-col gap-6 px-4 py-5">
            <Show
              when={!detail.loadError() || detail.detail()}
              fallback={
                <div class="flex flex-col items-start gap-4">
                  <Alert variant="danger" class="w-full">
                    {detail.loadError()}
                  </Alert>
                  <div class="flex gap-2">
                    <Button icon={RefreshCw} onClick={() => void detail.load()}>
                      {t('common.retry')}
                    </Button>
                    <LinkButton href="/projects" variant="secondary">
                      {t('projects.backToProjects')}
                    </LinkButton>
                  </div>
                </div>
              }
            >
              <Show
                when={detail.detail()}
                fallback={
                  <div
                    class="flex flex-col gap-4"
                    aria-busy="true"
                    aria-label={t('common.loading')}
                  >
                    <Skeleton class="h-32 w-full" />
                    <Skeleton class="h-48 w-full" />
                  </div>
                }
              >
                {(project) => (
                  <>
                    <Show when={project().isArchived}>
                      <div class="flex flex-wrap gap-2">
                        <Badge>{t('projects.archived')}</Badge>
                      </div>
                    </Show>

                    <Show when={project().state === 'missing'}>
                      <Alert variant="warning" title={t('projects.missingTitle')}>
                        {t('projects.missingHint')}
                      </Alert>
                    </Show>

                    <Show when={detail.actionError()}>
                      {(message) => <Alert variant="danger">{message()}</Alert>}
                    </Show>

                    {/* What was handed over, and to what: never that anything opened (a
                        successful spawn is not evidence the file loaded). */}
                    <Show when={slicerLaunch.launched()}>
                      {(handed) => (
                        <Alert variant="success">
                          <div class="flex flex-col gap-2">
                            <span>{handedMessage(handed())}</span>
                            <ul class="m-0 flex list-none flex-col gap-1 p-0">
                              <For each={handed().launch.notices}>
                                {(notice) => <li>{notice}</li>}
                              </For>
                            </ul>
                            <div>
                              <Button
                                size="sm"
                                variant="ghost"
                                onClick={slicerLaunch.dismissLaunched}
                              >
                                {t('projects.dismiss')}
                              </Button>
                            </div>
                          </div>
                        </Alert>
                      )}
                    </Show>
                    <Show when={slicerLaunch.error()}>
                      {(message) => (
                        <Alert variant="danger">
                          <div class="flex flex-col gap-2">
                            <span>{message()}</span>
                            <div>
                              <Button size="sm" variant="ghost" onClick={slicerLaunch.dismissError}>
                                {t('projects.dismiss')}
                              </Button>
                            </div>
                          </div>
                        </Alert>
                      )}
                    </Show>

                    <Card class="flex flex-col gap-5" padding="lg">
                      <div class="grid gap-5 @2xl:grid-cols-2">
                        <div class="flex min-w-0 flex-col gap-1">
                          <Text variant="label">{t('projects.website')}</Text>
                          <Show
                            when={project().website}
                            fallback={<Text variant="muted">&ndash;</Text>}
                          >
                            {(site) => (
                              <Show
                                when={webLink(site())}
                                fallback={<Text class="break-all">{site()}</Text>}
                              >
                                {/* The site, not the address: the link still goes to all of it,
                                    and the full address is one hover away. */}
                                {(href) => (
                                  <Link href={href()} external title={href()} class="truncate">
                                    {siteLabel(site())}
                                  </Link>
                                )}
                              </Show>
                            )}
                          </Show>
                        </div>
                        <div class="flex flex-col gap-1">
                          <Text variant="label">{t('projects.notes')}</Text>
                          <Show
                            when={project().notes}
                            fallback={<Text variant="muted">{t('projects.noNotes')}</Text>}
                          >
                            {(notes) => (
                              <Text class="break-words whitespace-pre-wrap">{notes()}</Text>
                            )}
                          </Show>
                        </div>
                      </div>
                      {/* The tags as they are, and one button that opens the list to pick from,
                          with a checkmark on each this project has — not a text field. */}
                      <div class="flex flex-col gap-2">
                        <div class="flex items-center justify-between gap-2">
                          <Text variant="label">{t('projects.tags')}</Text>
                          <Popover
                            label={t('projects.chooseTags')}
                            placement="bottom-end"
                            onOpenChange={(open) => open && void loadLibraryTags()}
                            trigger={({ trigger }) => (
                              <button
                                type="button"
                                aria-label={t('projects.chooseTags')}
                                title={t('projects.chooseTags')}
                                class={buttonClass('ghost', 'sm', true)}
                                {...trigger}
                              >
                                <TagsIcon class="size-4" aria-hidden="true" />
                              </button>
                            )}
                          >
                            <div class="flex min-h-0 flex-col p-3">
                              <CheckList
                                label={t('projects.tags')}
                                searchLabel={t('projects.findOrAddTag')}
                                emptyText={t('projects.noTags')}
                                noMatchText={t('projects.noTagMatches')}
                                options={tagOptions()}
                                value={tags()}
                                onChange={(next) => void onTagsChange(next)}
                                createLabel={(name) => t('common.createTag', { name })}
                                maxLength={TAG_MAX_LENGTH}
                                autofocus
                              />
                            </div>
                          </Popover>
                        </div>
                        <Show
                          when={tags().length > 0}
                          fallback={<Text variant="muted">{t('projects.noProjectTags')}</Text>}
                        >
                          <div class="flex flex-wrap gap-1.5">
                            <For each={tags()}>{(tag) => <Tag>{tag}</Tag>}</For>
                          </div>
                        </Show>
                      </div>
                    </Card>

                    <section class="flex flex-col gap-4" aria-labelledby="files-heading">
                      <div class="flex flex-wrap items-center justify-between gap-3">
                        <div class="flex items-center gap-2">
                          <Heading level={3}>
                            <span id="files-heading">{t('projects.files')}</span>
                          </Heading>
                          <Badge class="tabular-nums">{project().files.length}</Badge>
                        </div>
                        <div class="flex flex-wrap items-center gap-2">
                          {/* Which product a launch uses. "Automatic" is what most launches
                              want: the shell applies its own rule and says which it picked. */}
                          <Show
                            when={slicerLaunch.available() && slicerLaunch.options().length > 0}
                          >
                            <Select
                              aria-label={t('projects.slicerChoice')}
                              value={slicerLaunch.chosen() ?? ''}
                              onChange={(value) =>
                                slicerLaunch.setChosen(
                                  slicerLaunch.options().find((option) => option.value === value)
                                    ?.value ?? null,
                                )
                              }
                              options={[
                                { value: '', label: t('projects.slicerAutomatic') },
                                ...slicerLaunch.options(),
                              ]}
                            />
                          </Show>
                          <ToolToggleGroup
                            label={t('projects.filesView')}
                            value={viewMode()}
                            onChange={setFilesViewMode}
                            options={[
                              {
                                value: 'grid',
                                label: t('projects.viewModeGrid'),
                                icon: LayoutGrid,
                              },
                              { value: 'list', label: t('projects.viewModeList'), icon: ListIcon },
                            ]}
                          />
                          <FilePickButton
                            label={
                              project().state === 'missing'
                                ? t('projects.uploadMissingFolder')
                                : t('projects.addFiles')
                            }
                            disabled={project().state === 'missing'}
                            onFiles={(files) => uploads.add(files)}
                          />
                        </div>
                      </div>

                      <Show when={uploads.items().length > 0}>
                        <ul
                          class="m-0 flex list-none flex-col gap-2 p-0"
                          aria-label={t('projects.upload')}
                        >
                          <For each={uploads.items()}>
                            {(item) => (
                              <li>
                                <Card class="flex flex-col gap-2" padding="md">
                                  <div class="flex items-center justify-between gap-3">
                                    <Text class="truncate" as="span">
                                      {item.name}
                                    </Text>
                                    <Text variant="small" as="span">
                                      {formatBytes(item.size)}
                                    </Text>
                                  </div>
                                  <Show
                                    when={item.status !== 'failed'}
                                    fallback={
                                      <div class="flex items-center justify-between gap-3">
                                        <Text variant="danger" as="span">
                                          {item.error}
                                        </Text>
                                        <Button size="sm" onClick={() => uploads.retry(item.id)}>
                                          {t('common.retry')}
                                        </Button>
                                      </div>
                                    }
                                  >
                                    <Progress
                                      label={t('projects.uploadProgress', { name: item.name })}
                                      value={item.status === 'queued' ? 0 : item.progress}
                                    />
                                    <Text variant="small" as="span">
                                      {item.status === 'queued'
                                        ? t('projects.uploadQueued')
                                        : item.status === 'done'
                                          ? t('projects.uploadDone')
                                          : `${Math.round(item.progress * 100)}%`}
                                    </Text>
                                  </Show>
                                </Card>
                              </li>
                            )}
                          </For>
                        </ul>
                        <div>
                          <Button variant="ghost" size="sm" onClick={() => uploads.clearFinished()}>
                            {t('projects.uploadClear')}
                          </Button>
                        </div>
                      </Show>

                      <Show
                        when={project().files.length > 0}
                        fallback={
                          <EmptyState
                            icon={FileBox}
                            title={t('projects.noFiles')}
                            description={t('projects.noFilesHint')}
                          />
                        }
                      >
                        <ul class={listClass()}>
                          <For each={project().files}>
                            {(file) => fileCard(file, project().state === 'missing')}
                          </For>
                        </ul>
                      </Show>
                    </section>

                    <ProjectFormDialog
                      open={editing()}
                      onOpenChange={setEditing}
                      title={t('projects.edit')}
                      submitLabel={t('projects.save')}
                      initial={{
                        name: project().name,
                        website: project().website ?? '',
                        notes: project().notes ?? '',
                      }}
                      onSubmit={async (values) => {
                        await detail.updateStrict({
                          name: values.name,
                          website: values.website === '' ? null : values.website,
                          notes: values.notes.trim() === '' ? null : values.notes,
                        })
                        // The name is on the card behind this panel.
                        props.onChanged?.()
                      }}
                    />
                  </>
                )}
              </Show>
            </Show>
          </div>
        </div>
      </DropTarget>

      {/* Waits for the project, so a link to a preview does not flash "not in this project". */}
      <FilePreview
        open={Boolean(props.previewFileId) && detail.detail() !== undefined}
        file={detail.detail()?.files.find((file) => file.id === props.previewFileId)}
        folderMissing={detail.detail()?.state === 'missing'}
        onClose={() => props.onPreview?.(null)}
        actions={fileActions}
      />

      <Dialog
        open={deleting()}
        onOpenChange={setDeleting}
        size="sm"
        title={t('projects.deleteTitle')}
        description={
          deleteFiles() ? t('projects.confirmDeleteWithFiles') : t('projects.confirmDelete')
        }
        closeLabel={t('common.close')}
        footer={
          <>
            <Button variant="secondary" onClick={() => setDeleting(false)}>
              {t('common.cancel')}
            </Button>
            <Button variant="danger" loading={deleteBusy()} onClick={() => void onDeleteProject()}>
              {t('projects.confirmDeleteAction')}
            </Button>
          </>
        }
      >
        <div class="py-2">
          <Checkbox
            label={t('projects.deleteFiles')}
            checked={deleteFiles()}
            onChange={setDeleteFiles}
          />
        </div>
      </Dialog>

      <Dialog
        open={renaming() !== null}
        onOpenChange={(open) => !open && setRenaming(null)}
        size="sm"
        title={t('projects.renameFileTitle')}
        closeLabel={t('common.close')}
        footer={
          <>
            <Button variant="secondary" onClick={() => setRenaming(null)}>
              {t('common.cancel')}
            </Button>
            <Button variant="primary" loading={renameBusy()} onClick={() => void onRename()}>
              {t('projects.save')}
            </Button>
          </>
        }
      >
        <form
          class="py-1"
          onSubmit={(event) => {
            event.preventDefault()
            void onRename()
          }}
        >
          <FormField label={t('projects.newName')} error={renameError()}>
            <Input
              autofocus
              value={renameDraft()}
              onInput={(event) => setRenameDraft(event.currentTarget.value)}
            />
          </FormField>
        </form>
      </Dialog>

      {/* Cura never saves back over the file it was given, and the app can neither cause that nor
          fix it. A notice with a way past it, not a gate: Cura against a file is perfectly useful
          for viewing and slicing. What is launched is what was warned about. */}
      <Dialog
        open={slicerLaunch.pending() !== null}
        onOpenChange={(open) => !open && slicerLaunch.cancelCura()}
        size="sm"
        title={t('projects.curaHazardTitle')}
        description={t('projects.curaHazard')}
        closeLabel={t('common.close')}
        footer={
          <>
            <Button variant="secondary" onClick={slicerLaunch.cancelCura}>
              {t('common.cancel')}
            </Button>
            <Button variant="primary" onClick={() => void slicerLaunch.continueCura()}>
              {t('projects.curaHazardContinue')}
            </Button>
          </>
        }
      >
        <div class="py-2">
          <Checkbox
            label={t('projects.curaHazardDontShow')}
            checked={slicerLaunch.dontShowAgain()}
            onChange={slicerLaunch.setDontShowAgain}
          />
        </div>
      </Dialog>

      <ConfirmDialog
        open={deletingFile() !== null}
        onOpenChange={(open) => !open && setDeletingFile(null)}
        title={t('projects.confirmDeleteFileTitle')}
        message={t('projects.confirmDeleteFile', { name: deletingFile()?.name ?? '' })}
        confirmLabel={t('projects.confirmDeleteAction')}
        cancelLabel={t('common.cancel')}
        danger
        loading={fileDeleteBusy()}
        onConfirm={() => void onDeleteFile()}
      />
    </div>
  )
}
