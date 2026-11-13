import { createSignal, createUniqueId, For, Show, type JSX } from 'solid-js'
import { Dynamic } from 'solid-js/web'
import { cx } from './cx'
import { Search, X, type IconComponent } from './icons'
import { MenuTrigger, type MenuEntry, type TriggerProps } from './menu'

/**
 * The bar over a list: search, filters, sort and layout, modelled on Questkeep's. It is a row of
 * its own **outside** what scrolls, so the list moves under it and the controls never leave.
 */
export function Toolbar(props: { label: string; children: JSX.Element; class?: string }) {
  return (
    <div
      role="group"
      aria-label={props.label}
      class={cx(
        'flex h-12 shrink-0 items-center gap-2 border-b border-border px-3 md:px-4',
        props.class,
      )}
    >
      {props.children}
    </div>
  )
}

/** Pushes what follows it to the bar's right end. */
export function ToolbarSpacer() {
  return <div class="min-w-0 flex-1" />
}

const toolClass =
  'inline-flex h-8 shrink-0 items-center justify-center gap-1 rounded-control border border-border bg-surface text-fg-muted transition-colors hover:bg-surface-2 hover:text-fg disabled:pointer-events-none disabled:opacity-50'

/**
 * One square control of the toolbar. With a `badge` above zero it widens to show the number
 * beside the icon — the filter count. `on` marks a control whose state is not the default.
 * When it opens a menu or a popover, `trigger` is that primitive's props, spread last.
 */
export function ToolButton(props: {
  icon: IconComponent
  label: string
  badge?: number
  expanded?: boolean
  on?: boolean
  disabled?: boolean
  onClick?: () => void
  trigger?: TriggerProps
}) {
  const wide = () => (props.badge ?? 0) > 0
  return (
    <button
      type="button"
      aria-label={props.label}
      title={props.label}
      disabled={props.disabled}
      onClick={() => props.onClick?.()}
      class={cx(
        toolClass,
        wide() ? 'px-2' : 'w-8',
        (props.expanded || props.on) && 'bg-surface-2 text-fg',
        props.on && 'border-accent',
      )}
      {...props.trigger}
    >
      <Dynamic component={props.icon} class="size-4" aria-hidden="true" />
      <Show when={wide()}>
        <span
          class="inline-grid h-4 min-w-4 place-items-center rounded-full bg-accent-solid px-1 text-[0.6875rem] leading-none font-semibold text-accent-fg tabular-nums"
          aria-hidden="true"
        >
          {props.badge}
        </span>
      </Show>
    </button>
  )
}

/**
 * The search, as Questkeep draws it: a magnifier the size of the other tools that opens into a
 * field. It stays open while it holds a term (tinted, so a narrowed list never looks complete)
 * and folds away again when it is left empty.
 */
export function ToolbarSearch(props: {
  label: string
  /** The term as the page holds it; the field starts from it. */
  value: string
  onInput: (value: string) => void
  maxLength?: number
  clearLabel: string
}) {
  const [focused, setFocused] = createSignal(false)
  const [draft, setDraft] = createSignal(props.value)
  const open = () => focused() || draft() !== ''
  let input: HTMLInputElement | undefined

  function set(value: string): void {
    setDraft(value)
    props.onInput(value)
  }

  return (
    <div
      class={cx(
        'flex h-8 shrink-0 items-center overflow-hidden rounded-control border transition-[width,background-color,border-color] duration-150',
        open()
          ? 'w-56 border-accent bg-surface'
          : 'w-8 border-border bg-surface hover:bg-surface-2',
        !focused() && draft() !== '' && 'border-border bg-accent-soft',
      )}
    >
      <button
        type="button"
        aria-label={props.label}
        title={props.label}
        tabIndex={open() ? -1 : 0}
        onClick={() => input?.focus()}
        class={cx(
          'grid size-[1.875rem] shrink-0 place-items-center',
          open() ? 'text-accent-text' : 'text-fg-muted',
        )}
      >
        <Search class="size-4" aria-hidden="true" />
      </button>
      <input
        ref={(element) => (input = element)}
        type="search"
        aria-label={props.label}
        placeholder={props.label}
        maxLength={props.maxLength}
        autocomplete="off"
        value={draft()}
        tabIndex={open() ? 0 : -1}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        onInput={(event) => set(event.currentTarget.value)}
        onKeyDown={(event) => {
          if (event.key === 'Escape' && draft() !== '') {
            event.preventDefault()
            set('')
          }
        }}
        class="h-full w-0 min-w-0 flex-1 bg-transparent text-sm text-fg outline-none placeholder:text-fg-muted [&::-webkit-search-cancel-button]:hidden"
      />
      <Show when={open() && draft() !== ''}>
        <button
          type="button"
          aria-label={props.clearLabel}
          title={props.clearLabel}
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => {
            set('')
            input?.focus()
          }}
          class="mr-0.5 grid size-6 shrink-0 place-items-center rounded-xs text-fg-muted hover:bg-surface-2 hover:text-fg"
        >
          <X class="size-3.5" aria-hidden="true" />
        </button>
      </Show>
    </div>
  )
}

