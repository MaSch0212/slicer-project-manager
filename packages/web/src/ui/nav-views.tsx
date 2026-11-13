import { Tooltip as KTooltip } from '@kobalte/core/tooltip'
import { createSignal, For, Show } from 'solid-js'
import { Dynamic, Portal } from 'solid-js/web'
import { navItemClass } from './app-shell'
import { buttonClass } from './button'
import { cx } from './cx'
import {
  Archive,
  Box,
  Clock,
  Layers,
  MoreHorizontal,
  Printer,
  Search,
  TagIcon,
  type IconComponent,
} from './icons'
import { MenuTrigger, type MenuEntry } from './menu'
import { tooltipClass } from './tooltip'

/**
 * The icon each stored name draws. The names themselves are `core/views.ts`'s list — this is the
 * one place that turns one into a picture, so the stored value stays a name and never a
 * component. A name this build does not know draws the first icon rather than nothing.
 */
const VIEW_ICON_COMPONENTS: Record<string, IconComponent> = {
  layers: Layers,
  archive: Archive,
  tag: TagIcon,
  printer: Printer,
  box: Box,
  clock: Clock,
  search: Search,
}

export function viewIcon(name: string): IconComponent {
  return VIEW_ICON_COMPONENTS[name] ?? Layers
}

/** Whether this build can draw an icon by that name. Used by the test that keeps the two in step. */
export function hasViewIcon(name: string): boolean {
  return name in VIEW_ICON_COMPONENTS
}

/**
 * One saved view in the sidebar: the icon, the name, and the mark that it is the one the list is
 * showing. Its actions are one menu, reachable two ways — the button at the right end, which
 * appears on hover or focus, and a right-click anywhere along the row, which is how a desktop
 * application's lists have always worked.
 */
export function NavViewItem(props: {
  label: string
  icon: IconComponent
  active?: boolean
  collapsed?: boolean
  onClick: () => void
  menu?: { label: string; items: readonly MenuEntry[] }
}) {
  const [menuOpen, setMenuOpen] = createSignal(false)
  const hasMenu = () => Boolean(props.menu) && !props.collapsed
  const row = () => (
    <button
      type="button"
      class={cx(navItemClass, hasMenu() && 'pr-9')}
      aria-current={props.active ? 'page' : undefined}
      onClick={() => props.onClick()}
      onContextMenu={(event) => {
        if (!hasMenu()) return
        event.preventDefault()
        setMenuOpen(true)
      }}
    >
      <Dynamic component={props.icon} class="size-4 shrink-0" aria-hidden="true" />
      <span class={cx('truncate', props.collapsed && 'sr-only')}>{props.label}</span>
    </button>
  )
  return (
    <li class="group relative">
      <Show when={props.collapsed} fallback={row()}>
        <KTooltip placement="right" openDelay={200} gutter={8}>
          <KTooltip.Trigger as="div" class="flex">
            {row()}
          </KTooltip.Trigger>
          <Portal>
            <KTooltip.Content class={tooltipClass}>{props.label}</KTooltip.Content>
          </Portal>
        </KTooltip>
      </Show>
      <Show when={hasMenu() ? props.menu : undefined}>
        {(menu) => (
          <div
            class={cx(
              'absolute top-0.5 right-0.5 flex',
              // Out of the way until wanted, but never out of reach: focus inside the row brings
              // it back, so the keyboard has the same two steps as the mouse.
              !menuOpen() &&
                'pointer-events-none opacity-0 group-focus-within:pointer-events-auto group-focus-within:opacity-100 group-hover:pointer-events-auto group-hover:opacity-100',
            )}
          >
            <MenuTrigger
              label={menu().label}
              items={menu().items}
              placement="bottom-end"
              open={menuOpen()}
              onOpenChange={setMenuOpen}
            >
              {({ trigger }) => (
                <button
                  type="button"
                  aria-label={menu().label}
                  class={buttonClass('ghost', 'sm', true)}
                  {...trigger}
                >
                  <MoreHorizontal class="size-4" aria-hidden="true" />
                </button>
              )}
            </MenuTrigger>
          </div>
        )}
      </Show>
    </li>
  )
}

/** Picks one icon for a view: a radio group drawn as the icons themselves. */
export function ViewIconPicker(props: {
  label: string
  icons: readonly string[]
  /** The name of each icon, for the control's accessible name. */
  nameOf: (icon: string) => string
  value: string
  onChange: (icon: string) => void
}) {
  return (
    <div role="radiogroup" aria-label={props.label} class="flex flex-wrap gap-1.5">
      <For each={props.icons}>
        {(icon) => {
          const selected = () => props.value === icon
          return (
            <button
              type="button"
              role="radio"
              aria-checked={selected()}
              aria-label={props.nameOf(icon)}
              tabIndex={selected() ? 0 : -1}
              onClick={() => props.onChange(icon)}
              class={cx(
                'inline-flex size-9 items-center justify-center rounded-control border transition-colors',
                selected()
                  ? 'border-accent bg-accent-soft text-accent-soft-fg'
                  : 'border-border text-fg-muted hover:bg-surface-2 hover:text-fg',
              )}
            >
              <Dynamic component={viewIcon(icon)} class="size-4" aria-hidden="true" />
            </button>
          )
        }}
      </For>
    </div>
  )
}
