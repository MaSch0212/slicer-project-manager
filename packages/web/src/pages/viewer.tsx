import { useParams } from '@solidjs/router'
import { createEffect, createMemo, createSignal, on, onCleanup, Show } from 'solid-js'
import { createProjectDetail } from '../core/project-detail'
import { t } from '../core/i18n'
import { formatBytes } from '../core/format-bytes'
import {
  Alert,
  Button,
  Download,
  LinkButton,
  PageHeader,
  Progress,
  RotateCcw,
  Stage,
  Text,
} from '../ui'
import { buildModel, fetchModel, ModelLoadError, type LoadFailure } from '../viewer/load-model'
import { judgeFile, SUPPORTED_FORMATS } from '../viewer/model-kind'
import { createModelViewer, NoWebGlError, type ModelViewer } from '../viewer/scene'

type ViewerState =
  | { status: 'loading'; progress: number | null }
  | { status: 'ready' }
  | { status: 'step' }
  | { status: 'slicerProject' }
  | { status: 'unsupported'; extension: string }
  | { status: 'oversized'; extension: string; sizeBytes: number }
  | { status: 'failed'; reason: LoadFailure | 'project'; extension: string }

/**
 * The interactive 3D viewer: `/projects/:id/view/:fileId`, a lazy chunk (three.js lives here and
 * nowhere else). It loads the project to find the file, decides from the file's name and kind what
 * can be done with it (see `judgeFile`), and only then touches WebGL: a STEP file, a slicer project
 * or an unknown format gets a clear message and no download, no renderer.
 */
