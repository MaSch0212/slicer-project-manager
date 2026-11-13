import { createEffect, createSignal, Match, on, onCleanup, Show, Switch } from 'solid-js'
import type { FileDto } from '../api/generated'
import { formatBytes } from '../core/format-bytes'
import { t } from '../core/i18n'
import { Alert, Button, Progress, Stage, Text } from '../ui'
import { buildModel, fetchModel, ModelLoadError, type LoadFailure } from '../viewer/load-model'
import { judgeFile } from '../viewer/model-kind'
import { createModelViewer, NoWebGlError, type ModelViewer } from '../viewer/scene'

type ViewerState =
  | { status: 'loading'; progress: number | null }
  | { status: 'ready' }
  | { status: 'oversized'; extension: string; sizeBytes: number }
  | { status: 'failed'; reason: LoadFailure; extension: string }

/**
 * The interactive 3D stage for one model file, filling the preview popup. A lazy chunk: three.js
 * lives here and nowhere else, and it is loaded only once a file the viewer can draw is opened.
 *
 * Whether a file is a model at all is decided before this is ever mounted (see `judgeFile` and
 * the preview); what this decides is whether it is small enough to load without asking, and then
 * whether it loaded. `onReset` hands the page the "back to the opening view" action once there is
 * a model to reset, and takes it away again when there is not.
 */
export default function ModelPreview(props: {
  file: FileDto
  onReset?: (reset: (() => void) | null) => void
}) {
  const [state, setState] = createSignal<ViewerState>({ status: 'loading', progress: null })
  const [noWebGl, setNoWebGl] = createSignal(false)

  let host: HTMLDivElement | undefined
  let progressRegion: HTMLDivElement | undefined
  let viewer: ModelViewer | undefined
  let inFlight: AbortController | undefined
  // Identifies the load that may still write state: a superseded one (another file) is dropped.
  let token = 0

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
    props.onReset?.(null)
    setState({ status: 'loading', progress: null })

    const current = props.file
    const verdict = judgeFile(current)
    if (verdict.status !== 'viewable') return
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
      props.onReset?.(() => viewer?.resetView())
    } catch (error) {
      if (mine !== token) return
      const reason = error instanceof ModelLoadError ? error.reason : 'parse'
      setState({ status: 'failed', reason, extension })
    } finally {
      if (inFlight === controller) inFlight = undefined
    }
  }

  createEffect(on([() => props.file.id, () => props.file.sizeBytes], () => void load()))

  onCleanup(() => {
    token++
    inFlight?.abort()
    props.onReset?.(null)
    viewer?.dispose()
    viewer = undefined
  })

  const percent = () => {
    const current = state()
    return current.status === 'loading' && current.progress !== null
      ? Math.round(current.progress * 100)
      : null
  }
  const loadingLabel = () =>
    percent() === null ? t('viewer.loading') : t('viewer.loadingPercent', { percent: percent()! })

  const failure = (): string | null => {
    const current = state()
    if (current.status === 'oversized') {
      return t('viewer.tooLarge', {
        extension: current.extension,
        size: formatBytes(current.sizeBytes),
      })
    }
    if (current.status !== 'failed') return null
    switch (current.reason) {
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

  return (
    <Stage
      fill
      ref={(element) => (host = element)}
      focusable={state().status === 'ready'}
      label={t('viewer.canvasLabel')}
      onKeyDown={(event) => void viewer?.handleKey(event)}
      // One `Switch`, not a fragment of `Show`s: the stage decides whether to draw its overlay card
      // from what this resolves to, and a fragment of empty `Show`s is not nothing.
      overlay={
        <Switch>
          <Match when={noWebGl()}>
            <Alert variant="danger">{t('viewer.noWebgl')}</Alert>
          </Match>
          <Match when={state().status === 'loading'}>
            <div
              ref={(el) => (progressRegion = el)}
              tabindex="-1"
              role="status"
              class="flex w-full flex-col items-center gap-3"
            >
              <Progress
                class="max-w-xs"
                label={loadingLabel()}
                value={percent() === null ? undefined : percent()! / 100}
              />
              <Text variant="muted">{loadingLabel()}</Text>
            </div>
          </Match>
          <Match when={failure()}>
            {(text) => (
              <div class="flex flex-col items-start gap-3">
                <Alert variant={state().status === 'failed' ? 'danger' : 'warning'} class="w-full">
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
          </Match>
        </Switch>
      }
    />
  )
}
