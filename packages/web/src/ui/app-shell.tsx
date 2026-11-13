import { Dialog as KDialog } from '@kobalte/core/dialog'
import { Tooltip as KTooltip } from '@kobalte/core/tooltip'
import { A } from '@solidjs/router'
import { Show, type JSX } from 'solid-js'
import { Dynamic, Portal } from 'solid-js/web'
import { createFocusReturn, overlayClass } from './dialog'
import { createOverlayClaim } from './overlay'
import { cx } from './cx'
import { X, type IconComponent } from './icons'
import { tooltipClass } from './tooltip'
import { AppLogo } from './window-bar'

/**
 * The frame of the signed-in app: an optional sidebar from `md` up, a top bar below it, and the
 * routed page in a centred column. Without a `sidebar` (the login page, a shell with nowhere to
 * go) it draws no chrome at all, only the column.
 */
export function AppShell(props: {
  sidebar?: JSX.Element
  /**
   * The window's own title bar, in the desktop app. It is the first row of the shell, above the
   * sidebar and outside everything that scrolls. In a browser there is no window to frame.
   */
  topBar?: JSX.Element
  /**
   * The route wants the whole frame: no centred column, no padding, and the page is exactly as
   * tall as what is left. The model browser needs it, because the native view it is a
   * placeholder for should run to the window's edges.
   */
  fullBleed?: boolean
  /** The app's name, shown in the phone top bar. */
  title: string
  /** The phone top bar's leading control, normally the button that opens the drawer. */
  menuButton?: JSX.Element
  children: JSX.Element
}) {
  return (
    /*
     * One screenful, and the page scrolls *inside* it.
     *
     * Not the document: with the window bar sticky inside a scrolling document the scrollbar ran
     * the full height of the window and up past the bar, which is not something a desktop
     * window does. Here the bar and the sidebar are outside the scroll container and only the
     * content moves, so the scrollbar belongs to the content and starts under the bar.
     */
    <div class="flex h-dvh flex-col overflow-hidden">
      <Show when={props.topBar}>{props.topBar}</Show>
      <div class="flex min-h-0 flex-1 flex-col md:flex-row">
        <Show when={props.sidebar}>{props.sidebar}</Show>
        <div class="flex min-w-0 min-h-0 flex-1 flex-col">
          <header class="flex h-14 shrink-0 items-center gap-2 border-b border-border bg-surface px-3 md:hidden">
            {props.menuButton}
            <span class="px-1 text-sm font-semibold tracking-tight text-fg">{props.title}</span>
          </header>
          <main
            class={cx(
              // `relative`: see the note in the projects list for what an absolutely positioned
              // `sr-only` line does to the document without it.
              'relative flex min-h-0 w-full min-w-0 flex-1 flex-col',
              props.fullBleed ? undefined : 'overflow-y-auto',
            )}
          >
            <Show
              when={props.fullBleed}
              fallback={
                <div class="mx-auto w-full max-w-6xl px-4 py-6 md:px-8 md:py-8">
                  {props.children}
                </div>
              }
            >
              {props.children}
            </Show>
          </main>
        </div>
      </div>
    </div>
  )
}

/** The brand: a mark and the app's name. The name is hidden (but still read) when collapsed. */
export function Brand(props: { name: string; href: string; collapsed?: boolean }) {
  return (
    <A href={props.href} class="flex h-9 items-center gap-2.5 rounded-control px-1.5">
      <AppLogo class="size-7" />
      <span
        class={cx(
          'truncate text-sm font-semibold tracking-tight text-fg',
          props.collapsed && 'sr-only',
        )}
      >
        {props.name}
      </span>
    </A>
  )
}

/**
 * The permanent sidebar, from `md` up. `collapsed` shrinks it to icons.
 *
 * Two layers, on purpose: the `<aside>` is the column. It stretches to the full height of the
 * shell (so its background and border run to the foot of a long page, however tall) and carries
 * the width. The panel inside is what stays put: it is exactly one viewport tall and sticks to the
 * top, so the brand, entries and footer are always in reach while the page scrolls.
 */
