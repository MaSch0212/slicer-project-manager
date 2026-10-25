import { For, type JSX } from 'solid-js'
import { cx } from './cx'

/** Labelled facts as a definition list: "Projects created  3". */
export function StatList(props: {
  items: readonly { label: string; value: JSX.Element }[]
  class?: string
}) {
  return (
    <dl class={cx('grid grid-cols-[auto_1fr] gap-x-6 gap-y-1.5 text-sm', props.class)}>
      <For each={props.items}>
        {(item) => (
          <>
            <dt class="text-fg-muted">{item.label}</dt>
            <dd class="m-0 text-fg tabular-nums">{item.value}</dd>
          </>
        )}
      </For>
    </dl>
  )
}
