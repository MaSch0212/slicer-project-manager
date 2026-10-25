import { Tabs as KTabs } from '@kobalte/core/tabs'
import { For, type JSX } from 'solid-js'
import { cx } from './cx'

export type TabItem = { value: string; label: string; disabled?: boolean }

/**
 * Tabs: a row of triggers and, as children, one `TabPanel` per tab. Arrow keys move between
 * triggers; the active trigger carries the accent underline.
 */
export function Tabs(props: {
  items: readonly TabItem[]
  value?: string
  defaultValue?: string
  onChange?: (value: string) => void
  /** The accessible name of the tab list. */
  label?: string
  class?: string
  children?: JSX.Element
}) {
  return (
    <KTabs
      value={props.value}
      defaultValue={props.defaultValue ?? props.items[0]?.value}
      onChange={props.onChange}
      class={props.class}
    >
      <KTabs.List
        aria-label={props.label}
        class="flex gap-1 overflow-x-auto border-b border-border"
      >
        <For each={props.items}>
          {(item) => (
            <KTabs.Trigger
              value={item.value}
              disabled={item.disabled}
              class="-mb-px h-10 shrink-0 border-b-2 border-transparent px-3 text-sm font-medium whitespace-nowrap text-fg-muted transition-colors hover:text-fg disabled:opacity-50 data-[selected]:border-accent data-[selected]:text-fg"
            >
              {item.label}
            </KTabs.Trigger>
          )}
        </For>
      </KTabs.List>
      {props.children}
    </KTabs>
  )
}

export function TabPanel(props: { value: string; class?: string; children: JSX.Element }) {
  return (
    <KTabs.Content value={props.value} class={cx('pt-4', props.class)}>
      {props.children}
    </KTabs.Content>
  )
}
