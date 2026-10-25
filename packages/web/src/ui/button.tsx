import { A } from '@solidjs/router'
import { Show, splitProps, type ComponentProps, type JSX } from 'solid-js'
import { Dynamic } from 'solid-js/web'
import { cx } from './cx'
import type { IconComponent } from './icons'
import { Spinner } from './spinner'

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger'
export type ButtonSize = 'sm' | 'md'

const base =
  'inline-flex shrink-0 items-center justify-center gap-2 whitespace-nowrap rounded-control border font-medium transition-colors select-none disabled:pointer-events-none disabled:opacity-50 aria-disabled:pointer-events-none aria-disabled:opacity-50'

const variants: Record<ButtonVariant, string> = {
  primary: 'border-transparent bg-accent-solid text-accent-fg hover:bg-accent-solid-hover',
  secondary: 'border-border bg-surface text-fg shadow-card hover:bg-surface-2',
  ghost: 'border-transparent bg-transparent text-fg hover:bg-surface-2',
  danger: 'border-transparent bg-danger-solid text-danger-fg hover:bg-danger-solid-hover',
}

const sizes: Record<ButtonSize, string> = {
  sm: 'h-8 px-3 text-xs',
  md: 'h-9 px-4 text-sm',
}

/** Icon-only buttons are square instead of padded. */
const squareSizes: Record<ButtonSize, string> = {
  sm: 'size-8 text-xs',
  md: 'size-9 text-sm',
}

/** The one place a button's look is decided. Also used by `LinkButton`, `Menu` and `IconButton`. */
export function buttonClass(
  variant: ButtonVariant = 'secondary',
  size: ButtonSize = 'md',
  square = false,
) {
  return cx(base, variants[variant], (square ? squareSizes : sizes)[size])
}

export type ButtonProps = Omit<ComponentProps<'button'>, 'children'> & {
  variant?: ButtonVariant
  size?: ButtonSize
  /** Shows a spinner, disables the button and marks it busy. A loading button never fires. */
  loading?: boolean
  /** An icon before the label. */
  icon?: IconComponent
  children?: JSX.Element
}

export function Button(props: ButtonProps) {
  const [local, rest] = splitProps(props, [
    'variant',
    'size',
    'loading',
    'icon',
    'children',
    'class',
    'type',
    'disabled',
  ])
  return (
    <button
      {...rest}
      type={local.type ?? 'button'}
      disabled={local.disabled || local.loading}
      aria-busy={local.loading ? 'true' : undefined}
      class={cx(buttonClass(local.variant, local.size), local.class)}
    >
      <Show
        when={local.loading}
        fallback={
          <Show when={local.icon}>
            <Dynamic component={local.icon} class="size-4" aria-hidden="true" />
          </Show>
        }
      >
        <Spinner size="sm" />
      </Show>
      {local.children}
    </button>
  )
}

/**
 * A link that looks like a button: for "go somewhere", where `Button` is "do something". A router
 * link by default; with `external` a plain anchor, for a download or another site (`download` asks
 * the browser to save the file instead of opening it).
 */
export function LinkButton(
  props: Omit<ComponentProps<typeof A>, 'children' | 'download'> & {
    variant?: ButtonVariant
    size?: ButtonSize
    icon?: IconComponent
    external?: boolean
    download?: string
    children?: JSX.Element
  },
) {
  const [local, rest] = splitProps(props, [
    'variant',
    'size',
    'icon',
    'external',
    'children',
    'class',
  ])
  const content = () => (
    <>
      <Show when={local.icon}>
        <Dynamic component={local.icon} class="size-4" aria-hidden="true" />
      </Show>
      {local.children}
    </>
  )
  return (
    <Show
      when={local.external}
      fallback={
        <A {...rest} class={cx(buttonClass(local.variant, local.size), local.class)}>
          {content()}
        </A>
      }
    >
      <a
        {...(rest as ComponentProps<'a'>)}
        class={cx(buttonClass(local.variant, local.size), local.class)}
      >
        {content()}
      </a>
    </Show>
  )
}
