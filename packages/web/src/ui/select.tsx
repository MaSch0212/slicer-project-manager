import { For, Show, splitProps, type ComponentProps } from 'solid-js'
import { Dynamic } from 'solid-js/web'
import { cx } from './cx'
import { useFormField } from './form-field'
import { ChevronDown, type IconComponent } from './icons'
import { fieldClass } from './input'

export type SelectOption<T extends string = string> = {
  value: T
  label: string
  disabled?: boolean
}

/**
 * A single choice from a short list, on the platform's own `<select>`: it is the right control on
 * a phone and fully keyboard and screen-reader accessible for free. For several choices at once
 * use `MultiSelect`.
 */
export function Select<T extends string = string>(
  props: Omit<ComponentProps<'select'>, 'value' | 'onChange'> & {
    options: readonly SelectOption<T>[]
    value: T | undefined
    onChange: (value: T) => void
    /** A first, empty option shown while nothing is chosen. */
    placeholder?: string
    invalid?: boolean
    /** An icon inside the left edge, for a select that goes without a visible label. */
    leading?: IconComponent
  },
) {
  const [local, rest] = splitProps(props, [
    'options',
    'value',
    'onChange',
    'placeholder',
    'invalid',
    'leading',
    'class',
    'id',
  ])
  const field = useFormField()
  return (
    <div class="relative">
      <Show when={local.leading}>
        <Dynamic
          component={local.leading}
          class="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-fg-muted"
          aria-hidden="true"
        />
      </Show>
      <select
        {...rest}
        id={local.id ?? field?.id}
        aria-describedby={rest['aria-describedby'] ?? field?.describedBy()}
        aria-invalid={(local.invalid ?? field?.invalid()) ? 'true' : undefined}
        class={cx(
          fieldClass,
          'h-9 appearance-none pr-9',
          local.leading ? 'pl-9' : 'pl-3',
          local.class,
        )}
        onChange={(event) => local.onChange(event.currentTarget.value as T)}
      >
        <Show when={local.placeholder !== undefined}>
          <option value="" disabled selected={local.value === undefined || local.value === ''}>
            {local.placeholder}
          </option>
        </Show>
        <For each={local.options}>
          {(option) => (
            <option
              value={option.value}
              disabled={option.disabled}
              selected={option.value === local.value}
            >
              {option.label}
            </option>
          )}
        </For>
      </select>
      <ChevronDown
        class="pointer-events-none absolute top-1/2 right-3 size-4 -translate-y-1/2 text-fg-muted"
        aria-hidden="true"
      />
    </div>
  )
}
