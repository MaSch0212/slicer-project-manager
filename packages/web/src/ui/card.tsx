import { Show, splitProps, type ComponentProps, type JSX } from 'solid-js'
import { cx } from './cx'

export type CardPadding = 'none' | 'md' | 'lg'

const paddings: Record<CardPadding, string> = {
  none: '',
  md: 'p-4',
  lg: 'p-6',
}

/** The one surface: 1px border, card radius, a hairline of shadow. */
export function Card(
  props: ComponentProps<'div'> & {
    padding?: CardPadding
    /** Lifts the border on hover, for a card that is itself a link target. */
    interactive?: boolean
  },
) {
  const [local, rest] = splitProps(props, ['padding', 'interactive', 'class'])
  return (
    <div
      {...rest}
      class={cx(
        'rounded-card border border-border bg-surface text-fg shadow-card',
        paddings[local.padding ?? 'md'],
        local.interactive && 'transition-colors hover:border-border-input',
        local.class,
      )}
    />
  )
}

/**
 * A titled block of a settings-style page: a card with a heading, an optional sentence under it,
 * and the content (usually `SettingRow`s or a form).
 */
export function SectionCard(props: {
  title: JSX.Element
  description?: JSX.Element
  class?: string
  children: JSX.Element
}) {
  return (
    <Card padding="lg" class={cx('flex flex-col gap-5', props.class)}>
      <div class="flex flex-col gap-1">
        <h2 class="text-base font-semibold tracking-tight text-fg">{props.title}</h2>
        <Show when={props.description}>
          <p class="text-sm text-fg-muted">{props.description}</p>
        </Show>
      </div>
      {props.children}
    </Card>
  )
}

/**
 * One setting inside a `SectionCard`: what it is (and a hint) on the left, its control on the
 * right. On a phone the control drops under the text. `label` names the row for the eye; the
 * control inside carries its own accessible name.
 */
export function SettingRow(props: {
  label: JSX.Element
  hint?: JSX.Element
  children: JSX.Element
}) {
  return (
    <div class="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between sm:gap-6">
      <div class="flex min-w-0 flex-col gap-0.5">
        <span class="text-sm font-medium text-fg">{props.label}</span>
        <Show when={props.hint}>
          <span class="text-xs text-fg-muted">{props.hint}</span>
        </Show>
      </div>
      <div class="shrink-0">{props.children}</div>
    </div>
  )
}
