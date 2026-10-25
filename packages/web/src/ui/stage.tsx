import { children, Show, type JSX } from 'solid-js'
import { cx } from './cx'

/**
 * The frame a 3D view draws into: a bordered, rounded box, dark in both themes (see `--color-stage`),
 * that fills its width and most of the viewport's height. The canvas is created by the viewer and appended to `ref`; it is made to
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
  // A `<Show>` passed as `overlay` is a truthy accessor even while it renders nothing, so what is
  // there is read through `children`: an empty layer and card would otherwise sit over the model.
  const overlay = children(() => props.overlay)
  return (
    <div
      class={cx(
        'relative h-[60dvh] min-h-72 w-full overflow-hidden rounded-card border border-border bg-stage sm:h-[70dvh]',
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
      {/*
        The layer is click-through: it covers the whole stage, and a layer that took the pointer
        would stop the model being dragged. Only what is drawn on it (a progress bar, a message)
        takes pointer events again, on a themed card: the stage itself is dark in both schemes, so
        text laid straight on it would not follow the theme.
      */}
      <Show when={overlay.toArray().length > 0}>
        <div class="pointer-events-none absolute inset-0 flex items-center justify-center p-6">
          <div class="pointer-events-auto w-full max-w-sm rounded-card border border-border bg-surface p-5 shadow-popover">
            {overlay()}
          </div>
        </div>
      </Show>
    </div>
  )
}
