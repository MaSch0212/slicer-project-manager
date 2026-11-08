import type { JSX } from 'solid-js'
import { cx } from './cx'

/**
 * The empty rectangle a native view is laid over (the desktop app's model browser).
 *
 * The page measures this element and reports where it is; the shell positions a separate native
 * webview on top of it. What is *inside* is therefore only seen when nothing is on top (before the
 * view is attached, while it is hidden for a dialog), which is the right place for a "nothing is
 * open yet" sentence. It is a region with a name so a screen reader can tell where the site is.
 */
export function ViewportSlot(props: {
  ref?: (element: HTMLDivElement) => void
  label: string
  /** Takes whatever height is left instead of a fixed share of the viewport. */
  fill?: boolean
  /** No padding and no centring: what is inside fills it (the still picture of the view). */
  bare?: boolean
  class?: string
  children?: JSX.Element
}) {
  return (
    <div
      ref={props.ref}
      role="region"
      aria-label={props.label}
      class={cx(
        'flex bg-surface-2 text-sm text-fg-muted',
        props.bare ? 'overflow-hidden' : 'items-center justify-center p-6 text-center',
        props.fill ? 'min-h-0 flex-1' : 'h-[60dvh] min-h-96 rounded-card border border-border',
        props.class,
      )}
    >
      {props.children}
    </div>
  )
}
