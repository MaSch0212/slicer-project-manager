import { createContext, createUniqueId, Show, useContext, type JSX } from 'solid-js'
import { cx } from './cx'

type FormFieldContext = {
  id: string
  describedBy: () => string | undefined
  invalid: () => boolean
  required: () => boolean
}

const Context = createContext<FormFieldContext>()

/** What `Input`, `Textarea`, `Select` and friends read so a `FormField` wires them up for free. */
export function useFormField(): FormFieldContext | undefined {
  return useContext(Context)
}

/** The shared look of a field's label, also used by `Checkbox` and `Switch` labels. */
export const labelClass = 'text-sm font-medium text-fg'

/**
 * A label, one control, an optional hint and an optional error. The control inside (any of the
 * form components in this library) picks up its `id`, `aria-describedby` and `aria-invalid` from
 * here, so a page never wires `for=`/`id=` pairs by hand.
 */
export function FormField(props: {
  label: JSX.Element
  hint?: JSX.Element
  /** A message makes the field invalid and is announced as an alert. */
  error?: JSX.Element
  required?: boolean
  class?: string
  children: JSX.Element
}) {
  const id = createUniqueId()
  const hintId = `${id}-hint`
  const errorId = `${id}-error`
  const context: FormFieldContext = {
    id,
    invalid: () => Boolean(props.error),
    required: () => Boolean(props.required),
    describedBy: () => {
      const ids = [props.hint ? hintId : undefined, props.error ? errorId : undefined]
      const joined = ids.filter(Boolean).join(' ')
      return joined === '' ? undefined : joined
    },
  }
  return (
    <Context.Provider value={context}>
      <div class={cx('flex flex-col gap-1.5', props.class)}>
        <label for={id} class={labelClass}>
          {props.label}
          <Show when={props.required}>
            <span class="text-fg-muted" aria-hidden="true">
              {' '}
              *
            </span>
          </Show>
        </label>
        {props.children}
        <Show when={props.hint}>
          <p id={hintId} class="text-xs text-fg-muted">
            {props.hint}
          </p>
        </Show>
        <Show when={props.error}>
          <p id={errorId} role="alert" class="text-xs font-medium text-danger-text">
            {props.error}
          </p>
        </Show>
      </div>
    </Context.Provider>
  )
}
