import {
  createEffect,
  createMemo,
  createSignal,
  lazy,
  Match,
  on,
  onCleanup,
  Show,
  Suspense,
  Switch,
} from 'solid-js'
import type { FileDto } from '../api/generated'
import { formatBytes } from '../core/format-bytes'
import { t } from '../core/i18n'
import { entryKindOf, imageMime } from '../core/preview-kind'
import {
  Button,
  FileArchive,
  FileBox,
  FileCode,
  FileImage,
  FileText,
  FileTree,
  ImageView,
  MediaLoading,
  PreviewMessage,
  PreviewNotice,
  PreviewSplit,
  Progress,
  type TreeNode,
} from '../ui'
import { entryTree, initiallyOpen, listEntries, readEntry } from '../viewer/archive'
import { fetchModel, ModelLoadError } from '../viewer/fetch-bytes'

const TextPreview = lazy(() => import('./text-preview'))

/** Above this an archive is downloaded only when asked: it is read whole, in memory. */
export const ARCHIVE_ASK_BYTES = 256 * 1024 * 1024

type ArchiveState =
  | { status: 'loading'; progress: number | null }
  | { status: 'oversized' }
  | { status: 'failed'; missing: boolean }
  | { status: 'ready'; bytes: Uint8Array; tree: TreeNode[]; open: string[]; count: number }

type Picked =
  | { kind: 'text'; node: TreeNode; bytes: Uint8Array }
  | { kind: 'image'; node: TreeNode; url: string }
  | { kind: 'none'; node: TreeNode }

/**
 * A zip in the preview: what is in it, as a tree of folders and files with their sizes, and the
 * picked file shown beside it when it is text or a picture. A lazy chunk.
 *
 * The archive has to be downloaded whole to be read (the server serves files in one piece), so
 * a very large one asks first.
 */
