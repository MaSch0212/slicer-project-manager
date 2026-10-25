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
  class?: string
  children?: JSX.Element
}) {
  return (
    <div
      ref={props.ref}
      role="region"
      aria-label={props.label}
      class={cx(
        'flex h-[60dvh] min-h-96 items-center justify-center rounded-card border border-border bg-surface-2 p-6 text-center text-sm text-fg-muted',
        props.class,
      )}
    >
      {props.children}
    </div>
  )
}
