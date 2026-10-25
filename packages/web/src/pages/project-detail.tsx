import { useNavigate, useParams } from '@solidjs/router'
import { createEffect, createSignal, For, on, onCleanup, Show } from 'solid-js'
import type { FileDto } from '../api/generated'
import { api } from '../core/api/client'
import { formatBytes } from '../core/format-bytes'
import { t } from '../core/i18n'
import {
  createProjectDetail,
  fileKindKey,
  isPreviewPending,
  previewStateKey,
  TAG_MAX_LENGTH,
  webLink,
} from '../core/project-detail'
import { slicerDisplayName } from '../core/slicer-names'
import { settings } from '../core/stores'
import { createUploadQueue } from '../core/upload-queue'
import { validateFileName } from '../core/validation'
import {
  Alert,
  AlertTriangle,
  Archive,
  ArchiveRestore,
  Badge,
  Button,
  Card,
  Checkbox,
  Clock,
  ConfirmDialog,
  Dialog,
  Download,
  DropZone,
  EmptyState,
  Eye,
  FileBox,
  FormField,
  Heading,
  IconLinkButton,
  ImageOff,
  Input,
  LayoutGrid,
  LinkButton,
  Link,
  List as ListIcon,
  MediaCard,
  Menu,
  PageHeader,
  Pencil,
  Progress,
  RefreshCw,
  SegmentedControl,
  Skeleton,
  TagInput,
  Text,
  Trash2,
  type BadgeVariant,
  type IconComponent,
} from '../ui'
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
export default function ProjectDetailPage() {
  const params = useParams<{ id: string }>()
  const navigate = useNavigate()
  const detail = createProjectDetail(() => params.id)

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

  const viewMode = () => settings.settings().viewMode

  const uploads = createUploadQueue({
    upload: (file, onProgress) =>
      api.files.uploadWithProgress(params.id, file.name, file, onProgress),
    onFileDone: () => void detail.load(),
  })

  // Follow the route: a different project starts from nothing.
  createEffect(
    on(
      () => params.id,
      () => {
        detail.reset()
        void detail.load()
      },
    ),
  )
  createEffect(() => setTags(detail.detail()?.tags ?? []))

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
    if (!(await detail.setTags(next))) setTags(detail.detail()?.tags ?? [])
  }

  async function onDeleteProject() {
    setDeleteBusy(true)
    try {
      if (await detail.deleteProject(deleteFiles())) navigate('/projects')
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
    } finally {
      setFileDeleteBusy(false)
      setDeletingFile(null)
    }
  }

  const listClass = () =>
    viewMode() === 'grid'
      ? 'm-0 grid list-none grid-cols-2 gap-4 p-0 sm:grid-cols-3 lg:grid-cols-4'
      : 'm-0 flex list-none flex-col gap-2 p-0'

  const fileCard = (file: FileDto, folderMissing: boolean) => (
    <li>
      <MediaCard
        layout={viewMode()}
        as="h3"
        title={file.name}
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
        actions={
          <>
            <Show when={file.kind === 'model'}>
              <IconLinkButton
                href={`/projects/${params.id}/view/${file.id}`}
                icon={Eye}
                label={`${t('projects.view')}: ${file.name}`}
                size="sm"
              />
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
                {
                  label: t('projects.rename'),
                  icon: Pencil,
                  onSelect: () => {
                    setRenameDraft(file.name)
                    setRenameError(undefined)
                    setRenaming(file)
                  },
                },
                { type: 'separator' },
                {
                  label: t('projects.deleteFile'),
                  icon: Trash2,
                  danger: true,
                  onSelect: () => setDeletingFile(file),
                },
              ]}
            />
          </>
        }
      />
    </li>
  )

  return (
    <div class="flex flex-col gap-6">
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
            <div class="flex flex-col gap-4" aria-busy="true" aria-label={t('common.loading')}>
              <Skeleton class="h-8 w-64" />
              <Skeleton class="h-32 w-full" />
              <Skeleton class="h-48 w-full" />
            </div>
          }
        >
          {(project) => (
            <>
              <PageHeader
                title={project().name}
                back={{ href: '/projects', label: t('projects.backToProjects') }}
                actions={
                  <>
                    <Button icon={Pencil} onClick={() => setEditing(true)}>
                      {t('projects.edit')}
                    </Button>
                    <Button
                      icon={project().isArchived ? ArchiveRestore : Archive}
                      onClick={() => void detail.update({ isArchived: !project().isArchived })}
                    >
                      {project().isArchived ? t('projects.unarchive') : t('projects.archive')}
                    </Button>
                    <Button
                      variant="danger"
                      icon={Trash2}
                      onClick={() => {
                        setDeleteFiles(false)
                        setDeleting(true)
                      }}
                    >
                      {t('projects.delete')}
                    </Button>
                  </>
                }
              />

              <Show when={project().isArchived}>
                <div class="-mt-3 flex flex-wrap gap-2">
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

              <Card class="flex flex-col gap-5" padding="lg">
                <div class="grid gap-5 sm:grid-cols-2">
                  <div class="flex flex-col gap-1">
                    <Text variant="label">{t('projects.website')}</Text>
                    <Show when={project().website} fallback={<Text variant="muted">&ndash;</Text>}>
                      {(site) => (
                        <Show
                          when={webLink(site())}
                          fallback={<Text class="break-all">{site()}</Text>}
                        >
                          {(href) => (
                            <Link href={href()} external class="break-all">
                              {site()}
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
                      {(notes) => <Text class="break-words whitespace-pre-wrap">{notes()}</Text>}
                    </Show>
                  </div>
                </div>
                <FormField label={t('projects.tags')} hint={t('projects.tagsHint')}>
                  <TagInput
                    label={t('projects.addTag')}
                    placeholder={t('projects.addTag')}
                    value={tags()}
                    onChange={(next) => void onTagsChange(next)}
                    maxLength={TAG_MAX_LENGTH}
                    removeLabel={(tag) => t('projects.removeTagNamed', { name: tag })}
                  />
                </FormField>
              </Card>

              <section class="flex flex-col gap-4" aria-labelledby="files-heading">
                <div class="flex flex-wrap items-center justify-between gap-3">
                  <div class="flex items-center gap-2">
                    <Heading level={2}>
                      <span id="files-heading">{t('projects.files')}</span>
                    </Heading>
                    <Badge class="tabular-nums">{project().files.length}</Badge>
                  </div>
                  <SegmentedControl
                    iconOnly
                    label={t('projects.filesView')}
                    value={viewMode()}
                    onChange={(mode) => void settings.patch({ viewMode: mode }).catch(() => {})}
                    options={[
                      { value: 'grid', label: t('projects.viewModeGrid'), icon: LayoutGrid },
                      { value: 'list', label: t('projects.viewModeList'), icon: ListIcon },
                    ]}
                  />
                </div>

                <DropZone
                  label={t('projects.uploadDrop')}
                  buttonLabel={t('projects.uploadChoose')}
                  hint={
                    project().state === 'missing'
                      ? t('projects.uploadMissingFolder')
                      : t('projects.uploadHint')
                  }
                  disabled={project().state === 'missing'}
                  onFiles={(files) => uploads.add(files)}
                />

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
                }}
              />
            </>
          )}
        </Show>
      </Show>

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
