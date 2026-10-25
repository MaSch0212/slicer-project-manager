import { DropdownMenu } from '@kobalte/core/dropdown-menu'
import { For, Show, type JSX } from 'solid-js'
import { Dynamic } from 'solid-js/web'
import { buttonClass, type ButtonVariant } from './button'
import { cx } from './cx'
import { Check, ChevronDown, MoreHorizontal, type IconComponent } from './icons'

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
  return (
    <DropdownMenu placement={props.placement ?? 'bottom-end'} gutter={6}>
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
                  <Show when={entry.checked}>
                    <Check class="size-4 text-accent-text" aria-hidden="true" />
                  </Show>
                </DropdownMenu.Item>
              )
            }
          </For>
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu>
  )
}
