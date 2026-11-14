import { createEffect, createSignal, Match, on, onCleanup, Show, Switch } from 'solid-js'
import { formatBytes } from '../core/format-bytes'
import { extensionOfName } from '../core/grouping'
import { t } from '../core/i18n'
import {
  decodeText,
  fetchHead,
  HIGHLIGHT_MAX_CHARS,
  lineCount,
  TEXT_MAX_BYTES,
  TextFetchError,
} from '../core/read-text'
import { CodeView, FileText, MediaLoading, PreviewMessage, PreviewNotice } from '../ui'
import { highlight, languageOf } from '../viewer/highlight'

type TextState =
  | { status: 'loading' }
  | { status: 'failed'; missing: boolean }
  | { status: 'binary' }
  | { status: 'ready'; html: string; lines: number; truncated: boolean; plain: boolean }

/**
 * A text file in the preview: JSON, XML, G-code, a slicer's configuration, a note — highlighted
 * where its kind has a grammar, with line numbers. A lazy chunk (the highlighter is in it).
 *
 * Either fetched (`url`: only the first two megabytes are read) or handed over as bytes (an entry
 * of an archive, already extracted).
 */
export default function TextPreview(props: { name: string; url?: string; bytes?: Uint8Array }) {
  const [state, setState] = createSignal<TextState>({ status: 'loading' })

  function show(bytes: Uint8Array, truncated: boolean) {
    const { text, binary } = decodeText(bytes)
    if (binary) {
      setState({ status: 'binary' })
      return
    }
    const extension = extensionOfName(props.name)
    const plain = text.length > HIGHLIGHT_MAX_CHARS
    const html = plain ? highlight(text, '') : highlight(text, extension)
    setState({
      status: 'ready',
      html,
      lines: lineCount(text),
      truncated,
      plain: plain && languageOf(extension) !== undefined,
    })
  }

  createEffect(
    on(
      () => [props.url, props.bytes, props.name] as const,
      ([url, bytes]) => {
        setState({ status: 'loading' })
        if (bytes) {
          const truncated = bytes.byteLength > TEXT_MAX_BYTES
          show(truncated ? bytes.subarray(0, TEXT_MAX_BYTES) : bytes, truncated)
          return
        }
        if (!url) return
        const controller = new AbortController()
        onCleanup(() => controller.abort())
        fetchHead(url, TEXT_MAX_BYTES, controller.signal)
          .then(({ bytes: head, truncated }) => {
            if (!controller.signal.aborted) show(head, truncated)
          })
          .catch((error: unknown) => {
            if (controller.signal.aborted) return
            setState({
              status: 'failed',
              missing: error instanceof TextFetchError && error.missing,
            })
          })
      },
    ),
  )

  return (
    <Switch>
      <Match when={state().status === 'loading'}>
        <MediaLoading label={t('viewer.loading')} />
      </Match>
      <Match when={state().status === 'failed' ? state() : undefined}>
        {(failed) => (
          <PreviewMessage icon={FileText}>
            {(failed() as { missing: boolean }).missing
              ? t('viewer.missingFile')
              : t('viewer.textFailed')}
          </PreviewMessage>
        )}
      </Match>
      <Match when={state().status === 'binary'}>
        <PreviewMessage icon={FileText}>{t('viewer.binary')}</PreviewMessage>
      </Match>
      <Match
        when={
          state().status === 'ready'
            ? (state() as Extract<TextState, { status: 'ready' }>)
            : undefined
        }
      >
        {(ready) => (
          <div class="flex min-h-0 flex-1 flex-col">
            <Show when={ready().truncated || ready().plain}>
              <PreviewNotice>
                {ready().truncated
                  ? t('viewer.textTruncated', { size: formatBytes(TEXT_MAX_BYTES) })
                  : t('viewer.textPlain')}
              </PreviewNotice>
            </Show>
            <CodeView
              html={ready().html}
              lines={ready().lines}
              label={t('viewer.textLabel', { name: props.name })}
            />
          </div>
        )}
      </Match>
    </Switch>
  )
}
