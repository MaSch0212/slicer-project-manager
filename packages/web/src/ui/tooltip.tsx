import { Tooltip as KTooltip } from '@kobalte/core/tooltip'
import type { JSX } from 'solid-js'
import { Portal } from 'solid-js/web'
import { cx } from './cx'

/** The shared look of a tooltip bubble (also used by `IconButton`). */
export const tooltipClass =
  'z-50 max-w-xs rounded-control bg-fg px-2 py-1 text-xs font-medium text-bg animate-fade'

/**
 * A short hint for something that is not itself a control (a truncated name, a status dot).
 * For an icon-only control use `IconButton`, which carries its own tooltip and accessible name.
 * The wrapped content becomes keyboard-focusable so the hint is reachable without a mouse.
 */
export function Tooltip(props: {
  content: JSX.Element
  placement?: 'top' | 'bottom' | 'left' | 'right'
  class?: string
  children: JSX.Element
}) {
  return (
    <KTooltip placement={props.placement ?? 'top'} openDelay={300} gutter={6}>
      <KTooltip.Trigger as="span" tabIndex={0} class={cx('inline-flex', props.class)}>
        {props.children}
      </KTooltip.Trigger>
      <Portal>
        <KTooltip.Content class={tooltipClass}>{props.content}</KTooltip.Content>
      </Portal>
    </KTooltip>
  )
}
