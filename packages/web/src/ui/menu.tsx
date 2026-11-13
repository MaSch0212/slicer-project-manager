import { DropdownMenu } from '@kobalte/core/dropdown-menu'
import { createSignal, For, Show, type JSX } from 'solid-js'
import { Dynamic } from 'solid-js/web'
import { buttonClass, type ButtonVariant } from './button'
import { cx } from './cx'
import { Check, ChevronDown, MoreHorizontal, type IconComponent } from './icons'
import { createOverlayClaim } from './overlay'

/** What a primitive hands its trigger: press handling, the ARIA pair, and its positioning ref. */
export type TriggerProps = Record<string, unknown>

export type MenuEntry =
  | {
      type?: 'item'
      label: string
      icon?: IconComponent
      onSelect: () => void
      disabled?: boolean
      /** Colours the item as destructive. */
      danger?: boolean
      /** Marks the current choice in a menu of alternatives. */
      checked?: boolean
      /** A quiet word at the right end: where an entry comes from, or its shortcut. */
      hint?: string
    }
  | { type: 'separator' }

/**
 * A dropdown of actions. Either an icon-only trigger (`icon`, named by `label`) or a text trigger
 * (`label` shown, `variant` chosen). Arrow keys, typeahead, Escape and focus return come from the
 * underlying primitive.
 */
export function Menu(props: {
  /** The trigger's visible text, or its accessible name when `iconOnly`. */
  label: string
  items: readonly MenuEntry[]
  iconOnly?: boolean
  icon?: IconComponent
  variant?: ButtonVariant
  placement?: 'bottom-start' | 'bottom-end'
  children?: JSX.Element
}) {
  const [open, setOpen] = createSignal(false)
  createOverlayClaim(open)
  return (
    <DropdownMenu
      open={open()}
      onOpenChange={setOpen}
      placement={props.placement ?? 'bottom-end'}
      gutter={6}
    >
      <DropdownMenu.Trigger
        aria-label={props.iconOnly ? props.label : undefined}
        class={buttonClass(
          props.variant ?? (props.iconOnly ? 'ghost' : 'secondary'),
          'md',
          props.iconOnly,
        )}
      >
        <Show
          when={props.iconOnly}
          fallback={
            <>
              <Show when={props.icon}>
                <Dynamic component={props.icon} class="size-4" aria-hidden="true" />
              </Show>
              {props.label}
              <ChevronDown class="size-4 text-fg-muted" aria-hidden="true" />
            </>
          }
        >
          <Dynamic component={props.icon ?? MoreHorizontal} class="size-4" aria-hidden="true" />
        </Show>
      </DropdownMenu.Trigger>
      <MenuItems items={props.items} />
    </DropdownMenu>
  )
}

/** The panel and its entries, shared by every menu whatever draws its trigger. */
function MenuItems(props: { items: readonly MenuEntry[] }) {
  return (
    <DropdownMenu.Portal>
      <DropdownMenu.Content class="z-50 min-w-44 rounded-popover border border-border bg-surface p-1 text-fg shadow-popover animate-pop">
        <For each={props.items}>
          {(entry) =>
            entry.type === 'separator' ? (
              <DropdownMenu.Separator class="-mx-1 my-1 border-0 border-t border-border" />
            ) : (
              <DropdownMenu.Item
                disabled={entry.disabled}
                onSelect={entry.onSelect}
                class={cx(
                  'flex cursor-default items-center gap-2 rounded-control px-2 py-1.5 text-sm outline-none select-none data-[disabled]:opacity-50 data-[highlighted]:bg-surface-2',
                  entry.danger ? 'text-danger-text' : 'text-fg',
                )}
              >
                <Show when={entry.icon}>
                  <Dynamic component={entry.icon} class="size-4" aria-hidden="true" />
                </Show>
                <span class="flex-1">{entry.label}</span>
                <Show when={entry.hint}>
                  <span class="text-xs text-fg-muted">{entry.hint}</span>
                </Show>
                <Show when={entry.checked}>
                  <Check class="size-4 text-accent-text" aria-hidden="true" />
                </Show>
              </DropdownMenu.Item>
            )
          }
        </For>
      </DropdownMenu.Content>
    </DropdownMenu.Portal>
  )
}

/**
 * A menu whose trigger is drawn by the caller: the title bar's brand and its tool buttons are
 * part of the window frame and cannot be an ordinary button. The keyboard behaviour, the focus
 * return and the panel are the same as {@link Menu}'s.
 */
export function MenuTrigger(props: {
  label: string
  items: readonly MenuEntry[]
  placement?: 'bottom-start' | 'bottom-end'
  /**
   * Opens the menu from outside as well as from its own trigger: a sidebar row opens this one on
   * a right-click anywhere along it. The menu still positions itself against the trigger, so the
   * panel appears where pressing the trigger would have put it.
   */
  open?: boolean
  onOpenChange?: (open: boolean) => void
  /**
   * Draws the trigger. `trigger` is the primitive's own props — the press handlers, the
   * `aria-expanded`/`aria-haspopup` pair and the ref it positions against — and **must be spread
   * last** onto the element, so that nothing the caller sets quietly replaces them.
   */
  children: (api: { trigger: TriggerProps; expanded: boolean }) => JSX.Element
}) {
  const [uncontrolled, setUncontrolled] = createSignal(false)
  const open = () => props.open ?? uncontrolled()
  const setOpen = (next: boolean) => {
    setUncontrolled(next)
    props.onOpenChange?.(next)
  }
  createOverlayClaim(open)
  return (
    <DropdownMenu
      open={open()}
      onOpenChange={setOpen}
      placement={props.placement ?? 'bottom-start'}
      gutter={0}
    >
      <DropdownMenu.Trigger
        as={(triggerProps: TriggerProps) =>
          props.children({ trigger: triggerProps, expanded: open() })
        }
      />
      <MenuItems items={props.items} />
    </DropdownMenu>
  )
}
