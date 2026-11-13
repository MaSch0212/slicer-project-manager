import { createSignal, lazy, Match, Show, Suspense, Switch, type JSX } from 'solid-js'
import type { FileDto } from '../api/generated'
import { formatBytes } from '../core/format-bytes'
import { t } from '../core/i18n'
import { fileKindKey } from '../core/project-detail'
import { slicerDisplayName } from '../core/slicer-names'
import {
  Badge,
  FileBox,
  IconButton,
  MediaDialog,
  MediaFallback,
  MediaLoading,
  RotateCcw,
  Text,
  type BadgeVariant,
} from '../ui'
import { judgeFile, SUPPORTED_FORMATS } from '../viewer/model-kind'

// three.js lives in this chunk and nowhere else: it loads the first time a model is previewed.
const ModelPreview = lazy(() => import('./viewer'))

const KIND_VARIANT: Record<FileDto['kind'], BadgeVariant> = {
  model: 'neutral',
  slicer_project: 'accent',
  other: 'neutral',
}

/**
 * One file, in a popup over the project: a 3D model on a stage you can turn, anything else as the
 * picture there is of it (or its kind) with what can be done with it laid out underneath. Every
 * file opens one — a file with no preview still has actions, and the card is where you meet it.
 *
 * `actions` draws those actions for this file, as icons in the header (`compact`) or as labelled
 * buttons under the picture; the detail page owns them, because it owns what they do.
 */
export function FilePreview(props: {
  open: boolean
  /** The file, or undefined while its project loads or once it is gone from it. */
  file: FileDto | undefined
  /** The project's folder is missing: nothing in it can be fetched. */
  folderMissing: boolean
  onClose: () => void
  actions: (file: FileDto, compact: boolean) => JSX.Element
}) {
  const [reset, setReset] = createSignal<(() => void) | null>(null)
  const viewable = (file: FileDto) => !props.folderMissing && judgeFile(file).status === 'viewable'

  /** Why a file has no 3D view, said for the popup, where its actions are right there. */
  const reason = (file: FileDto): string => {
    if (props.folderMissing) return t('viewer.missingFolder')
    const verdict = judgeFile(file)
    switch (verdict.status) {
      case 'step':
        return t('viewer.step')
      case 'slicerProject':
        return t('viewer.slicerProject')
      case 'unsupported':
        return file.kind === 'other'
          ? t('viewer.other')
          : t('viewer.unsupported', {
              extension: verdict.extension,
              formats: SUPPORTED_FORMATS.join(', '),
            })
      default:
        return ''
    }
  }

  return (
    <MediaDialog
      open={props.open}
      onOpenChange={(open) => !open && props.onClose()}
      title={props.file?.name ?? t('viewer.title')}
      closeLabel={t('common.close')}
      meta={
        <Show when={props.file}>
          {(file) => (
            <>
              <Badge variant={KIND_VARIANT[file().kind]}>{t(fileKindKey(file().kind))}</Badge>
              <Show when={file().slicer}>
                {(slicer) => <Badge>{slicerDisplayName(slicer())}</Badge>}
              </Show>
              <span>{formatBytes(file().sizeBytes)}</span>
            </>
          )}
        </Show>
      }
      actions={
        <Show when={props.file && viewable(props.file) ? props.file : undefined}>
          {(file) => (
            <>
              <Show when={reset()}>
                {(action) => (
                  <IconButton
                    icon={RotateCcw}
                    label={t('viewer.resetView')}
                    onClick={() => action()()}
                  />
                )}
              </Show>
              {props.actions(file(), true)}
            </>
          )}
        </Show>
      }
    >
      <Switch>
        <Match when={!props.file}>
          <div class="flex flex-1 items-center justify-center p-6">
            <Text variant="muted">{t('viewer.missingFile')}</Text>
          </div>
        </Match>
        <Match when={props.file && viewable(props.file) ? props.file : undefined}>
          {(file) => (
            <Suspense fallback={<MediaLoading label={t('viewer.loading')} />}>
              <ModelPreview file={file()} onReset={(action) => setReset(() => action)} />
            </Suspense>
          )}
        </Match>
        <Match when={props.file}>
          {(file) => (
            <MediaFallback
              src={
                !props.folderMissing && file().previewState === 'ready'
                  ? file().thumbUrl
                  : undefined
              }
              alt={t('viewer.thumbnailAlt', { name: file().name })}
              icon={FileBox}
              message={reason(file())}
              actions={props.actions(file(), false)}
            />
          )}
        </Match>
      </Switch>
    </MediaDialog>
  )
}
