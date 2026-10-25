import { Checkbox as KCheckbox } from '@kobalte/core/checkbox'
import { Switch as KSwitch } from '@kobalte/core/switch'
import type { JSX } from 'solid-js'
import { cx } from './cx'
import { Check } from './icons'

const focusRing =
  'group-has-[input:focus-visible]:outline-2 group-has-[input:focus-visible]:outline-offset-2 group-has-[input:focus-visible]:outline-accent'

type ToggleProps = {
  label: JSX.Element
  /** Keeps the label as the accessible name but does not draw it (the row around it says it). */
  labelHidden?: boolean
  checked?: boolean
  defaultChecked?: boolean
  onChange?: (checked: boolean) => void
  disabled?: boolean
  name?: string
  class?: string
}

export function Checkbox(props: ToggleProps & { indeterminate?: boolean }) {
  return (
    <KCheckbox
      class={cx('group inline-flex items-center gap-2', props.class)}
      checked={props.checked}
      defaultChecked={props.defaultChecked}
      onChange={props.onChange}
      indeterminate={props.indeterminate}
      disabled={props.disabled}
      name={props.name}
    >
      <KCheckbox.Input />
      <KCheckbox.Control
        class={cx(
          'flex size-4 shrink-0 items-center justify-center rounded-xs border border-border-input bg-surface text-accent-fg transition-colors data-[checked]:border-accent-solid data-[checked]:bg-accent-solid data-[indeterminate]:border-accent-solid data-[indeterminate]:bg-accent-solid group-data-[disabled]:opacity-50',
          focusRing,
        )}
      >
        <KCheckbox.Indicator>
          <Check class="size-3" stroke-width={3} aria-hidden="true" />
        </KCheckbox.Indicator>
      </KCheckbox.Control>
      <KCheckbox.Label class="text-sm text-fg group-data-[disabled]:opacity-50">
        {props.label}
      </KCheckbox.Label>
    </KCheckbox>
  )
}

export function Switch(props: ToggleProps) {
  return (
    <KSwitch
      class={cx('group inline-flex items-center gap-3', props.class)}
      checked={props.checked}
      defaultChecked={props.defaultChecked}
      onChange={props.onChange}
      disabled={props.disabled}
      name={props.name}
    >
      <KSwitch.Input />
      <KSwitch.Control
        class={cx(
          'inline-flex h-5 w-9 shrink-0 items-center rounded-full border border-border-input bg-surface-3 px-0.5 transition-colors data-[checked]:border-accent-solid data-[checked]:bg-accent-solid group-data-[disabled]:opacity-50',
          focusRing,
        )}
      >
        <KSwitch.Thumb class="size-3.5 rounded-full bg-surface shadow-card transition-transform data-[checked]:translate-x-4 data-[checked]:bg-accent-fg" />
      </KSwitch.Control>
      <KSwitch.Label
        class={cx(
          'text-sm text-fg group-data-[disabled]:opacity-50',
          props.labelHidden && 'sr-only',
        )}
      >
        {props.label}
      </KSwitch.Label>
    </KSwitch>
  )
}
