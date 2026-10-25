import { Dialog as KDialog } from '@kobalte/core/dialog'
import { createComputed, on, Show, type JSX } from 'solid-js'
import { Button } from './button'
import { cx } from './cx'
import { X } from './icons'

export type DialogSize = 'sm' | 'md' | 'lg'

const sizes: Record<DialogSize, string> = {
  sm: 'sm:max-w-sm',
  md: 'sm:max-w-md',
  lg: 'sm:max-w-2xl',
}

/** The shared overlay, so Dialog and Drawer dim the page identically. */
export const overlayClass = 'fixed inset-0 z-40 bg-overlay animate-fade'

/**
 * Puts focus back where it was when a controlled dialog closes. The primitive can only return it
 * to a trigger it owns, and these dialogs are opened by whatever the page likes (a button setting a
 * signal), so the element that had focus at the moment `open` turned true is remembered and focused
 * again on close. Pass the returned handler as the content's `onCloseAutoFocus`. When that element
 * is gone by then (a menu item that opened the dialog is unmounted with its menu) nothing is
 * focused, as before.
 *
 * Remembered in a computation, not an effect: it must run before the dialog mounts and moves focus
 * inside, while the opener still has it.
 */
export function createFocusReturn(open: () => boolean): (event: Event) => void {
  let opener: HTMLElement | null = null
  createComputed(
    on(open, (isOpen) => {
      if (isOpen)
        opener = document.activeElement instanceof HTMLElement ? document.activeElement : null
    }),
  )
  return (event) => {
    event.preventDefault()
    if (opener?.isConnected) opener.focus()
    opener = null
  }
}

/**
 * A modal dialog. Focus moves in on open, is trapped while open, and returns to whatever opened
 * it on close; Escape and the close button dismiss it. Controlled: the caller owns `open`.
 * On a phone it sits at the bottom edge as a sheet.
 */
export function Dialog(props: {
  open: boolean
  onOpenChange: (open: boolean) => void
  title: JSX.Element
  description?: JSX.Element
  /** The accessible name of the close button. */
  closeLabel?: string
  size?: DialogSize
  /** Buttons, right-aligned along the bottom. */
  footer?: JSX.Element
  children?: JSX.Element
}) {
  const returnFocus = createFocusReturn(() => props.open)
  return (
    <KDialog open={props.open} onOpenChange={props.onOpenChange} modal>
      <KDialog.Portal>
        <KDialog.Overlay class={overlayClass} />
        <div class="fixed inset-0 z-50 flex items-end justify-center sm:items-center sm:p-4">
          <KDialog.Content
            onCloseAutoFocus={returnFocus}
            class={cx(
              'flex max-h-[85dvh] w-full flex-col rounded-t-card border border-border bg-surface text-fg shadow-popover animate-pop sm:rounded-card',
              sizes[props.size ?? 'md'],
            )}
          >
            <div class="flex items-start gap-4 p-5 pb-3">
              <div class="flex flex-1 flex-col gap-1">
                <KDialog.Title class="text-base font-semibold tracking-tight">
                  {props.title}
                </KDialog.Title>
                <Show when={props.description}>
                  <KDialog.Description class="text-sm text-fg-muted">
                    {props.description}
                  </KDialog.Description>
                </Show>
              </div>
              <KDialog.CloseButton
                class="-mt-1 -mr-1 inline-flex size-8 items-center justify-center rounded-control text-fg-muted transition-colors hover:bg-surface-2 hover:text-fg"
                aria-label={props.closeLabel ?? 'Close'}
              >
                <X class="size-4" aria-hidden="true" />
              </KDialog.CloseButton>
            </div>
            <Show when={props.children}>
              <div class="flex-1 overflow-y-auto px-5 py-2">{props.children}</div>
            </Show>
            <Show when={props.footer}>
              <div class="flex flex-wrap justify-end gap-2 p-5 pt-4">{props.footer}</div>
            </Show>
          </KDialog.Content>
        </div>
      </KDialog.Portal>
    </KDialog>
  )
}

/** "Are you sure": a dialog with a cancel button and one confirming button. */
export function ConfirmDialog(props: {
  open: boolean
  onOpenChange: (open: boolean) => void
  title: JSX.Element
  message: JSX.Element
  confirmLabel: string
  cancelLabel: string
  /** Styles the confirming button as destructive. */
  danger?: boolean
  loading?: boolean
  onConfirm: () => void
}) {
  return (
    <Dialog
      open={props.open}
      onOpenChange={props.onOpenChange}
      title={props.title}
      description={props.message}
      size="sm"
      footer={
        <>
          <Button variant="secondary" onClick={() => props.onOpenChange(false)}>
            {props.cancelLabel}
          </Button>
          <Button
            variant={props.danger ? 'danger' : 'primary'}
            loading={props.loading}
            onClick={() => props.onConfirm()}
          >
            {props.confirmLabel}
          </Button>
        </>
      }
    />
  )
}
