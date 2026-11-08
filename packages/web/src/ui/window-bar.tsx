import { Show, type JSX } from 'solid-js'
import { cx } from './cx'
import { Copy, Minus, Square, X } from './icons'

/** The application's own mark — the artwork every icon this project ships is drawn from. */
export function AppLogo(props: { class?: string }) {
  return (
    <img
      src="/favicon.svg"
      alt=""
      aria-hidden="true"
      class={cx('size-5 shrink-0 select-none', props.class)}
    />
  )
}

const control =
  'inline-flex h-full w-12 shrink-0 items-center justify-center text-fg-muted transition-colors hover:bg-surface-2 hover:text-fg focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent'

/**
 * The window's own title bar, drawn by the page because the window has no system decorations.
 *
 * **The left part is the caption.** Pressing it hands the window to the system's drag loop, and a
 * double-click maximises or restores — both through commands, so Windows does the moving and
 * drag-to-snap, the shake gesture and the monitor edges behave as they always did. The resize
 * border is still the window's own and is not drawn here.
 *
 * `select-none` and the press handler are on the caption only: the three buttons are outside it,
 * so pressing one never starts a drag.
 */
export function WindowBar(props: {
  title: string
  isMaximized: boolean
  labels: {
    minimize: string
    maximize: string
    restore: string
    close: string
  }
  onDragStart: () => void
  onToggleMaximize: () => void
  onMinimize: () => void
  onClose: () => void
  /** Anything the bar should carry between the name and the window buttons. */
  children?: JSX.Element
}) {
  const onCaptionPointerDown = (event: MouseEvent) => {
    if (event.button !== 0) return
    // The second press of a double-click. Checked here rather than with a `dblclick` handler
    // because the first press has already started a drag by the time that would fire.
    if (event.detail === 2) {
      event.preventDefault()
      props.onToggleMaximize()
      return
    }
    event.preventDefault()
    props.onDragStart()
  }

  return (
    <header class="sticky top-0 z-40 flex h-9 shrink-0 items-stretch border-b border-border bg-surface">
      <div
        class="flex min-w-0 flex-1 cursor-default items-center gap-2.5 select-none"
        onMouseDown={onCaptionPointerDown}
      >
        <AppLogo class="ml-2.5" />
        <span class="truncate text-xs font-semibold tracking-tight text-fg">{props.title}</span>
        <Show when={props.children}>
          <div class="flex min-w-0 flex-1 items-center">{props.children}</div>
        </Show>
      </div>
      <div class="flex shrink-0 items-stretch">
        <button
          type="button"
          class={control}
          aria-label={props.labels.minimize}
          onClick={() => props.onMinimize()}
        >
          <Minus class="size-4" aria-hidden="true" />
        </button>
        <button
          type="button"
          class={control}
          aria-label={props.isMaximized ? props.labels.restore : props.labels.maximize}
          onClick={() => props.onToggleMaximize()}
        >
          <Show when={props.isMaximized} fallback={<Square class="size-3.5" aria-hidden="true" />}>
            <Copy class="size-3.5" aria-hidden="true" />
          </Show>
        </button>
        <button
          type="button"
          class={cx(control, 'hover:bg-danger-solid hover:text-danger-fg')}
          aria-label={props.labels.close}
          onClick={() => props.onClose()}
        >
          <X class="size-4" aria-hidden="true" />
        </button>
      </div>
    </header>
  )
}
