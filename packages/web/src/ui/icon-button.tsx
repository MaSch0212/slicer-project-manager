import { Tooltip as KTooltip } from '@kobalte/core/tooltip'
import { A } from '@solidjs/router'
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

/**
 * An icon-only button with two states, like "show archived": one control with one accessible name,
 * `aria-pressed` saying which state it is in, and the icon (plus a lifted look) showing it. The
 * name never changes with the state: a name that flipped would be announced as a different control
 * on every press.
 */
export function ToggleIconButton(
  props: Omit<ComponentProps<'button'>, 'children' | 'aria-label' | 'aria-pressed' | 'type'> & {
    pressed: boolean
    onPressedChange: (pressed: boolean) => void
    /** The icon while pressed. */
    iconOn: IconComponent
    /** The icon while not pressed. */
    iconOff: IconComponent
    label: string
    size?: IconButtonSize
  },
) {
  const [local, rest] = splitProps(props, [
    'pressed',
    'onPressedChange',
    'iconOn',
    'iconOff',
    'label',
    'size',
    'onClick',
  ])
  return (
    <IconButton
      {...rest}
      icon={local.pressed ? local.iconOn : local.iconOff}
      label={local.label}
      size={local.size}
      variant={local.pressed ? 'secondary' : 'ghost'}
      aria-pressed={local.pressed}
      onClick={(event) => {
        if (typeof local.onClick === 'function') local.onClick(event)
        local.onPressedChange(!local.pressed)
      }}
    />
  )
}

/**
 * An icon-only link that looks like an icon button: "go somewhere" (an in-app route), or with
 * `external` a plain anchor (a download, another site). `label` is the accessible name and the
 * tooltip, as for `IconButton`.
 */
export function IconLinkButton(
  props: Omit<ComponentProps<'a'>, 'children' | 'aria-label' | 'href' | 'download'> & {
    href: string
    icon: IconComponent
    label: string
    variant?: ButtonVariant
    size?: IconButtonSize
    /** A plain `<a>` instead of a router link. */
    external?: boolean
    /** For `external`: the file name to save as, which makes the browser download rather than open it. */
    download?: string
  },
) {
  const [local, rest] = splitProps(props, [
    'icon',
    'label',
    'variant',
    'size',
    'external',
    'class',
    'href',
  ])
  const classes = () =>
    cx(buttonClass(local.variant ?? 'ghost', local.size ?? 'md', true), local.class)
  const glyph = () => <Dynamic component={local.icon} class="size-4" aria-hidden="true" />
  return (
    <KTooltip placement="bottom" openDelay={500} closeDelay={0} gutter={6}>
      <KTooltip.Trigger
        as={(triggerProps: ComponentProps<'a'>) =>
          local.external ? (
            <a {...triggerProps} {...rest} href={local.href} class={classes()} />
          ) : (
            <A {...triggerProps} {...rest} href={local.href} class={classes()} />
          )
        }
        aria-label={local.label}
      >
        {glyph()}
      </KTooltip.Trigger>
      <Portal>
        <KTooltip.Content class={tooltipClass}>{local.label}</KTooltip.Content>
      </Portal>
    </KTooltip>
  )
}