/** Grid or list: a pair of square tools, one of them on. A radio group underneath. */
export function ToolToggleGroup<T extends string>(props: {
  label: string
  value: T
  onChange: (value: T) => void
  options: readonly { value: T; label: string; icon: IconComponent }[]
}) {
  const name = createUniqueId()
  return (
    <div role="radiogroup" aria-label={props.label} class="flex shrink-0 gap-1">
      <For each={props.options}>
        {(option) => (
          <label
            title={option.label}
            class={cx(
              toolClass,
              'relative w-8 cursor-pointer has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-accent',
              option.value === props.value && 'border-accent bg-accent-soft text-fg',
            )}
          >
            <input
              type="radio"
              class="absolute inset-0 size-full cursor-pointer opacity-0"
              name={name}
              value={option.value}
              checked={option.value === props.value}
              onChange={() => props.onChange(option.value)}
            />
            <Dynamic component={option.icon} class="size-4" aria-hidden="true" />
            <span class="sr-only">{option.label}</span>
          </label>
        )}
      </For>
    </div>
  )
}

/**
 * The open view has changes it was not saved with: "Unsaved", a way back and a way to keep them,
 * as one tinted group set apart from the filters — the shape the app this follows gives it.
 */
export function ViewChanges(props: {
  /** The group's accessible name: "Unsaved changes to Gadgets". */
  label: string
  text: string
  reset: { label: string; icon: IconComponent; onClick: () => void }
  save: { label: string; icon: IconComponent; items: readonly MenuEntry[] }
}) {
  const action =
    'grid h-full w-8 place-items-center border-l border-warning-border text-fg-muted transition-colors hover:bg-warning-hover hover:text-fg'
  return (
    <div
      role="group"
      aria-label={props.label}
      class="ml-2 flex h-8 shrink-0 items-center overflow-hidden rounded-control border border-warning-border bg-warning-soft"
    >
      <span class="flex items-center gap-2 px-2.5 text-sm whitespace-nowrap text-warning-text">
        <span class="size-1.5 rounded-full bg-warning-text" aria-hidden="true" />
        {props.text}
      </span>
      <button
        type="button"
        aria-label={props.reset.label}
        title={props.reset.label}
        onClick={() => props.reset.onClick()}
        class={action}
      >
        <Dynamic component={props.reset.icon} class="size-4" aria-hidden="true" />
      </button>
      <MenuTrigger label={props.save.label} items={props.save.items}>
        {({ trigger, expanded }) => (
          <button
            type="button"
            aria-label={props.save.label}
            title={props.save.label}
            class={cx(action, expanded && 'bg-warning-hover text-fg')}
            {...trigger}
          >
            <Dynamic component={props.save.icon} class="size-4" aria-hidden="true" />
          </button>
        )}
      </MenuTrigger>
    </div>
  )
}

/** The row of active filters under the toolbar, each one removable, then a way to clear them. */
export function FilterPills(props: { label: string; children: JSX.Element }) {
  return (
    <div
      role="group"
      aria-label={props.label}
      class="flex shrink-0 flex-wrap items-center gap-2 border-b border-border px-3 py-2 md:px-4"
    >
      {props.children}
    </div>
  )
}

export function FilterPill(props: {
  /** What the filter is, "Tag", shown quietly before its value. */
  name?: string
  value: string
  removeLabel: string
  onRemove: () => void
}) {
  return (
    <span class="inline-flex h-7 items-center gap-1 rounded-full border border-accent/40 bg-accent-soft pr-1 pl-3 text-sm text-fg">
      <Show when={props.name}>
        <span class="text-fg-muted">{props.name}:</span>
      </Show>
      <span class="font-semibold">{props.value}</span>
      <button
        type="button"
        aria-label={props.removeLabel}
        title={props.removeLabel}
        onClick={() => props.onRemove()}
        class="grid size-5 place-items-center rounded-full text-fg-muted transition-colors hover:bg-surface-2 hover:text-fg"
      >
        <X class="size-3.5" aria-hidden="true" />
      </button>
    </span>
  )
}

export function FilterPillButton(props: { children: JSX.Element; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={() => props.onClick()}
      class="inline-flex h-7 items-center rounded-full border border-border px-3 text-sm text-fg-muted transition-colors hover:bg-surface-2 hover:text-fg"
    >
      {props.children}
    </button>
  )
}