export default function ArchivePreview(props: { file: FileDto }) {
  const [state, setState] = createSignal<ArchiveState>({ status: 'loading', progress: null })
  const [picked, setPicked] = createSignal<Picked | null>(null)

  function release(current: Picked | null) {
    if (current?.kind === 'image') URL.revokeObjectURL(current.url)
  }
  onCleanup(() => release(picked()))

  let controller: AbortController | undefined
  onCleanup(() => controller?.abort())

  async function load(confirmed: boolean) {
    controller?.abort()
    release(picked())
    setPicked(null)
    const file = props.file
    if (!confirmed && file.sizeBytes > ARCHIVE_ASK_BYTES) {
      setState({ status: 'oversized' })
      return
    }
    const mine = new AbortController()
    controller = mine
    setState({ status: 'loading', progress: null })
    try {
      const buffer = await fetchModel(file.rawUrl, file.sizeBytes, mine.signal, (progress) => {
        if (!mine.signal.aborted) setState({ status: 'loading', progress })
      })
      if (mine.signal.aborted) return
      const bytes = new Uint8Array(buffer)
      const entries = listEntries(bytes)
      const tree = entryTree(entries)
      setState({ status: 'ready', bytes, tree, open: initiallyOpen(tree), count: entries.length })
    } catch (error) {
      if (mine.signal.aborted) return
      setState({
        status: 'failed',
        missing: error instanceof ModelLoadError && error.reason === 'missing',
      })
    }
  }

  createEffect(
    on(
      () => props.file.id,
      () => void load(false),
    ),
  )

  const ready = createMemo(() => {
    const current = state()
    return current.status === 'ready' ? current : undefined
  })

  function pick(node: TreeNode) {
    const archive = ready()
    if (!archive) return
    release(picked())
    const kind = entryKindOf(node.name)
    const bytes =
      kind === 'none' || kind === 'archive' ? undefined : readEntry(archive.bytes, node.path)
    if (!bytes || kind === 'none' || kind === 'archive') {
      setPicked({ kind: 'none', node })
    } else if (kind === 'image') {
      const blob = new Blob([bytes as BlobPart], { type: imageMime(node.name) })
      setPicked({ kind: 'image', node, url: URL.createObjectURL(blob) })
    } else {
      setPicked({ kind: 'text', node, bytes })
    }
  }

  const iconOf = (node: TreeNode) => {
    switch (entryKindOf(node.name)) {
      case 'image':
        return FileImage
      case 'text':
        return FileCode
      case 'archive':
        return FileArchive
      default:
        return /\.(stl|obj|3mf|step|stp)$/i.test(node.name) ? FileBox : FileText
    }
  }

  return (
    <Switch>
      <Match when={state().status === 'loading' ? state() : undefined}>
        {(loading) => (
          <div class="flex flex-1 flex-col items-center justify-center gap-3 p-6">
            <Show
              when={(loading() as { progress: number | null }).progress}
              fallback={<MediaLoading label={t('viewer.loading')} />}
            >
              {(progress) => (
                <div class="w-full max-w-sm">
                  <Progress label={t('viewer.downloading')} value={progress()} />
                </div>
              )}
            </Show>
          </div>
        )}
      </Match>
      <Match when={state().status === 'oversized'}>
        <PreviewMessage
          icon={FileArchive}
          action={<Button onClick={() => void load(true)}>{t('viewer.archiveLoadAnyway')}</Button>}
        >
          {t('viewer.archiveLarge', { size: formatBytes(props.file.sizeBytes) })}
        </PreviewMessage>
      </Match>
      <Match when={state().status === 'failed' ? state() : undefined}>
        {(failed) => (
          <PreviewMessage icon={FileArchive}>
            {(failed() as { missing: boolean }).missing
              ? t('viewer.missingFile')
              : t('viewer.archiveFailed')}
          </PreviewMessage>
        )}
      </Match>
      <Match when={ready()}>
        {(archive) => (
          <Show
            when={archive().count > 0}
            fallback={
              <PreviewMessage icon={FileArchive}>{t('viewer.archiveEmpty')}</PreviewMessage>
            }
          >
            <PreviewSplit
              side={
                <FileTree
                  label={t('viewer.archiveContents')}
                  nodes={archive().tree}
                  initiallyOpen={archive().open}
                  selected={picked()?.node.path ?? null}
                  onSelect={pick}
                  canOpen={() => true}
                  iconOf={iconOf}
                  formatSize={formatBytes}
                />
              }
            >
              <Switch
                fallback={
                  <PreviewMessage icon={FileArchive}>
                    {t('viewer.archiveSummary', {
                      count: archive().count,
                      size: formatBytes(archive().tree.reduce((sum, node) => sum + node.size, 0)),
                    })}
                  </PreviewMessage>
                }
              >
                <Match when={picked()?.kind === 'text' ? picked() : undefined}>
                  {(text) => (
                    <div class="flex min-h-0 flex-1 flex-col">
                      <PreviewNotice>{text().node.path}</PreviewNotice>
                      <Suspense fallback={<MediaLoading label={t('viewer.loading')} />}>
                        <TextPreview
                          name={text().node.name}
                          bytes={(text() as Extract<Picked, { kind: 'text' }>).bytes}
                        />
                      </Suspense>
                    </div>
                  )}
                </Match>
                <Match when={picked()?.kind === 'image' ? picked() : undefined}>
                  {(image) => (
                    <div class="flex min-h-0 flex-1 flex-col">
                      <PreviewNotice>{image().node.path}</PreviewNotice>
                      <ImageView
                        src={(image() as Extract<Picked, { kind: 'image' }>).url}
                        alt={image().node.name}
                      />
                    </div>
                  )}
                </Match>
                <Match when={picked()?.kind === 'none' ? picked() : undefined}>
                  {(other) => (
                    <PreviewMessage icon={iconOf(other().node)}>
                      {t('viewer.entryNoPreview', {
                        name: other().node.name,
                        size: formatBytes(other().node.size),
                      })}
                    </PreviewMessage>
                  )}
                </Match>
              </Switch>
            </PreviewSplit>
          </Show>
        )}
      </Match>
    </Switch>
  )
}
