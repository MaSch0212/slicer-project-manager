import { Tooltip as KTooltip } from '@kobalte/core/tooltip'
import { splitProps, type ComponentProps } from 'solid-js'
import { Dynamic, Portal } from 'solid-js/web'
import { buttonClass, type ButtonVariant } from './button'
import { cx } from './cx'
import type { IconComponent } from './icons'
import { tooltipClass } from './tooltip'

export type IconButtonSize = 'sm' | 'md'

/**
 * A button that is only an icon. `label` is required: it is the accessible name and, unless
 * `tooltip` is false, the tooltip too, so a keyboard user and a sighted user get the same words.
 */
export function IconButton(
  props: Omit<ComponentProps<'button'>, 'children' | 'aria-label' | 'type'> & {
    type?: 'button' | 'submit' | 'reset'
    icon: IconComponent
    label: string
    variant?: ButtonVariant
    size?: IconButtonSize
    tooltip?: boolean
  },
) {
  const [local, rest] = splitProps(props, [
    'icon',
    'label',
    'variant',
    'size',
    'tooltip',
    'class',
    'type',
  ])
  const classes = () =>
    cx(buttonClass(local.variant ?? 'ghost', local.size ?? 'md', true), local.class)
  const glyph = () => <Dynamic component={local.icon} class="size-4" aria-hidden="true" />
  return local.tooltip === false ? (
    <button {...rest} type={local.type ?? 'button'} aria-label={local.label} class={classes()}>
      {glyph()}
    </button>
  ) : (
    <KTooltip placement="bottom" openDelay={500} closeDelay={0} gutter={6}>
      <KTooltip.Trigger
        {...rest}
        type={local.type ?? 'button'}
        aria-label={local.label}
        class={classes()}
      >
        {glyph()}
      </KTooltip.Trigger>
      <Portal>
        <KTooltip.Content class={tooltipClass}>{local.label}</KTooltip.Content>
      </Portal>
    </KTooltip>
  )
}
