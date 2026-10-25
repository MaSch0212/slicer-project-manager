import { For } from 'solid-js'

/**
 * A square of one design token, for the dev gallery's palette. The only place that reads a token
 * through `style`: a swatch is *about* a colour, so it cannot use a utility that would have to
 * be one of the tokens it is showing.
 */
export function Swatch(props: { token: string }) {
  return (
    <div class="flex items-center gap-2">
      <span
        class="size-8 shrink-0 rounded-control border border-border"
        style={{ background: `var(--color-${props.token})` }}
      />
      <code class="font-mono text-xs text-fg-muted">{props.token}</code>
    </div>
  )
}

const PALETTE = [
  'bg',
  'surface',
  'surface-2',
  'surface-3',
  'border',
  'border-input',
  'fg',
  'fg-muted',
  'fg-subtle',
  'accent',
  'accent-solid',
  'accent-text',
  'accent-soft',
  'accent-soft-fg',
  'danger-solid',
  'danger-text',
  'danger-soft',
  'success-text',
  'success-soft',
  'warning-text',
  'warning-soft',
]

/** Every colour token, for the dev gallery. */
export function Palette() {
  return (
    <div class="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
      <For each={PALETTE}>{(token) => <Swatch token={token} />}</For>
    </div>
  )
}
