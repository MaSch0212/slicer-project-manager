import { A } from '@solidjs/router'
import { splitProps, type ComponentProps, type JSX } from 'solid-js'
import { Dynamic } from 'solid-js/web'
import { cx } from './cx'
import { AlertTriangle, CircleAlert, CircleCheck, Info } from './icons'

export type TextVariant = 'body' | 'muted' | 'small' | 'label' | 'mono' | 'danger'

const textVariants: Record<TextVariant, string> = {
  body: 'text-sm text-fg',
  muted: 'text-sm text-fg-muted',
  small: 'text-xs text-fg-muted',
  label: 'text-xs font-medium tracking-wide text-fg-muted uppercase',
  mono: 'font-mono text-xs text-fg',
  danger: 'text-xs font-medium text-danger-text',
}

/** Running text. Feature code uses this instead of picking colours and sizes itself. */
export function Text(props: {
  variant?: TextVariant
  as?: 'p' | 'span' | 'div'
  class?: string
  children: JSX.Element
}) {
  return (
    <Dynamic
      component={props.as ?? 'p'}
      class={cx(textVariants[props.variant ?? 'body'], props.class)}
    >
      {props.children}
    </Dynamic>
  )
}

const headingLevels = {
  1: 'text-2xl font-semibold tracking-tight text-fg',
  2: 'text-lg font-semibold tracking-tight text-fg',
  3: 'text-sm font-semibold text-fg',
} as const

export function Heading(props: { level?: 1 | 2 | 3; class?: string; children: JSX.Element }) {
  const level = () => props.level ?? 2
  return (
    <Dynamic component={`h${level()}`} class={cx(headingLevels[level()], props.class)}>
      {props.children}
    </Dynamic>
  )
}

const linkClass =
  'rounded-xs font-medium text-accent-text underline decoration-transparent underline-offset-4 transition-colors hover:decoration-current'

/** An in-app link (client-side navigation), or with `external` a plain anchor to another site. */
export function Link(props: ComponentProps<typeof A> & { external?: boolean }) {
  const [local, rest] = splitProps(props, ['external', 'class'])
  return local.external ? (
    <a
      {...(rest as ComponentProps<'a'>)}
      class={cx(linkClass, local.class)}
      target="_blank"
      rel="noopener noreferrer"
    />
  ) : (
    <A {...rest} class={cx(linkClass, local.class)} />
  )
}

export function Divider(props: { class?: string }) {
  return <hr class={cx('border-0 border-t border-border', props.class)} />
}

export type AlertVariant = 'info' | 'success' | 'warning' | 'danger'

const alertVariants = {
  info: { box: 'bg-surface-2 text-fg', icon: Info },
  success: { box: 'bg-success-soft text-success-text', icon: CircleCheck },
  warning: { box: 'bg-warning-soft text-warning-text', icon: AlertTriangle },
  danger: { box: 'bg-danger-soft text-danger-text', icon: CircleAlert },
} as const

/** An inline, persistent statement about the current state. Danger alerts are announced at once. */
export function Alert(props: {
  variant?: AlertVariant
  title?: JSX.Element
  class?: string
  children?: JSX.Element
}) {
  const variant = () => alertVariants[props.variant ?? 'info']
  return (
    <div
      role={props.variant === 'danger' ? 'alert' : 'status'}
      class={cx('flex gap-3 rounded-control p-3 text-sm', variant().box, props.class)}
    >
      <Dynamic component={variant().icon} class="mt-0.5 size-4 shrink-0" aria-hidden="true" />
      <div class="flex flex-col gap-0.5">
        {props.title ? <p class="font-medium">{props.title}</p> : null}
        {props.children}
      </div>
    </div>
  )
}

/**
 * Who or what a row is about: a name with a smaller second line under it (a username, an id) and
 * an optional badge beside the name. For table cells and list rows.
 */
export function Identity(props: { title: string; subtitle?: string; badge?: JSX.Element }) {
  return (
    <div class="flex flex-col">
      <span class="flex items-center gap-2 text-sm font-medium text-fg">
        {props.title}
        {props.badge}
      </span>
      {props.subtitle ? <span class="text-xs text-fg-muted">{props.subtitle}</span> : null}
    </div>
  )
}
