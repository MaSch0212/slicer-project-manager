import { For, Show, type JSX } from 'solid-js'
import { cx } from './cx'
import { Globe, Plus, X } from './icons'
import { Spinner } from './spinner'

export type BrowserTab = {
  id: string
  /** The page's own title, or its host: a stranger's string, so it is text and it is bounded. */
  label: string
  loading?: boolean
}

/**
 * The strip of open sites at the top of the model browser.
 *
 * It looks like a browser's because it is one: a row of tabs with the front one lifted onto the
 * view's own background, a close on each, and one control that opens another. The `+` is
 * disabled at the cap rather than left to fail, because each tab is a live webview and the limit
 * is a real one.
 */
export function BrowserTabStrip(props: {
  label: string
  tabs: readonly BrowserTab[]
  activeId: string | null
  canOpenMore: boolean
  labels: { newTab: string; atCap: string; close: string; loading: string }
  onSelect: (id: string) => void
  onClose: (id: string) => void
  onOpen: () => void
}) {
  return (
    <div
      role="tablist"
      aria-label={props.label}
      aria-orientation="horizontal"
      class="flex h-9 shrink-0 items-end gap-0.5 overflow-x-auto border-b border-border bg-surface-2 px-1.5 pt-1.5"
    >
      <For each={props.tabs}>
        {(tab) => {
          const current = () => tab.id === props.activeId
          return (
            <div
              class={cx(
                'group flex h-8 min-w-0 shrink-0 items-center gap-2 rounded-t-popover pr-1 pl-2.5 text-sm transition-colors',
                current() ? 'bg-bg text-fg' : 'text-fg-muted hover:bg-surface-3 hover:text-fg',
              )}
            >
              <button
                type="button"
                role="tab"
                aria-selected={current()}
                onClick={() => props.onSelect(tab.id)}
                class="flex min-w-0 max-w-40 items-center gap-2"
              >
                <Show
                  when={tab.loading}
                  fallback={<Globe class="size-3.5 shrink-0" aria-hidden="true" />}
                >
                  <Spinner size="sm" label={props.labels.loading} />
                </Show>
                <span class="truncate">{tab.label}</span>
              </button>
              <button
                type="button"
                aria-label={`${props.labels.close} ${tab.label}`}
                onClick={() => props.onClose(tab.id)}
                class="flex size-5 shrink-0 items-center justify-center rounded-xs text-fg-muted transition-colors hover:bg-surface-3 hover:text-fg"
              >
                <X class="size-3" aria-hidden="true" />
              </button>
            </div>
          )
        }}
      </For>
      <button
        type="button"
        disabled={!props.canOpenMore}
        aria-label={props.canOpenMore ? props.labels.newTab : props.labels.atCap}
        onClick={() => props.onOpen()}
        class="mb-1 flex size-6 shrink-0 items-center justify-center rounded-control text-fg-muted transition-colors hover:bg-surface-3 hover:text-fg disabled:text-fg-subtle disabled:hover:bg-transparent"
      >
        <Plus class="size-4" aria-hidden="true" />
      </button>
    </div>
  )
}

/**
 * The row under the tabs: history, the address and the start-site picker. A `form`, so Enter in
 * the address goes somewhere.
 */
export function BrowserChrome(props: {
  label: string
  onSubmit: (event: SubmitEvent) => void
  children: JSX.Element
}) {
  return (
    <form
      class="flex shrink-0 items-center gap-2 border-b border-border px-2 py-1.5"
      aria-label={props.label}
      onSubmit={props.onSubmit}
    >
      {props.children}
    </form>
  )
}

/** A strip of the app's own words between the chrome and the view, for what it has to say. */
export function BrowserNotice(props: { children: JSX.Element }) {
  return <div class="shrink-0 px-3 py-2">{props.children}</div>
}

/**
 * The panel under the view: what has been downloaded and what the app has to say about it. It
 * takes a bounded share of the window and scrolls, so a long list never squeezes the site out.
 */
export function BrowserPanel(props: { label: string; children: JSX.Element }) {
  return (
    <section
      class="max-h-64 shrink-0 overflow-y-auto border-t border-border px-3 py-3"
      aria-label={props.label}
    >
      <div class="flex flex-col gap-3">{props.children}</div>
    </section>
  )
}
