import { Show, type JSX } from 'solid-js'
import { cx } from './cx'
import { X } from './icons'

export type BadgeVariant = 'neutral' | 'accent' | 'success' | 'warning' | 'danger'

const pill = 'inline-flex items-center gap-1 rounded-full text-xs font-medium whitespace-nowrap'

const badgeVariants: Record<BadgeVariant, string> = {
  neutral: 'bg-surface-3 text-fg',
  accent: 'bg-accent-soft text-accent-soft-fg',
  success: 'bg-success-soft text-success-text',
  warning: 'bg-warning-soft text-warning-text',
  danger: 'bg-danger-soft text-danger-text',
}

/** A status or a count: "Archived", "Folder missing", the number on a filter. */
export function Badge(props: { variant?: BadgeVariant; class?: string; children: JSX.Element }) {
  return (
    <span class={cx(pill, 'px-2 py-0.5', badgeVariants[props.variant ?? 'neutral'], props.class)}>
      {props.children}
    </span>
  )
}

/**
 * A user's tag on a project. Accent-tinted, because tags are what a person scans a library by.
 * With `onRemove` it grows a remove button named by `removeLabel`.
 */
export function Tag(props: {
  variant?: 'accent' | 'neutral'
  onRemove?: () => void
  removeLabel?: string
  class?: string
  children: JSX.Element
}) {
  return (
    <span
      class={cx(
        pill,
        'px-2.5 py-0.5',
        props.variant === 'neutral' ? badgeVariants.neutral : badgeVariants.accent,
        props.class,
      )}
    >
      {props.children}
      <Show when={props.onRemove}>
        <button
          type="button"
          class="-mr-1 inline-flex size-4 items-center justify-center rounded-full hover:bg-surface-3"
          aria-label={props.removeLabel ?? 'Remove'}
          onClick={() => props.onRemove?.()}
        >
          <X class="size-3" aria-hidden="true" />
        </button>
      </Show>
    </span>
  )
}
