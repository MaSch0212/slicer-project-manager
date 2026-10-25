import { Toast as KToast, toaster } from '@kobalte/core/toast'
import { Show } from 'solid-js'
import { Dynamic, Portal } from 'solid-js/web'
import { cx } from './cx'
import { CircleAlert, CircleCheck, Info, X, type IconComponent } from './icons'

export type ToastKind = 'success' | 'error' | 'info'

const kinds: Record<ToastKind, { icon: IconComponent; tint: string }> = {
  success: { icon: CircleCheck, tint: 'text-success-text' },
  error: { icon: CircleAlert, tint: 'text-danger-text' },
  info: { icon: Info, tint: 'text-accent-text' },
}

/** How long each kind stays: a failure is worth reading past the usual window. */
const DURATIONS: Record<ToastKind, number> = { success: 4000, info: 5000, error: 10000 }

/** Shows a toast. Prefer `notify` (core/notify.ts), which is this plus a calling convention. */
export function showToast(kind: ToastKind, message: string, closeLabel = 'Close'): number {
  const { icon, tint } = kinds[kind]
  return toaster.show((props) => (
    <KToast
      toastId={props.toastId}
      duration={DURATIONS[kind]}
      // Failures interrupt a screen reader; the rest wait their turn.
      role={kind === 'error' ? 'alert' : 'status'}
      aria-live={kind === 'error' ? 'assertive' : 'polite'}
      class="flex w-full items-start gap-3 rounded-popover border border-border bg-surface p-3 text-sm text-fg shadow-popover data-[opened]:animate-pop"
    >
      <Dynamic component={icon} class={cx('mt-0.5 size-4 shrink-0', tint)} aria-hidden="true" />
      <KToast.Description class="flex-1">{message}</KToast.Description>
      <Show when={kind === 'error'}>
        <KToast.CloseButton
          class="-mt-1 -mr-1 inline-flex size-6 items-center justify-center rounded-control text-fg-muted hover:bg-surface-2 hover:text-fg"
          aria-label={closeLabel}
        >
          <X class="size-4" aria-hidden="true" />
        </KToast.CloseButton>
      </Show>
    </KToast>
  ))
}

export function dismissAllToasts(): void {
  toaster.clear()
}

/** Mount once, near the root. Toasts stack at the bottom right (full width on a phone). */
export function ToastRegion(props: { label?: string }) {
  return (
    <Portal>
      <KToast.Region aria-label={props.label ? `${props.label} (F8)` : undefined} limit={4}>
        <KToast.List class="fixed right-0 bottom-0 z-[100] flex w-full max-w-sm list-none flex-col gap-2 p-4 outline-none" />
      </KToast.Region>
    </Portal>
  )
}
