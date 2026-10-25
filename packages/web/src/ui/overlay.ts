import { createEffect, createSignal, onCleanup } from 'solid-js'

/**
 * Who is drawing over the page right now.
 *
 * **Why this exists.** The desktop app's model browser is a *native* webview laid over the page,
 * not an element in it: it paints above everything the page draws, whatever the z-index. A dialog
 * or a menu opened while it is showing would open *under* it, invisible and unreachable. So every
 * component that raises a layer over the page (Dialog, Drawer, Menu, MultiSelect) claims an
 * overlay while it is open, and the browse page hides its native view for as long as any claim is
 * held. Hiding costs the user nothing (the page keeps its place); the claim is released when the
 * layer closes, or when the component that held it goes away.
 *
 * What is **not** covered, on purpose: a tooltip (it only appears on hover, beside the control that
 * owns it), a native `<select>` popup (the operating system draws it above the webviews), and a
 * toast (the browse page reports in place instead of with toasts, since a toast over the view
 * would hide the view for its whole duration).
 */
const [claims, setClaims] = createSignal(0)

/** Whether any layer is open over the page. Reactive. */
export function overlayOpen(): boolean {
  return claims() > 0
}

/** Holds one claim while `open()` is true. Call it in a component, beside the layer's own state. */
export function createOverlayClaim(open: () => boolean): void {
  createEffect(() => {
    if (!open()) return
    setClaims((count) => count + 1)
    onCleanup(() => setClaims((count) => Math.max(0, count - 1)))
  })
}