export default function ViewerPage() {
  const params = useParams<{ id: string; fileId: string }>()
  const detail = createProjectDetail(() => params.id)
  const [state, setState] = createSignal<ViewerState>({ status: 'loading', progress: null })
  const [noWebGl, setNoWebGl] = createSignal(false)

  let host: HTMLDivElement | undefined
  let progressRegion: HTMLDivElement | undefined
  let viewer: ModelViewer | undefined
  let inFlight: AbortController | undefined
  // Identifies the load that may still write state: a superseded load (route change) is dropped.
  let token = 0

  const file = createMemo(() => detail.detail()?.files.find((f) => f.id === params.fileId))

  function ensureViewer(): ModelViewer | undefined {
    if (viewer) return viewer
    if (!host) return undefined
    try {
      viewer = createModelViewer(host)
    } catch (error) {
      if (!(error instanceof NoWebGlError)) throw error
      setNoWebGl(true)
      return undefined
    }
    viewer.onContextLost(() => setNoWebGl(true))
    return viewer
  }

  async function load(confirmed = false): Promise<void> {
    const mine = ++token
    inFlight?.abort()
    inFlight = undefined
    setState({ status: 'loading', progress: null })

    const current = file()
    if (!current) {
      // The project did not load at all, or loaded without this file.
      const missing = detail.detail() !== undefined
      setState({ status: 'failed', reason: missing ? 'missing' : 'project', extension: '' })
      return
    }
    const verdict = judgeFile(current)
    if (verdict.status === 'step') {
      setState({ status: 'step' })
      return
    }
    if (verdict.status === 'slicerProject') {
      setState({ status: 'slicerProject' })
      return
    }
    if (verdict.status === 'unsupported') {
      setState({ status: 'unsupported', extension: verdict.extension })
      return
    }
    const extension = current.name.slice(current.name.lastIndexOf('.'))
    if (!confirmed && current.sizeBytes > verdict.limitBytes) {
      setState({ status: 'oversized', extension, sizeBytes: current.sizeBytes })
      return
    }
    const scene = ensureViewer()
    if (!scene) return

    const controller = new AbortController()
    inFlight = controller
    try {
      const bytes = await fetchModel(
        current.rawUrl,
        current.sizeBytes,
        controller.signal,
        (progress) => {
          if (mine === token) setState({ status: 'loading', progress })
        },
      )
      if (mine !== token) return
      const model = buildModel(verdict.format, bytes)
      if (mine !== token) return
      scene.setModel(model)
      setState({ status: 'ready' })
    } catch (error) {
      if (mine !== token) return
      const reason = error instanceof ModelLoadError ? error.reason : 'parse'
      setState({ status: 'failed', reason, extension })
    } finally {
      if (inFlight === controller) inFlight = undefined
    }
  }

  // Load the project whenever the route's project changes, then (re)decide about the file once
  // that has settled. `loading` going false is the signal, so the first run waits for the fetch.
  createEffect(
    on(
      () => params.id,
      () => void detail.load(),
    ),
  )
  createEffect(
    on([() => detail.loading(), () => params.fileId], ([loading]) => {
      if (!loading) void load()
    }),
  )

  onCleanup(() => {
    token++
    inFlight?.abort()
    viewer?.dispose()
    viewer = undefined
  })

  const percent = () => {
    const current = state()
    return current.status === 'loading' && current.progress !== null
      ? Math.round(current.progress * 100)
      : null
  }
  const showsStage = () => {
    const status = state().status
    return !noWebGl() && (status === 'loading' || status === 'ready')
  }
  const loadingLabel = () =>
    percent() === null ? t('viewer.loading') : t('viewer.loadingPercent', { percent: percent()! })

  const message = (): string | null => {
    const current = state()
    switch (current.status) {
      case 'step':
        return t('viewer.step')
      case 'slicerProject':
        return t('viewer.slicerProject')
      case 'unsupported':
        return t('viewer.unsupported', {
          extension: current.extension,
          formats: SUPPORTED_FORMATS.join(', '),
        })
      case 'oversized':
        return t('viewer.tooLarge', {
          extension: current.extension,
          size: formatBytes(current.sizeBytes),
        })
      case 'failed':
        switch (current.reason) {
          case 'project':
            return detail.loadError() ?? t('viewer.fetchFailed')
          case 'missing':
            return t('viewer.missingFile')
          case 'fetch':
            return t('viewer.fetchFailed')
          case 'parse':
            return t('viewer.parseFailed', { extension: current.extension })
          case 'empty':
            return t('viewer.emptyModel')
        }
    }
    return null
  }
  // Nothing went wrong when the file simply is not a model this viewer opens.
  const messageVariant = () => (state().status === 'failed' ? 'danger' : 'warning')

  return (
    <div class="flex flex-col gap-4">
      <PageHeader
        title={file()?.name ?? t('viewer.title')}
        back={{ href: `/projects/${params.id}`, label: t('viewer.back') }}
        actions={
          <>
            <Show when={file()}>
              {(current) => (
                <LinkButton
                  href={current().rawUrl}
                  external
                  download={current().name}
                  icon={Download}
                >
                  {t('projects.download')}
                </LinkButton>
              )}
            </Show>
            <Show when={state().status === 'ready'}>
              <Button icon={RotateCcw} onClick={() => viewer?.resetView()}>
                {t('viewer.resetView')}
              </Button>
            </Show>
          </>
        }
      />

      <Show when={noWebGl()}>
        <Alert variant="danger">{t('viewer.noWebgl')}</Alert>
      </Show>

      <Show when={message()}>
        {(text) => (
          <div class="flex flex-col items-start gap-3">
            <Alert variant={messageVariant()} class="w-full">
              {text()}
            </Alert>
            <Show when={state().status === 'oversized'}>
              <Button
                variant="primary"
                onClick={() => {
                  void load(true)
                  // The button is about to disappear; keep focus on the status that replaces it.
                  queueMicrotask(() => progressRegion?.focus())
                }}
              >
                {t('viewer.loadAnyway')}
              </Button>
            </Show>
          </div>
        )}
      </Show>

      <Stage
        ref={(element) => (host = element)}
        class={showsStage() ? undefined : 'hidden'}
        focusable={state().status === 'ready'}
        label={t('viewer.canvasLabel')}
        onKeyDown={(event) => void viewer?.handleKey(event)}
        overlay={
          <Show when={state().status === 'loading'}>
            <div
              ref={(el) => (progressRegion = el)}
              tabindex="-1"
              role="status"
              class="flex w-full max-w-xs flex-col items-center gap-3"
            >
              <Progress
                class="max-w-xs"
                label={loadingLabel()}
                value={
                  state().status === 'loading' && percent() !== null ? percent()! / 100 : undefined
                }
              />
              <Text variant="muted">{loadingLabel()}</Text>
            </div>
          </Show>
        }
      />
    </div>
  )
}