export function Sidebar(props: {
  label: string
  collapsed?: boolean
  /**
   * The mark and the app's name at the head of the column. Absent in the desktop app, where the
   * window bar above already carries both and a second copy was the thing that made the window
   * look like a web page.
   */
  brand?: JSX.Element
  children: JSX.Element
  footer?: JSX.Element
}) {
  return (
    <aside
      class={cx(
        'hidden min-h-0 shrink-0 flex-col border-r border-border bg-surface transition-[width] md:flex',
        props.collapsed ? 'w-16' : 'w-60',
      )}
    >
      <div class="flex min-h-0 flex-1 flex-col gap-4 p-3">
        <Show when={props.brand}>{props.brand}</Show>
        <nav aria-label={props.label} class="flex-1 overflow-y-auto">
          {props.children}
        </nav>
        <Show when={props.footer}>
          <div class={cx('flex gap-1', props.collapsed ? 'flex-col items-center' : 'items-center')}>
            {props.footer}
          </div>
        </Show>
      </div>
    </aside>
  )
}

export function NavList(props: { children: JSX.Element }) {
  return <ul class="flex list-none flex-col gap-0.5 p-0">{props.children}</ul>
}

/** The look of one row in the sidebar, shared by the fixed entries and the saved views. */
export const navItemClass =
  'flex h-9 w-full items-center gap-3 rounded-control px-2.5 text-sm font-medium text-fg-muted transition-colors hover:bg-surface-2 hover:text-fg aria-[current=page]:bg-accent-soft aria-[current=page]:text-accent-soft-fg'

/**
 * A heading over a group of sidebar rows, with room for one control at its right end. Hidden
 * (but still read) when the sidebar is collapsed to icons, where there is no width for words.
 */
export function NavHeading(props: {
  children: JSX.Element
  collapsed?: boolean
  action?: JSX.Element
}) {
  return (
    <div
      class={cx(
        'flex h-7 items-center gap-1 pr-0.5 pl-2.5',
        props.collapsed && 'justify-center pr-0 pl-0',
      )}
    >
      <h2
        class={cx(
          'flex-1 truncate text-xs font-medium tracking-wide text-fg-muted uppercase',
          props.collapsed && 'sr-only',
        )}
      >
        {props.children}
      </h2>
      <Show when={props.action}>{props.action}</Show>
    </div>
  )
}

/**
 * One navigation entry: a link when it has an `href`, a button when it does something instead
 * (sign out). When `collapsed` the label is visually hidden but still the accessible name, and a
 * tooltip carries it for sighted users.
 */
export function NavItem(props: {
  label: string
  icon: IconComponent
  href?: string
  onClick?: () => void
  collapsed?: boolean
}) {
  const content = (
    <>
      <Dynamic component={props.icon} class="size-4 shrink-0" aria-hidden="true" />
      <span class={cx('truncate', props.collapsed && 'sr-only')}>{props.label}</span>
    </>
  )
  const control = () =>
    props.href ? (
      <A href={props.href} class={navItemClass}>
        {content}
      </A>
    ) : (
      <button type="button" class={navItemClass} onClick={() => props.onClick?.()}>
        {content}
      </button>
    )
  return (
    <li>
      <Show when={props.collapsed} fallback={control()}>
        <KTooltip placement="right" openDelay={200} gutter={8}>
          <KTooltip.Trigger as="div" class="flex">
            {control()}
          </KTooltip.Trigger>
          <Portal>
            <KTooltip.Content class={tooltipClass}>{props.label}</KTooltip.Content>
          </Portal>
        </KTooltip>
      </Show>
    </li>
  )
}

/** A modal panel from the left edge: the phone's version of the sidebar. */
export function Drawer(props: {
  open: boolean
  onOpenChange: (open: boolean) => void
  title: string
  closeLabel: string
  children: JSX.Element
}) {
  const returnFocus = createFocusReturn(() => props.open)
  createOverlayClaim(() => props.open)
  return (
    <KDialog open={props.open} onOpenChange={props.onOpenChange} modal>
      <KDialog.Portal>
        <KDialog.Overlay class={overlayClass} />
        <KDialog.Content
          onCloseAutoFocus={returnFocus}
          class="fixed inset-y-0 left-0 z-50 flex w-72 max-w-[85vw] flex-col gap-4 border-r border-border bg-surface p-3 text-fg shadow-popover"
        >
          <div class="flex items-center justify-between">
            <KDialog.Title class="px-1.5 text-sm font-semibold tracking-tight">
              {props.title}
            </KDialog.Title>
            <KDialog.CloseButton
              aria-label={props.closeLabel}
              class="inline-flex size-8 items-center justify-center rounded-control text-fg-muted transition-colors hover:bg-surface-2 hover:text-fg"
            >
              <X class="size-4" aria-hidden="true" />
            </KDialog.CloseButton>
          </div>
          <div class="flex flex-1 flex-col gap-4 overflow-y-auto">{props.children}</div>
        </KDialog.Content>
      </KDialog.Portal>
    </KDialog>
  )
}
