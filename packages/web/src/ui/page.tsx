import { Show, type JSX } from 'solid-js'
import { Dynamic } from 'solid-js/web'
import { LinkButton } from './button'
import { IconButton } from './icon-button'
import { cx } from './cx'
import { ArrowLeft, X, type IconComponent } from './icons'

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
  /** A way out that is not a navigation: the detail panel's close, beside the title. */
  close?: { label: string; onClick: () => void }
  /**
   * 1 for a page, 2 for a header inside one — the detail panel beside the project list, whose
   * page already has the `<h1>`. Two `<h1>`s on a screen is two answers to "what is this".
   */
  level?: 1 | 2
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
      <div class="flex flex-wrap items-start justify-between gap-x-4 gap-y-3">
        {/*
          The close sits on the title's line, not after the actions: in a narrow panel the
          actions wrap, and a close pushed along with them ends up stranded on a row of its own.
        */}
        <div class="flex min-w-0 flex-1 items-start gap-3">
          <div class="flex min-w-0 flex-col gap-1">
            <Dynamic
              component={`h${props.level ?? 1}`}
              class="text-2xl font-semibold tracking-tight text-fg"
            >
              {props.title}
            </Dynamic>
            <Show when={props.description}>
              <p class="text-sm text-fg-muted">{props.description}</p>
            </Show>
          </div>
          <Show when={props.close}>
            {(close) => (
              <span class="ml-auto shrink-0">
                <IconButton icon={X} label={close().label} onClick={() => close().onClick()} />
              </span>
            )}
          </Show>
        </div>
        <Show when={props.actions}>
          <div class="flex flex-wrap items-center gap-2">{props.actions}</div>
        </Show>
      </div>
    </header>
  )
}

/**
 * The fixed top row of a panel beside a list: the title on one line, then its actions as icons,
 * then the close. Icons rather than labelled buttons because a panel is as narrow as the user
 * drags it, and a title squeezed into a column of single words beside three wrapping buttons was
 * what labelled ones did. Same height as the list's toolbar, so the two rows read as one line.
 */
export function PanelHeader(props: {
  title: JSX.Element
  /** 2 in a page that already has its `<h1>`. */
  level?: 2 | 3
  actions?: JSX.Element
  close?: { label: string; onClick: () => void }
}) {
  return (
    <header class="flex h-12 shrink-0 items-center gap-1 border-b border-border pr-2 pl-4">
      <Dynamic
        component={`h${props.level ?? 2}`}
        class="min-w-0 flex-1 truncate text-base font-semibold tracking-tight text-fg"
      >
        {props.title}
      </Dynamic>
      <Show when={props.actions}>
        <div class="flex shrink-0 items-center gap-0.5">{props.actions}</div>
      </Show>
      <Show when={props.close}>
        {(close) => (
          <>
            <div class="mx-1 h-5 border-l border-border" aria-hidden="true" />
            <IconButton icon={X} label={close().label} onClick={() => close().onClick()} />
          </>
        )}
      </Show>
    </header>
  )
}
