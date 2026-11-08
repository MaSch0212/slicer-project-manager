import { For } from 'solid-js'
import { cx } from './cx'

export type SectionNavItem = { id: string; label: string }

/**
 * The menu beside a long page: one entry per section, the one you are reading marked.
 *
 * It is a list of buttons, not links: choosing a section scrolls the page, it does not navigate,
 * so there is no history entry and the browser's back button still means "the page before this
 * one". The page owns which entry is current (see `core/section-spy.ts`); this only draws it.
 *
 * From `md` up it is a column that sticks beside the content. Below that it is a horizontal strip
 * that scrolls sideways, pinned under the page title — a phone has no room for a second column,
 * and a long settings page with no index at all is the thing this exists to prevent.
 */
export function SectionNav(props: {
  label: string
  items: readonly SectionNavItem[]
  active: string | null
  onSelect: (id: string) => void
  class?: string
}) {
  return (
    <nav
      aria-label={props.label}
      class={cx(
        'sticky top-[var(--chrome-top)] z-10 -mx-4 shrink-0 overflow-x-auto bg-bg px-4 py-2 md:top-[calc(var(--chrome-top)+1.5rem)] md:mx-0 md:w-48 md:self-start md:overflow-visible md:bg-transparent md:px-0 md:py-0',
        props.class,
      )}
    >
      <ul class="m-0 flex list-none gap-1 p-0 md:flex-col md:gap-0.5">
        <For each={props.items}>
          {(item) => (
            <li>
              <button
                type="button"
                aria-current={props.active === item.id ? 'true' : undefined}
                onClick={() => props.onSelect(item.id)}
                class="flex h-8 w-full items-center rounded-control px-2.5 text-sm font-medium whitespace-nowrap text-fg-muted transition-colors hover:bg-surface-2 hover:text-fg aria-[current]:bg-surface-2 aria-[current]:text-fg"
              >
                {item.label}
              </button>
            </li>
          )}
        </For>
      </ul>
    </nav>
  )
}
