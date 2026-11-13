import { Popover as KPopover } from '@kobalte/core/popover'
import { createSignal, type JSX } from 'solid-js'
import { cx } from './cx'
import type { TriggerProps } from './menu'
import { createOverlayClaim } from './overlay'

/**
 * A panel anchored to a control: the filters behind the funnel, the tag picker in the detail
 * panel. Not a menu — it holds controls of its own (a search field, a list of checkboxes, a
 * switch), which a menu's typeahead and arrow keys would fight.
 *
 * The trigger is drawn by the caller, like `MenuTrigger`'s: `trigger` carries the primitive's
 * press handling, its ARIA pair and the ref it positions against, and must be spread **last**.
 * Escape, a click outside and the focus going back to the trigger come from the primitive.
 */
export function Popover(props: {
  /** The panel's accessible name. */
  label: string
  placement?: 'bottom-start' | 'bottom-end'
  /** Called as the panel opens or closes, for a caller that resets a field on opening. */
  onOpenChange?: (open: boolean) => void
  trigger: (api: { trigger: TriggerProps; expanded: boolean }) => JSX.Element
  class?: string
  children: JSX.Element
}) {
  const [open, setOpen] = createSignal(false)
  createOverlayClaim(open)
  return (
    <KPopover
      open={open()}
      onOpenChange={(next) => {
        setOpen(next)
        props.onOpenChange?.(next)
      }}
      placement={props.placement ?? 'bottom-start'}
      gutter={6}
    >
      <KPopover.Trigger
        as={(triggerProps: TriggerProps) =>
          props.trigger({ trigger: triggerProps, expanded: open() })
        }
      />
      <KPopover.Portal>
        <KPopover.Content
          aria-label={props.label}
          class={cx(
            'z-50 flex max-h-[min(28rem,var(--kb-popover-content-available-height))] w-72 flex-col overflow-hidden rounded-popover border border-border bg-surface text-fg shadow-popover outline-none animate-pop',
            props.class,
          )}
        >
          {props.children}
        </KPopover.Content>
      </KPopover.Portal>
    </KPopover>
  )
}

/** A titled block inside a popover: "Tags", "Archived". */
export function PopoverSection(props: { title: string; children: JSX.Element; class?: string }) {
  return (
    <div class={cx('flex min-h-0 flex-col gap-1.5 p-3', props.class)}>
      <div class="text-xs font-medium tracking-wide text-fg-muted uppercase">{props.title}</div>
      {props.children}
    </div>
  )
}

/** The rule between two sections of a popover. */
export function PopoverDivider() {
  return <div class="border-t border-border" />
}
