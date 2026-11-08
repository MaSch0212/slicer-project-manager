import { createSignal, type JSX } from 'solid-js'
import { cx } from './cx'

/** Arrow keys move the splitter this far; with Shift, four times as far. */
export const SPLITTER_KEY_STEP = 16

/**
 * The bar between two panes, which resizes one of them.
 *
 * Drag it, or focus it and use the arrow keys (Home and End for the smallest and largest). It is
 * a `separator` with the ARIA value triple, so a screen reader reads it as what it is and the
 * keyboard path is not an afterthought: a pointer-only splitter is a pane whose size some people
 * simply cannot change.
 *
 * `value` is the resized pane's width in pixels and `grows` says which direction widens it.
 */
export function Splitter(props: {
  label: string
  value: number
  min: number
  max: number
  /** `left`: dragging left widens the pane, which therefore sits to the right of the bar. */
  grows: 'left' | 'right'
  onChange: (width: number) => void
}) {
  const [dragging, setDragging] = createSignal(false)
  const clamp = (width: number) => Math.round(Math.min(props.max, Math.max(props.min, width)))
  const sign = () => (props.grows === 'left' ? -1 : 1)

  function onPointerDown(event: PointerEvent) {
    if (event.button !== 0) return
    event.preventDefault()
    const bar = event.currentTarget as HTMLElement
    bar.setPointerCapture(event.pointerId)
    bar.focus({ preventScroll: true })
    const startX = event.clientX
    const start = props.value
    setDragging(true)
    const move = (moved: PointerEvent) =>
      props.onChange(clamp(start + (moved.clientX - startX) * sign()))
    const end = () => {
      setDragging(false)
      bar.removeEventListener('pointermove', move)
      bar.removeEventListener('pointerup', end)
      bar.removeEventListener('pointercancel', end)
    }
    bar.addEventListener('pointermove', move)
    bar.addEventListener('pointerup', end)
    bar.addEventListener('pointercancel', end)
  }

  function onKeyDown(event: KeyboardEvent) {
    const step = event.shiftKey ? SPLITTER_KEY_STEP * 4 : SPLITTER_KEY_STEP
    let next: number | null = null
    if (event.key === 'ArrowLeft') next = props.value - step * sign()
    else if (event.key === 'ArrowRight') next = props.value + step * sign()
    else if (event.key === 'Home') next = props.min
    else if (event.key === 'End') next = props.max
    if (next === null) return
    event.preventDefault()
    props.onChange(clamp(next))
  }

  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label={props.label}
      aria-valuenow={props.value}
      aria-valuemin={props.min}
      aria-valuemax={props.max}
      tabindex="0"
      onPointerDown={onPointerDown}
      onKeyDown={onKeyDown}
      class={cx(
        'relative w-1 shrink-0 cursor-col-resize transition-colors hover:bg-accent focus-visible:bg-accent focus-visible:outline-none',
        dragging() ? 'bg-accent' : 'bg-border',
      )}
    >
      {/* A one-pixel line is a one-pixel target: the grab area reaches either side of it. */}
      <span class="absolute inset-y-0 -left-1 -right-1" aria-hidden="true" />
    </div>
  )
}

/**
 * The column a splitter resizes: the project detail beside the list.
 *
 * The width is an inline custom property because it is a number that changes as the user drags,
 * which is the one thing a class cannot express. It lives here rather than in the page so that
 * the page still sets no styling of its own.
 */
export function SplitPane(props: { label: string; width: number; children: JSX.Element }) {
  return (
    <aside
      aria-label={props.label}
      class="relative min-h-0 w-full shrink-0 overflow-y-auto border-l border-border md:w-(--pane-width)"
      style={{ '--pane-width': `${props.width}px` }}
    >
      {props.children}
    </aside>
  )
}
