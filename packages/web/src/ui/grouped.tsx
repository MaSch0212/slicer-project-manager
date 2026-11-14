import { For, Show, type JSX } from 'solid-js'
import { cx } from './cx'
import { ChevronRight, Layers } from './icons'

/**
 * The parts of a grouped list, as Questkeep draws them: a header band per group that folds it
 * away and stays pinned at the top while its group scrolls under it, the list of items itself
 * (tiles, or rows with rules between them), and optionally the groups listed beside it so one can
 * be picked.
 */

/** Tiles or rows. */
export type ItemLayout = 'grid' | 'list'

/**
 * The items of a list or of one group. A grid of tiles at least `tile` wide, or rows divided by a
 * rule with no gap and no card around each: a list is for scanning many at once, and cards with
 * margins made each row twice the height its two lines of text need.
 */
export function ItemList(props: {
  layout: ItemLayout
  /** The smallest a tile gets in the grid. */
  tile?: 'sm' | 'md'
  label?: string
  busy?: boolean
  children: JSX.Element
}) {
  return (
    <ul
      aria-label={props.label}
      aria-busy={props.busy ? 'true' : undefined}
      class={cx(
        'm-0 list-none p-0',
        props.layout === 'grid'
          ? cx(
              'grid gap-4',
              props.tile === 'sm'
                ? 'grid-cols-[repeat(auto-fill,minmax(10rem,1fr))] gap-3'
                : 'grid-cols-[repeat(auto-fill,minmax(13rem,1fr))]',
            )
          : 'flex flex-col divide-y divide-border border-y border-border',
      )}
    >
      {props.children}
    </ul>
  )
}

/**
 * A group's header band: chevron, name and a count. Click to fold the group away or open it.
 * Sticky, so the group being read is always named at the top of the scroller; the next group's
 * header pushes it up as it arrives, because each header only sticks within its own group.
 */
export function GroupHeader(props: {
  label: string
  count: number
  collapsed: boolean
  onToggle: () => void
  /** The accessible name, which also says what clicking does. */
  toggleLabel: string
  /** Heading level, so a screen reader can jump between groups. */
  level?: 2 | 3 | 4
}) {
  return (
    <div
      role="heading"
      aria-level={props.level ?? 3}
      class="sticky top-0 z-10 -mx-1 bg-bg/95 px-1 py-1 backdrop-blur-sm"
    >
      <button
        type="button"
        aria-expanded={!props.collapsed}
        title={props.toggleLabel}
        onClick={() => props.onToggle()}
        class="group flex h-8 w-full items-center gap-2 rounded-control px-1.5 text-left text-sm font-semibold text-fg transition-colors hover:bg-surface-2"
      >
        <ChevronRight
          class={cx(
            'size-4 shrink-0 text-fg-muted transition-transform',
            !props.collapsed && 'rotate-90',
          )}
          aria-hidden="true"
        />
        <span class="min-w-0 truncate">{props.label}</span>
        <span class="inline-grid h-5 min-w-5 place-items-center rounded-full bg-surface-3 px-1.5 text-xs font-medium text-fg-muted tabular-nums">
          {props.count}
        </span>
      </button>
    </div>
  )
}

/** One group in a grouped list: its header, and its items unless it is folded away. */
export function GroupSection(props: {
  label: string
  count: number
  collapsed: boolean
  onToggle: () => void
  toggleLabel: string
  level?: 2 | 3 | 4
  children: JSX.Element
}) {
  return (
    <section class="flex flex-col gap-2">
      <GroupHeader
        label={props.label}
        count={props.count}
        collapsed={props.collapsed}
        onToggle={props.onToggle}
        toggleLabel={props.toggleLabel}
        level={props.level}
      />
      <Show when={!props.collapsed}>{props.children}</Show>
    </section>
  )
}

export type GroupListOption = { key: string; label: string; count: number }

/**
 * The groups beside the list, so one can be picked: "All groups" first, then each group with its
 * count. Up and Down move through it and the list follows at once.
 */
export function GroupList(props: {
  label: string
  allLabel: string
  total: number
  groups: readonly GroupListOption[]
  /** The picked group's key; null is "all groups". */
  value: string | null
  onChange: (key: string | null) => void
}) {
  let list: HTMLUListElement | undefined
  const keys = () => [null, ...props.groups.map((group) => group.key)]
  const index = () => Math.max(0, keys().indexOf(props.value))

  function onKeyDown(event: KeyboardEvent) {
    const all = keys()
    const next =
      event.key === 'ArrowDown'
        ? Math.min(all.length - 1, index() + 1)
        : event.key === 'ArrowUp'
          ? Math.max(0, index() - 1)
          : event.key === 'Home'
            ? 0
            : event.key === 'End'
              ? all.length - 1
              : null
    if (next === null) return
    event.preventDefault()
    props.onChange(all[next] ?? null)
    list
      ?.querySelector<HTMLElement>(`[data-group-index="${next}"]`)
      ?.scrollIntoView?.({ block: 'nearest' })
  }

  const option = (key: string | null, label: string, count: number, at: number, icon = false) => (
    <li
      id={`group-option-${at}`}
      data-group-index={at}
      role="option"
      aria-selected={props.value === key}
      title={label}
      onClick={() => props.onChange(key)}
      class={cx(
        'flex h-8 cursor-pointer items-center gap-2 rounded-control px-2 text-sm transition-colors',
        props.value === key
          ? 'bg-accent-soft text-accent-soft-fg'
          : 'text-fg-muted hover:bg-surface-2 hover:text-fg',
      )}
    >
      <Show when={icon}>
        <Layers class="size-4 shrink-0" aria-hidden="true" />
      </Show>
      <span class="min-w-0 flex-1 truncate">{label}</span>
      <span class="shrink-0 text-xs tabular-nums">{count}</span>
    </li>
  )

  return (
    <nav
      aria-label={props.label}
      class="flex w-52 shrink-0 flex-col overflow-y-auto border-r border-border p-2"
    >
      <ul
        ref={(element) => (list = element)}
        role="listbox"
        aria-label={props.label}
        aria-activedescendant={`group-option-${index()}`}
        tabindex="0"
        onKeyDown={onKeyDown}
        class="m-0 flex list-none flex-col gap-0.5 rounded-control p-0"
      >
        {option(null, props.allLabel, props.total, 0, true)}
        <For each={props.groups}>
          {(group, at) => option(group.key, group.label, group.count, at() + 1)}
        </For>
      </ul>
    </nav>
  )
}
