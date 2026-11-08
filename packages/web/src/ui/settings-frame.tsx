import { For, Show, type JSX } from 'solid-js'
import { cx } from './cx'

export type SettingsNavItem = { id: string; label: string }

/**
 * The frame of a long settings page: a title bar, a menu of its sections down one side, and the
 * sections themselves scrolling beside it.
 *
 * **Two scroll areas, not one.** The menu is a column of its own with its own overflow, so a
 * long page never scrolls the menu out of reach and the content never has to leave room for it.
 * Below `md` there is no room for a column, so the menu becomes a strip above the content that
 * scrolls sideways.
 */
export function SettingsFrame(props: {
  title: string
  navLabel: string
  items: readonly SettingsNavItem[]
  active: string | null
  onSelect: (id: string) => void
  /** The element that scrolls, and its events, for the section menu to follow the reader. */
  scrollRef: (element: HTMLElement) => void
  onScroll: () => void
  onScrollEnd: () => void
  children: JSX.Element
}) {
  return (
    <div class="flex min-h-0 flex-1 flex-col">
      <header class="flex h-14 shrink-0 items-center border-b border-border px-5">
        <h1 class="text-lg font-semibold tracking-tight text-fg">{props.title}</h1>
      </header>
      <div class="flex min-h-0 flex-1 flex-col md:flex-row">
        <nav
          aria-label={props.navLabel}
          class="shrink-0 overflow-x-auto border-b border-border p-2 md:w-52 md:overflow-x-visible md:overflow-y-auto md:border-r md:border-b-0 md:p-3"
        >
          <ul class="m-0 flex list-none gap-1 p-0 md:flex-col md:gap-0.5">
            <For each={props.items}>
              {(item) => (
                <li>
                  <button
                    type="button"
                    aria-current={props.active === item.id ? 'location' : undefined}
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
        <div
          ref={(element: HTMLDivElement) => props.scrollRef(element)}
          onScroll={() => props.onScroll()}
          on:scrollend={() => props.onScrollEnd()}
          class="relative min-w-0 flex-1 overflow-y-auto p-5"
        >
          <div class="flex max-w-3xl flex-col gap-8">{props.children}</div>
        </div>
      </div>
    </div>
  )
}

/**
 * One block of that page: a heading, a sentence, and the controls, with a rule under it.
 *
 * Deliberately not a card. A page of cards reads as a page of unrelated panels; a rule between
 * blocks says they are parts of one list, which is what settings are.
 */
export function SettingsSection(props: {
  id: string
  ref?: (element: HTMLElement) => void
  title: JSX.Element
  description?: JSX.Element
  class?: string
  children: JSX.Element
}) {
  return (
    <section
      id={props.id}
      ref={props.ref}
      aria-labelledby={`${props.id}-heading`}
      class={cx(
        'flex scroll-mt-5 flex-col gap-4 border-b border-border pb-8 last:border-b-0 last:pb-0',
        props.class,
      )}
    >
      <div class="flex flex-col gap-1">
        <h2 id={`${props.id}-heading`} class="text-base font-semibold tracking-tight text-fg">
          {props.title}
        </h2>
        <Show when={props.description}>
          <p class="text-sm text-fg-muted">{props.description}</p>
        </Show>
      </div>
      {props.children}
    </section>
  )
}

/** A sub-heading inside a section, for a block that needs a name but not a rule of its own. */
export function SettingsGroup(props: {
  title: JSX.Element
  description?: JSX.Element
  children: JSX.Element
}) {
  return (
    <div class="flex flex-col gap-3">
      <div class="flex flex-col gap-0.5">
        <h3 class="text-sm font-semibold text-fg">{props.title}</h3>
        <Show when={props.description}>
          <p class="text-xs text-fg-muted">{props.description}</p>
        </Show>
      </div>
      {props.children}
    </div>
  )
}
