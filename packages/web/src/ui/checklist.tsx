import { createMemo, createSignal, For, Show } from 'solid-js'
import { cx } from './cx'
import { Check, Plus, Search } from './icons'
import { Input } from './input'

/**
 * Pick any of a list of names, each row with a checkmark when it is picked: the tag filter behind
 * the funnel and a project's own tags. A field above narrows the rows as you type and, where
 * `createLabel` is given, offers to add what was typed when no row has that name yet — so one
 * control both picks existing tags and makes new ones.
 *
 * Each row is a `checkbox`: it says what it is and whether it is on, and Space or Enter toggles it.
 * Enter in the field toggles the row whose name was typed exactly, or adds it.
 */
export function CheckList(props: {
  /** The rows' accessible name: "Tags". */
  label: string
  options: readonly string[]
  value: readonly string[]
  onChange: (next: string[]) => void
  /** The field's accessible name and placeholder. */
  searchLabel: string
  /** Shown when there is nothing to list at all. */
  emptyText: string
  /** Shown when the field matches nothing and nothing can be added. */
  noMatchText?: string
  createLabel?: (name: string) => string
  maxLength?: number
  /** Focuses the field as the list appears, for a popover that opens onto it. */
  autofocus?: boolean
}) {
  const [query, setQuery] = createSignal('')
  const typed = () => query().trim()
  const shown = createMemo(() => {
    const needle = typed().toLocaleLowerCase()
    return needle === ''
      ? [...props.options]
      : props.options.filter((option) => option.toLocaleLowerCase().includes(needle))
  })
  const exact = () => props.options.find((option) => option === typed())
  const canCreate = () => Boolean(props.createLabel) && typed() !== '' && exact() === undefined
  const isOn = (option: string) => props.value.includes(option)

  function toggle(option: string): void {
    props.onChange(
      isOn(option) ? props.value.filter((value) => value !== option) : [...props.value, option],
    )
  }

  function create(): void {
    const name = typed()
    if (name === '') return
    if (!isOn(name)) props.onChange([...props.value, name])
    setQuery('')
  }

  return (
    <div class="flex min-h-0 flex-col gap-2">
      <Input
        type="search"
        leading={Search}
        value={query()}
        maxLength={props.maxLength}
        aria-label={props.searchLabel}
        placeholder={props.searchLabel}
        autocomplete="off"
        autofocus={props.autofocus}
        onInput={(event) => setQuery(event.currentTarget.value)}
        onKeyDown={(event) => {
          if (event.key !== 'Enter') return
          event.preventDefault()
          const match = exact()
          if (match !== undefined) toggle(match)
          else if (canCreate()) create()
        }}
      />
      <div
        role="group"
        aria-label={props.label}
        class="-mx-1 flex min-h-0 flex-col overflow-y-auto"
      >
        <For each={shown()}>
          {(option) => (
            <button
              type="button"
              role="checkbox"
              aria-checked={isOn(option)}
              onClick={() => toggle(option)}
              class="flex min-h-8 shrink-0 items-center justify-between gap-4 rounded-control px-2 text-left text-sm text-fg transition-colors outline-none hover:bg-surface-2 focus-visible:bg-surface-2"
            >
              <span class="truncate">{option}</span>
              <Check
                class={cx('size-4 shrink-0 text-accent-text', !isOn(option) && 'invisible')}
                aria-hidden="true"
              />
            </button>
          )}
        </For>
        <Show when={canCreate()}>
          <button
            type="button"
            onClick={create}
            class="flex min-h-8 shrink-0 items-center gap-2 rounded-control px-2 text-left text-sm text-accent-text transition-colors outline-none hover:bg-surface-2 focus-visible:bg-surface-2"
          >
            <Plus class="size-4 shrink-0" aria-hidden="true" />
            <span class="truncate">{props.createLabel?.(typed())}</span>
          </button>
        </Show>
        <Show when={shown().length === 0 && !canCreate()}>
          <p class="px-2 py-1.5 text-sm text-fg-muted">
            {props.options.length === 0 ? props.emptyText : (props.noMatchText ?? props.emptyText)}
          </p>
        </Show>
      </div>
    </div>
  )
}
