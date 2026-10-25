import { createUniqueId, For, Show, type JSX } from 'solid-js'
import { cx } from './cx'

export type ChoiceOption = {
  value: string
  label: string
  /** A smaller second line under the label (a version, say). */
  detail?: string
  /** A third line in the monospace face, for a path or an id. Breaks anywhere: they are long. */
  code?: string
  /** Sits at the end of the row, beside the actions. */
  badge?: JSX.Element
  /** Controls of the row that are not part of the choice (a remove button). */
  action?: JSX.Element
}

/**
 * One choice out of a short list where each option is worth a few lines of its own: a stack of
 * bordered rows, each with a radio, a label, up to two lines of detail, and room at the end for a
 * badge and an action. Native radio inputs underneath, so arrow keys and screen readers behave as
 * for any radio group.
 *
 * **Controlled for real.** `value` is the truth and `onChange` is a request: when the request is
 * refused (the owner never changes `value`) the radios go back to what `value` says instead of
 * sitting on the option the user clicked, which would be a control showing a state the app does not
 * have. `value: null` is "nothing chosen", and nothing is pre-selected for the user.
 */
export function ChoiceList(props: {
  label: string
  options: readonly ChoiceOption[]
  value: string | null
  onChange: (value: string) => void
  disabled?: boolean
  class?: string
}) {
  const name = createUniqueId()
  let group: HTMLDivElement | undefined

  /** Puts every radio back to what `value` says. */
  function resync(): void {
    for (const input of group?.querySelectorAll<HTMLInputElement>('input[type="radio"]') ?? []) {
      input.checked = input.value === props.value
    }
  }

  return (
    <div
      ref={(element) => (group = element)}
      role="radiogroup"
      aria-label={props.label}
      class={cx('flex flex-col gap-2', props.class)}
    >
      <For each={props.options}>
        {(option) => (
          <div class="flex items-start gap-3 rounded-control border border-border bg-surface p-3 has-[:checked]:border-accent-solid">
            <label class="relative flex min-w-0 flex-1 cursor-pointer items-start gap-3 has-[:disabled]:cursor-default">
              <input
                type="radio"
                class="mt-0.5 size-4 shrink-0 cursor-pointer accent-accent-solid focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent disabled:cursor-default"
                name={name}
                value={option.value}
                checked={option.value === props.value}
                disabled={props.disabled}
                onChange={() => {
                  props.onChange(option.value)
                  resync()
                }}
              />
              <span class="flex min-w-0 flex-col gap-0.5">
                <span class="text-sm font-medium text-fg">{option.label}</span>
                <Show when={option.detail}>
                  <span class="text-xs text-fg-muted">{option.detail}</span>
                </Show>
                <Show when={option.code}>
                  <span class="font-mono text-xs break-all text-fg-muted">{option.code}</span>
                </Show>
              </span>
            </label>
            <Show when={option.badge}>
              <div class="shrink-0">{option.badge}</div>
            </Show>
            <Show when={option.action}>
              <div class="shrink-0">{option.action}</div>
            </Show>
          </div>
        )}
      </For>
    </div>
  )
}
