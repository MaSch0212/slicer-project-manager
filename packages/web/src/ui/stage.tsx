import { Show, type JSX } from 'solid-js'
import { cx } from './cx'

/**
 * The frame a 3D view draws into: a themed, bordered, rounded box that fills its width and most of
 * the viewport's height. The canvas is created by the viewer and appended to `ref`; it is made to
 * cover the stage here, so no page ever sizes a canvas. `overlay` is centred on top (a progress
 * bar, a message), and the stage takes keyboard focus when `focusable` so a model can be orbited
 * without a mouse.
 */
export function Stage(props: {
  ref?: (element: HTMLDivElement) => void
  overlay?: JSX.Element
  focusable?: boolean
  label?: string
  onKeyDown?: (event: KeyboardEvent) => void
  class?: string
}) {
  return (
    <div
      class={cx(
        'relative h-[60dvh] min-h-72 w-full overflow-hidden rounded-card border border-border bg-surface-2 sm:h-[70dvh]',
        props.class,
      )}
    >
      <div
        ref={props.ref}
        role={props.focusable ? 'img' : undefined}
        aria-label={props.focusable ? props.label : undefined}
        tabindex={props.focusable ? 0 : undefined}
        onKeyDown={props.onKeyDown}
        class="absolute inset-0 touch-none [&>canvas]:block [&>canvas]:size-full"
      />
      <Show when={props.overlay}>
        <div class="absolute inset-0 flex items-center justify-center p-6">{props.overlay}</div>
      </Show>
    </div>
  )
}
