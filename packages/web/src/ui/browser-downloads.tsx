import { For, Show, type JSX } from 'solid-js'
import { cx } from './cx'
import { AlertTriangle, ChevronDown, Download, X } from './icons'
import { Progress } from './progress'

/**
 * One line of the download tray: a file on its way, a file waiting to be filed, or something the
 * app has to say about one. `detail` and `title` may be a stranger's strings, so the caller
 * bounds them; this only draws them.
 */
export type DownloadItem = {
  id: string
  title: string
  detail: string
  kind: 'running' | 'waiting' | 'problem'
  /** `undefined` while nothing is known about the total, which under WebView2 is always. */
  progress?: number
  /** The control that files it, for one waiting, or makes room, for a refusal. */
  action?: JSX.Element
  /** The accessible name of the control that gets rid of it. */
  dismissLabel: string
  onDismiss: () => void
}

/**
 * The control at the end of the address row: there only while the browser has something to say.
 *
 * It names the newest thing and counts the rest, and pressing it opens the tray below. A count
 * of one is not drawn — a badge saying "1" beside the thing it is counting is noise.
 */
export function DownloadChip(props: {
  label: string
  summary: string
  count: number
  problem: boolean
  open: boolean
  onToggle: () => void
}) {
  return (
    <button
      type="button"
      aria-label={props.label}
      aria-expanded={props.open}
      onClick={() => props.onToggle()}
      class={cx(
        'flex h-7 max-w-56 shrink-0 items-center gap-2 rounded-control border px-2 text-xs transition-colors',
        props.problem
          ? 'border-danger-solid bg-danger-soft text-danger-text'
          : 'border-border bg-surface-2 text-fg-muted hover:text-fg',
      )}
    >
      <Show
        when={props.problem}
        fallback={<Download class="size-3.5 shrink-0" aria-hidden="true" />}
      >
        <AlertTriangle class="size-3.5 shrink-0" aria-hidden="true" />
      </Show>
      <span class="truncate">{props.summary}</span>
      <Show when={props.count > 1}>
        <span class="shrink-0 rounded-full bg-accent-solid px-1.5 text-accent-fg">
          {props.count}
        </span>
      </Show>
      <ChevronDown
        class={cx('size-3 shrink-0 transition-transform', props.open && 'rotate-180')}
        aria-hidden="true"
      />
    </button>
  )
}

/**
 * The list the chip opens, under the address row.
 *
 * **In the page's flow, not floating over it.** A popover would be drawn under the native view
 * the way every other layer is, and would need the view hidden and replaced by a picture for the
 * sake of a three-line list. Pushing the view down instead costs it a few pixels, which it
 * reports like any other change of its rectangle.
 */
export function DownloadTray(props: { label: string; items: readonly DownloadItem[] }) {
  return (
    <ul
      aria-label={props.label}
      class="m-0 flex max-h-44 shrink-0 list-none flex-col gap-1 overflow-y-auto border-b border-border bg-surface px-2 py-2"
    >
      <For each={props.items}>
        {(item) => (
          <li class="flex items-center gap-3 rounded-control px-2 py-1.5">
            <div class="flex min-w-0 flex-1 flex-col gap-1">
              <span
                class={cx(
                  'truncate text-sm',
                  item.kind === 'problem' ? 'text-danger-text' : 'text-fg',
                )}
              >
                {item.title}
              </span>
              <span class="truncate text-xs text-fg-muted">{item.detail}</span>
              <Show when={item.kind === 'running'}>
                <Progress label={item.title} value={item.progress} />
              </Show>
            </div>
            <Show when={item.action}>
              <div class="shrink-0">{item.action}</div>
            </Show>
            <button
              type="button"
              aria-label={item.dismissLabel}
              onClick={() => item.onDismiss()}
              class="flex size-6 shrink-0 items-center justify-center rounded-control text-fg-muted transition-colors hover:bg-surface-2 hover:text-fg"
            >
              <X class="size-3.5" aria-hidden="true" />
            </button>
          </li>
        )}
      </For>
    </ul>
  )
}

/**
 * The picture that stands in for the native view while a dialog is over it.
 *
 * The view is a sibling of the page and paints above everything it draws, so a modal can only be
 * seen once the view is hidden — and hiding it alone leaves a hole where the site was. This is
 * the hole filled with what was there a moment ago. `object-top` and `object-cover` keep the top
 * of the page where the eye left it when the rectangle is not exactly the picture's shape.
 */
export function ViewStill(props: { src: string; label: string }) {
  return (
    <img
      src={props.src}
      alt={props.label}
      class="size-full object-cover object-top select-none"
      draggable={false}
    />
  )
}
