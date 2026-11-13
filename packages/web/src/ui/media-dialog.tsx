import { Dialog as KDialog } from '@kobalte/core/dialog'
import { Show, type JSX } from 'solid-js'
import { Dynamic } from 'solid-js/web'
import { createFocusReturn, overlayClass } from './dialog'
import { X, type IconComponent } from './icons'
import { createOverlayClaim } from './overlay'
import { Spinner } from './spinner'

/**
 * A large popup for looking at one thing: a file's 3D preview, or what there is to see of a file
 * that has none. The page behind stays where it was, so closing it is just closing it.
 *
 * The header holds the name, a line of facts and the file's actions; the body is the rest of the
 * popup, for the caller to fill (a stage that wants every pixel, or a picture with words under).
 */
export function MediaDialog(props: {
  open: boolean
  onOpenChange: (open: boolean) => void
  title: string
  /** Badges and the size, under the title. */
  meta?: JSX.Element
  /** Icon buttons for what can be done with it. */
  actions?: JSX.Element
  closeLabel: string
  children: JSX.Element
}) {
  const returnFocus = createFocusReturn(() => props.open)
  createOverlayClaim(() => props.open)
  return (
    <KDialog open={props.open} onOpenChange={props.onOpenChange} modal>
      <KDialog.Portal>
        <KDialog.Overlay class={overlayClass} />
        <div class="fixed inset-0 z-50 flex items-stretch justify-center sm:items-center sm:p-6">
          <KDialog.Content
            onCloseAutoFocus={returnFocus}
            class="flex h-dvh w-full flex-col overflow-hidden border-border bg-surface text-fg shadow-popover animate-pop sm:h-[min(88dvh,56rem)] sm:max-w-6xl sm:rounded-card sm:border"
          >
            <header class="flex min-h-14 shrink-0 items-center gap-3 border-b border-border py-2 pr-2 pl-4">
              <div class="flex min-w-0 flex-1 flex-col gap-1">
                <KDialog.Title class="truncate text-base font-semibold tracking-tight">
                  {props.title}
                </KDialog.Title>
                <Show when={props.meta}>
                  <div class="flex flex-wrap items-center gap-1.5 text-xs text-fg-muted">
                    {props.meta}
                  </div>
                </Show>
              </div>
              <Show when={props.actions}>
                <div class="flex shrink-0 items-center gap-0.5">{props.actions}</div>
              </Show>
              <div class="mx-1 h-5 border-l border-border" aria-hidden="true" />
              <KDialog.CloseButton
                class="inline-flex size-9 shrink-0 items-center justify-center rounded-control text-fg-muted transition-colors hover:bg-surface-2 hover:text-fg"
                aria-label={props.closeLabel}
              >
                <X class="size-4" aria-hidden="true" />
              </KDialog.CloseButton>
            </header>
            <div class="flex min-h-0 flex-1 flex-col">{props.children}</div>
          </KDialog.Content>
        </div>
      </KDialog.Portal>
    </KDialog>
  )
}

/** The popup's body while its stage is still being fetched: the stage's colour, and a spinner. */
export function MediaLoading(props: { label: string }) {
  return (
    <div class="flex flex-1 items-center justify-center bg-stage">
      <Spinner label={props.label} />
    </div>
  )
}

/**
 * The popup's body for a file with no 3D view: the picture there is of it — a slicer's own
 * thumbnail — or a large icon of its kind, then why there is no view and what can be done with it.
 */
export function MediaFallback(props: {
  src?: string
  alt: string
  icon: IconComponent
  message: JSX.Element
  actions: JSX.Element
}) {
  return (
    <div class="flex min-h-0 flex-1 flex-col items-center gap-5 overflow-y-auto p-6">
      <div class="flex min-h-48 w-full max-w-xl flex-1 items-center justify-center">
        <Show
          when={props.src}
          fallback={
            <Dynamic
              component={props.icon}
              class="size-16 text-fg-subtle"
              stroke-width={1.25}
              aria-hidden="true"
            />
          }
        >
          {(src) => (
            <img src={src()} alt={props.alt} class="max-h-full max-w-full object-contain" />
          )}
        </Show>
      </div>
      <div class="flex max-w-xl flex-col items-center gap-4 text-center">
        <p class="text-sm text-fg-muted">{props.message}</p>
        <div class="flex flex-wrap justify-center gap-2">{props.actions}</div>
      </div>
    </div>
  )
}
