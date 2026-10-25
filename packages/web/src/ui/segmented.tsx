import { createUniqueId, For, Show } from 'solid-js'
import { Dynamic } from 'solid-js/web'
import { cx } from './cx'
import type { IconComponent } from './icons'

export type SegmentOption<T extends string = string> = {
  value: T
  label: string
  icon?: IconComponent
}

/**
 * A short, mutually exclusive choice shown all at once (theme: system / light / dark). Native
 * radio inputs underneath, so arrow keys and screen readers behave as for any radio group.
 */
export function SegmentedControl<T extends string>(props: {
  label: string
  options: readonly SegmentOption<T>[]
  value: T
  onChange: (value: T) => void
  class?: string
}) {
  const name = createUniqueId()
  return (
    <div
      role="radiogroup"
      aria-label={props.label}
      class={cx(
        'inline-flex gap-0.5 rounded-control border border-border bg-surface-2 p-0.5',
        props.class,
      )}
    >
      <For each={props.options}>
        {(option) => (
          <label class="relative inline-flex h-7 cursor-pointer items-center gap-1.5 rounded-xs px-2.5 text-xs font-medium text-fg-muted transition-colors has-[:checked]:bg-surface has-[:checked]:text-fg has-[:checked]:shadow-card has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-accent">
            <input
              type="radio"
              class="absolute inset-0 size-full cursor-pointer opacity-0"
              name={name}
              value={option.value}
              checked={option.value === props.value}
              onChange={() => props.onChange(option.value)}
            />
            <Show when={option.icon}>
              <Dynamic component={option.icon} class="size-3.5" aria-hidden="true" />
            </Show>
            {option.label}
          </label>
        )}
      </For>
    </div>
  )
}
