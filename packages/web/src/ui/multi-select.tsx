import { Select as KSelect } from '@kobalte/core/select'
import { createMemo, createSignal, For, Show } from 'solid-js'
import { Badge, Tag } from './badges'
import { cx } from './cx'
import { useFormField } from './form-field'
import { Check, ChevronDown } from './icons'
import { fieldClass } from './input'
import type { SelectOption } from './select'

/**
 * Pick any number of options from a list. The trigger shows `label` and, once anything is chosen,
 * a count badge, so a narrow toolbar can say "Tags 3" without listing them. Keyboard, typeahead and
 * screen-reader behaviour come from the underlying listbox primitive.
 */
export function MultiSelect(props: {
  options: readonly SelectOption[]
  value: readonly string[]
  onChange: (value: string[]) => void
  /** Shown on the trigger, and its accessible name. */
  label: string
  /** Shown inside the list when `options` is empty. */
  emptyText?: string
  disabled?: boolean
  class?: string
}) {
  const field = useFormField()
  const labels = createMemo(() => new Map(props.options.map((o) => [o.value, o.label])))
  const optionFor = (value: string): SelectOption => ({
    value,
    label: labels().get(value) ?? value,
  })
  return (
    <KSelect<SelectOption>
      multiple
      options={props.options.map((o) => ({ ...o }))}
      optionValue="value"
      optionTextValue="label"
      optionDisabled="disabled"
      value={props.value.map(optionFor)}
      onChange={(selected) => props.onChange(selected.map((o) => o.value))}
      disabled={props.disabled}
      disallowEmptySelection={false}
      gutter={6}
      sameWidth={false}
      itemComponent={(item) => (
        <KSelect.Item
          item={item.item}
          class="flex cursor-default items-center justify-between gap-6 rounded-control px-2 py-1.5 text-sm outline-none select-none data-[disabled]:opacity-50 data-[highlighted]:bg-surface-2"
        >
          <KSelect.ItemLabel>{item.item.rawValue.label}</KSelect.ItemLabel>
          <KSelect.ItemIndicator>
            <Check class="size-4 text-accent-text" aria-hidden="true" />
          </KSelect.ItemIndicator>
        </KSelect.Item>
      )}
    >
      <KSelect.Trigger
        id={field?.id}
        aria-label={props.label}
        class={cx(fieldClass, 'flex h-9 items-center gap-2 px-3 text-left', props.class)}
      >
        <span class="flex-1 truncate">{props.label}</span>
        <Show when={props.value.length > 0}>
          <Badge variant="accent" class="tabular-nums">
            {props.value.length}
          </Badge>
        </Show>
        <KSelect.Icon>
          <ChevronDown class="size-4 text-fg-muted" aria-hidden="true" />
        </KSelect.Icon>
      </KSelect.Trigger>
      <KSelect.Portal>
        <KSelect.Content class="z-50 min-w-48 rounded-popover border border-border bg-surface p-1 text-fg shadow-popover animate-pop">
          <Show
            when={props.options.length > 0}
            fallback={<p class="px-2 py-1.5 text-sm text-fg-muted">{props.emptyText}</p>}
          >
            <KSelect.Listbox class="max-h-72 overflow-y-auto outline-none" />
          </Show>
        </KSelect.Content>
      </KSelect.Portal>
    </KSelect>
  )
}

/**
 * Free-form tags: type a name and press Enter (or comma) to add it, Backspace on an empty box to
 * remove the last one. `suggestions` are existing names offered as you type.
 */
export function TagInput(props: {
  value: readonly string[]
  onChange: (value: string[]) => void
  suggestions?: readonly string[]
  /** The accessible name of the text box. */
  label: string
  placeholder?: string
  /** Names longer than this are refused (the server's limit is 60). */
  maxLength?: number
  removeLabel?: (tag: string) => string
  class?: string
}) {
  const [draft, setDraft] = createSignal('')
  const [focused, setFocused] = createSignal(false)
  const field = useFormField()
  const has = (name: string) =>
    props.value.some((existing) => existing.toLowerCase() === name.toLowerCase())

  const matches = createMemo(() => {
    const needle = draft().trim().toLowerCase()
    return (props.suggestions ?? [])
      .filter((s) => !has(s) && (needle === '' || s.toLowerCase().includes(needle)))
      .slice(0, 8)
  })

  function add(raw: string): void {
    const name = raw.trim()
    if (name === '' || has(name)) {
      setDraft('')
      return
    }
    if (props.maxLength !== undefined && name.length > props.maxLength) return
    props.onChange([...props.value, name])
    setDraft('')
  }

  return (
    <div class={cx('relative', props.class)}>
      <div
        class={cx(
          fieldClass,
          'flex min-h-9 flex-wrap items-center gap-1.5 px-2 py-1 focus-within:border-accent',
        )}
      >
        <For each={props.value}>
          {(tag) => (
            <Tag
              onRemove={() => props.onChange(props.value.filter((t) => t !== tag))}
              removeLabel={props.removeLabel?.(tag) ?? `Remove ${tag}`}
            >
              {tag}
            </Tag>
          )}
        </For>
        <input
          id={field?.id}
          aria-label={props.label}
          aria-describedby={field?.describedBy()}
          class="min-w-24 flex-1 bg-transparent py-0.5 text-sm text-fg outline-none placeholder:text-fg-muted"
          placeholder={props.value.length === 0 ? props.placeholder : undefined}
          value={draft()}
          maxLength={props.maxLength}
          onInput={(event) => {
            const text = event.currentTarget.value
            if (text.endsWith(',')) add(text.slice(0, -1))
            else setDraft(text)
          }}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault()
              add(draft())
            } else if (event.key === 'Backspace' && draft() === '' && props.value.length > 0) {
              props.onChange(props.value.slice(0, -1))
            }
          }}
          onFocus={() => setFocused(true)}
          onBlur={() => {
            // Leaving the box commits what was typed, so a tag is never silently lost.
            setFocused(false)
            add(draft())
          }}
        />
      </div>
      <Show when={focused() && matches().length > 0}>
        <ul
          role="listbox"
          aria-label={props.label}
          class="absolute z-30 mt-1.5 max-h-56 w-full overflow-y-auto rounded-popover border border-border bg-surface p-1 shadow-popover"
        >
          <For each={matches()}>
            {(name) => (
              <li
                role="option"
                aria-selected="false"
                class="cursor-default rounded-control px-2 py-1.5 text-sm text-fg hover:bg-surface-2"
                // mousedown, not click: the input's blur would otherwise close the list first.
                onMouseDown={(event) => {
                  event.preventDefault()
                  add(name)
                }}
              >
                {name}
              </li>
            )}
          </For>
        </ul>
      </Show>
    </div>
  )
}
