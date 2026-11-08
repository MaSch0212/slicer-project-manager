import { Show, type JSX } from 'solid-js'
import { Dynamic } from 'solid-js/web'
import { cx } from './cx'
import type { TriggerProps } from './menu'
import { ChevronDown, Copy, Minus, Square, X, type IconComponent } from './icons'

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
 * One of the small square controls in the title bar: an app action, or the way to settings.
 *
 * Not an `IconButton`: these sit inside the caption and have to be the bar's own height, with no
 * rounding of their own, so that the row reads as one surface.
 */
export function TitleBarButton(props: {
  icon: IconComponent
  label: string
  current?: boolean
  expanded?: boolean
  onClick?: () => void
  /** A menu primitive's own trigger props, when this button is one. Spread last. */
  trigger?: TriggerProps
}) {
  return (
    <button
      type="button"
      aria-label={props.label}
      title={props.label}
      aria-current={props.current ? 'page' : undefined}
      onClick={() => props.onClick?.()}
      class={cx(
        'inline-flex h-full w-10 shrink-0 items-center justify-center transition-colors hover:bg-surface-2 hover:text-fg focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent',
        props.current || props.expanded ? 'bg-surface-2 text-fg' : 'text-fg-muted',
      )}
      {...props.trigger}
    >
      <Dynamic component={props.icon} class="size-4" aria-hidden="true" />
    </button>
  )
}

/**
 * The mark, the app's name and the arrow that says there is a menu behind them.
 *
 * It is the left end of the caption, so it is the bar's full height with no rounding of its own.
 */
export function WindowBarBrand(props: {
  name: string
  label: string
  expanded?: boolean
  /** The app menu's own trigger props. Spread last. */
  trigger?: TriggerProps
}) {
  return (
    <button
      type="button"
      aria-label={props.label}
      class={cx(
        'flex h-full shrink-0 items-center gap-2 pr-2 pl-2.5 transition-colors hover:bg-surface-2 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent',
        props.expanded && 'bg-surface-2',
      )}
      {...props.trigger}
    >
      <AppLogo />
      <span class="text-xs font-semibold tracking-tight text-fg">{props.name}</span>
      <ChevronDown class="size-3 text-fg-muted" aria-hidden="true" />
    </button>
  )
}

/**
 * The window's own title bar, drawn by the page because the window has no system decorations.
 *
 * **The empty space is the caption.** Pressing it hands the window to the system's drag loop,
 * and a double-click maximises or restores — both through commands, so Windows does the moving
 * and drag-to-snap, the shake gesture and the monitor edges behave as they always did. The
 * resize border is still the window's own and is not drawn here.
 *
 * The three window buttons are out of the tab order, as native caption buttons are: Win+arrow
 * and Alt+F4 are still their keys, and a keyboard user tabbing through the app should reach the
 * app's own controls, not the frame's.
 */
export function WindowBar(props: {
  /** The mark, the name and (where there is one) the app menu they open. */
  brand: JSX.Element
  /** App actions, immediately after the brand. */
  tools?: JSX.Element
  /** Anything at the right end, before the window buttons. */
  trailing?: JSX.Element
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
}) {
  const onCaptionPointerDown = (event: MouseEvent) => {
    if (event.button !== 0) return
    // Only the bar's own empty space is the caption: a press that started on a control inside it
    // belongs to that control.
    if (event.target !== event.currentTarget) return
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
    <header class="z-40 flex h-9 shrink-0 items-stretch border-b border-border bg-surface">
      {props.brand}
      <Show when={props.tools}>
        <div class="flex shrink-0 items-stretch">{props.tools}</div>
      </Show>
      <div class="min-w-8 flex-1 cursor-default select-none" onMouseDown={onCaptionPointerDown} />
      <Show when={props.trailing}>
        <div class="flex shrink-0 items-stretch">{props.trailing}</div>
      </Show>
      <span class="my-2 w-px shrink-0 bg-border" aria-hidden="true" />
      <div class="flex shrink-0 items-stretch">
        <button
          type="button"
          tabIndex={-1}
          class={control}
          aria-label={props.labels.minimize}
          title={props.labels.minimize}
          onClick={() => props.onMinimize()}
        >
          <Minus class="size-4" aria-hidden="true" />
        </button>
        <button
          type="button"
          tabIndex={-1}
          class={control}
          aria-label={props.isMaximized ? props.labels.restore : props.labels.maximize}
          title={props.isMaximized ? props.labels.restore : props.labels.maximize}
          onClick={() => props.onToggleMaximize()}
        >
          <Show when={props.isMaximized} fallback={<Square class="size-3.5" aria-hidden="true" />}>
            <Copy class="size-3.5 -scale-x-100" aria-hidden="true" />
          </Show>
        </button>
        <button
          type="button"
          tabIndex={-1}
          class={cx(control, 'hover:bg-danger-solid hover:text-danger-fg')}
          aria-label={props.labels.close}
          title={props.labels.close}
          onClick={() => props.onClose()}
        >
          <X class="size-4" aria-hidden="true" />
        </button>
      </div>
    </header>
  )
}
