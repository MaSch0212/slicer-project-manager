import { Show, splitProps, type ComponentProps } from 'solid-js'
import { Dynamic } from 'solid-js/web'
import { cx } from './cx'
import { useFormField } from './form-field'
import type { IconComponent } from './icons'

/** The shared look of a text-like control: Input, Textarea, Select and the MultiSelect trigger. */
export const fieldClass =
  'w-full rounded-control border border-border-input bg-surface text-sm text-fg placeholder:text-fg-muted transition-colors focus-visible:border-accent focus-visible:outline-offset-0 disabled:cursor-not-allowed disabled:opacity-50 aria-invalid:border-danger-text'

export type InputProps = Omit<ComponentProps<'input'>, 'size'> & {
  /** An icon inside the left edge, e.g. a magnifier on a search box. */
  leading?: IconComponent
  invalid?: boolean
}

export function Input(props: InputProps) {
  const [local, rest] = splitProps(props, ['leading', 'invalid', 'class', 'id'])
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
      <input
        required={field?.required()}
        {...rest}
        id={local.id ?? field?.id}
        aria-describedby={rest['aria-describedby'] ?? field?.describedBy()}
        aria-invalid={(local.invalid ?? field?.invalid()) ? 'true' : undefined}
        class={cx(fieldClass, 'h-9 px-3', local.leading && 'pl-9', local.class)}
      />
    </div>
  )
}

export function Textarea(props: ComponentProps<'textarea'> & { invalid?: boolean }) {
  const [local, rest] = splitProps(props, ['invalid', 'class', 'id'])
  const field = useFormField()
  return (
    <textarea
      rows={4}
      {...rest}
      id={local.id ?? field?.id}
      aria-describedby={rest['aria-describedby'] ?? field?.describedBy()}
      aria-invalid={(local.invalid ?? field?.invalid()) ? 'true' : undefined}
      class={cx(fieldClass, 'min-h-20 resize-y px-3 py-2', local.class)}
    />
  )
}
