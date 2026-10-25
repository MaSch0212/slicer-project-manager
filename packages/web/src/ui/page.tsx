import { Show, type JSX } from 'solid-js'
import { Dynamic } from 'solid-js/web'
import { LinkButton } from './button'
import { cx } from './cx'
import { ArrowLeft, type IconComponent } from './icons'

/** Nothing here yet, or nothing found: an icon, a sentence, and the way forward. */
export function EmptyState(props: {
  icon?: IconComponent
  title: JSX.Element
  description?: JSX.Element
  /** Usually a `Button`. */
  action?: JSX.Element
  class?: string
}) {
  return (
    <div
      class={cx(
        'flex flex-col items-center gap-3 rounded-card border border-dashed border-border-input px-6 py-14 text-center',
        props.class,
      )}
    >
      <Show when={props.icon}>
        <div class="flex size-11 items-center justify-center rounded-full bg-surface-2 text-fg-muted">
          <Dynamic component={props.icon} class="size-5" aria-hidden="true" />
        </div>
      </Show>
      <div class="flex max-w-md flex-col gap-1">
        <h2 class="text-base font-semibold tracking-tight text-fg">{props.title}</h2>
        <Show when={props.description}>
          <p class="text-sm text-fg-muted">{props.description}</p>
        </Show>
      </div>
      <Show when={props.action}>
        <div class="mt-1">{props.action}</div>
      </Show>
    </div>
  )
}

/** A placeholder block that pulses while content loads. Size it with `class` (`h-4 w-32`). */
export function Skeleton(props: { class?: string; circle?: boolean }) {
  return (
    <div
      aria-hidden="true"
      class={cx(
        'animate-shimmer bg-surface-3',
        props.circle ? 'rounded-full' : 'rounded-control',
        props.class,
      )}
    />
  )
}

/**
 * The top of a page: title, optional description, actions on the right, and an optional way back.
 * Every routed page starts with one, so titles look the same everywhere.
 */
export function PageHeader(props: {
  title: JSX.Element
  description?: JSX.Element
  actions?: JSX.Element
  back?: { href: string; label: string }
  class?: string
}) {
  return (
    <header class={cx('flex flex-col gap-3', props.class)}>
      <Show when={props.back}>
        {(back) => (
          <LinkButton
            href={back().href}
            variant="ghost"
            size="sm"
            icon={ArrowLeft}
            class="-ml-3 self-start"
          >
            {back().label}
          </LinkButton>
        )}
      </Show>
      <div class="flex flex-wrap items-center justify-between gap-x-4 gap-y-3">
        <div class="flex min-w-0 flex-col gap-1">
          <h1 class="text-2xl font-semibold tracking-tight text-fg">{props.title}</h1>
          <Show when={props.description}>
            <p class="text-sm text-fg-muted">{props.description}</p>
          </Show>
        </div>
        <Show when={props.actions}>
          <div class="flex flex-wrap items-center gap-2">{props.actions}</div>
        </Show>
      </div>
    </header>
  )
}
