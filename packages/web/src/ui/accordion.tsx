import { Accordion as KAccordion } from '@kobalte/core/accordion'
import { For, Show, type JSX } from 'solid-js'
import { cx } from './cx'
import { ChevronDown } from './icons'

/**
 * One collapsible card. `summary` is the line the header shows while it is shut, so a shut
 * accordion still answers the question its content would answer ("PrusaSlicer 2.9.0, in Program
 * Files") instead of only naming itself.
 */
export type AccordionEntry = {
  value: string
  title: JSX.Element
  summary?: JSX.Element
  /** Shown at the right end of the header, in both states. Usually a `Badge`. */
  badge?: JSX.Element
  content: JSX.Element
}

/**
 * A stack of collapsible cards, any number of them open at once.
 *
 * Uncontrolled on purpose: `defaultValue` says which start open and the user's clicks own it from
 * there. A caller that recomputed `value` from its own data on every render would shut a card the
 * user had just opened whenever anything else on the page changed.
 */
export function Accordion(props: {
  entries: readonly AccordionEntry[]
  /** The values that start expanded. */
  defaultValue?: readonly string[]
  class?: string
}) {
  return (
    <KAccordion
      multiple
      defaultValue={props.defaultValue ? [...props.defaultValue] : []}
      class={cx('flex flex-col gap-2', props.class)}
    >
      <For each={props.entries}>
        {(entry) => (
          <KAccordion.Item
            value={entry.value}
            class="overflow-hidden rounded-card border border-border bg-surface shadow-card"
          >
            <KAccordion.Header>
              <KAccordion.Trigger class="group flex w-full items-center gap-3 px-4 py-3 text-left transition-colors hover:bg-surface-2">
                <ChevronDown
                  class="size-4 shrink-0 text-fg-muted transition-transform group-data-[expanded]:rotate-180"
                  aria-hidden="true"
                />
                <span class="flex min-w-0 flex-col gap-0.5">
                  <span class="truncate text-sm font-medium text-fg">{entry.title}</span>
                  <Show when={entry.summary}>
                    <span class="truncate text-xs text-fg-muted">{entry.summary}</span>
                  </Show>
                </span>
                <Show when={entry.badge}>
                  <span class="ml-auto shrink-0 pl-2">{entry.badge}</span>
                </Show>
              </KAccordion.Trigger>
            </KAccordion.Header>
            <KAccordion.Content class="border-t border-border">
              <div class="flex flex-col gap-4 px-4 py-4">{entry.content}</div>
            </KAccordion.Content>
          </KAccordion.Item>
        )}
      </For>
    </KAccordion>
  )
}
