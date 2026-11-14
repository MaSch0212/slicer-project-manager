import { createMemo, createSignal, For, Show, type JSX } from 'solid-js'
import { Dynamic } from 'solid-js/web'
import { cx } from './cx'
import { ChevronRight, FileText, Folder, FolderOpen, type IconComponent } from './icons'

/**
 * A text file's contents, as code: monospaced, scrolling both ways, with line numbers. `html` is
 * already-escaped markup (the highlighter's output, or escaped plain text); it is set as HTML.
 */
export function CodeView(props: {
  html: string
  /** How many lines the text has, for the line numbers. */
  lines: number
  label: string
  class?: string
}) {
  const numbers = createMemo(() =>
    Array.from({ length: Math.max(1, props.lines) }, (_, index) => index + 1).join('\n'),
  )
  return (
    <div
      role="region"
      aria-label={props.label}
      tabindex="0"
      class={cx(
        'code-view flex min-h-0 flex-1 overflow-auto bg-surface font-mono text-xs leading-5',
        props.class,
      )}
    >
      <pre
        aria-hidden="true"
        class="sticky left-0 m-0 shrink-0 border-r border-border bg-surface-2 px-3 py-3 text-right text-fg-subtle select-none"
      >
        {numbers()}
      </pre>
      <pre class="m-0 min-w-0 flex-1 px-4 py-3 text-fg">
        <code innerHTML={props.html} />
      </pre>
    </div>
  )
}

/** A notice strip above a preview: "Showing the first 2 MB", "Plain text". */
export function PreviewNotice(props: { children: JSX.Element }) {
  return (
    <div class="shrink-0 border-b border-border bg-surface-2 px-4 py-1.5 text-xs text-fg-muted">
      {props.children}
    </div>
  )
}

/** One entry of a `FileTree`: a folder with children, or a file with a size. */
export interface TreeNode {
  name: string
  /** The full path inside the archive, unique. */
  path: string
  /** Bytes once extracted; folders add up their contents. */
  size: number
  children?: TreeNode[]
}

/**
 * The contents of an archive as a tree of folders and files. Folders open and close; a file is
 * picked with a click (or Enter), when `canOpen` says it can be shown.
 */
export function FileTree(props: {
  label: string
  nodes: readonly TreeNode[]
  selected: string | null
  onSelect: (node: TreeNode) => void
  canOpen: (node: TreeNode) => boolean
  iconOf?: (node: TreeNode) => IconComponent
  /** Folders open from the start (by path); the rest start closed. */
  initiallyOpen?: readonly string[]
  /** A size in words: "1.2 MB". */
  formatSize: (bytes: number) => string
}) {
  const [open, setOpen] = createSignal(new Set(props.initiallyOpen ?? []))
  const toggle = (path: string) =>
    setOpen((current) => {
      const next = new Set(current)
      if (next.has(path)) next.delete(path)
      else next.add(path)
      return next
    })

  const row = (node: TreeNode, depth: number): JSX.Element => {
    const folder = node.children !== undefined
    const expanded = () => open().has(node.path)
    const enabled = () => folder || props.canOpen(node)
    return (
      <li
        role="treeitem"
        aria-expanded={folder ? expanded() : undefined}
        aria-selected={props.selected === node.path}
      >
        <button
          type="button"
          disabled={!enabled()}
          title={node.path}
          onClick={() => (folder ? toggle(node.path) : props.onSelect(node))}
          style={{ 'padding-left': `${0.5 + depth * 1}rem` }}
          class={cx(
            'flex h-7 w-full items-center gap-1.5 rounded-control pr-2 text-left text-sm transition-colors',
            props.selected === node.path
              ? 'bg-accent-soft text-accent-soft-fg'
              : 'text-fg enabled:hover:bg-surface-2',
            !enabled() && 'cursor-default text-fg-muted',
          )}
        >
          <Show when={folder} fallback={<span class="size-3.5 shrink-0" aria-hidden="true" />}>
            <ChevronRight
              class={cx(
                'size-3.5 shrink-0 text-fg-muted transition-transform',
                expanded() && 'rotate-90',
              )}
              aria-hidden="true"
            />
          </Show>
          <Dynamic
            component={
              folder ? (expanded() ? FolderOpen : Folder) : (props.iconOf?.(node) ?? FileText)
            }
            class="size-4 shrink-0 text-fg-muted"
            aria-hidden="true"
          />
          <span class="min-w-0 flex-1 truncate">{node.name}</span>
          <span class="shrink-0 text-xs text-fg-muted tabular-nums">
            {props.formatSize(node.size)}
          </span>
        </button>
        <Show when={folder && expanded()}>
          <ul role="group" class="m-0 list-none p-0">
            <For each={node.children}>{(child) => row(child, depth + 1)}</For>
          </ul>
        </Show>
      </li>
    )
  }

  return (
    <ul role="tree" aria-label={props.label} class="m-0 flex list-none flex-col p-1">
      <For each={props.nodes}>{(node) => row(node, 0)}</For>
    </ul>
  )
}

/** An archive's preview: its tree at the side, the picked entry beside it (stacked when narrow). */
export function PreviewSplit(props: { side: JSX.Element; children: JSX.Element }) {
  return (
    <div class="flex min-h-0 flex-1 flex-col md:flex-row">
      <div class="max-h-[40%] shrink-0 overflow-auto border-b border-border md:max-h-none md:w-80 md:border-r md:border-b-0">
        {props.side}
      </div>
      <div class="flex min-h-0 min-w-0 flex-1 flex-col">{props.children}</div>
    </div>
  )
}

/** A picture, fitted to the space it has, on a quiet ground. */
export function ImageView(props: { src: string; alt: string }) {
  return (
    <div class="flex min-h-0 flex-1 items-center justify-center overflow-auto bg-surface-2 p-4">
      <img src={props.src} alt={props.alt} class="max-h-full max-w-full object-contain" />
    </div>
  )
}

/** A short centred message where a preview would be: why there is none, or what to do. */
export function PreviewMessage(props: {
  icon?: IconComponent
  children: JSX.Element
  action?: JSX.Element
}) {
  return (
    <div class="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 p-6 text-center">
      <Show when={props.icon}>
        {(icon) => (
          <Dynamic
            component={icon()}
            class="size-10 text-fg-subtle"
            stroke-width={1.25}
            aria-hidden="true"
          />
        )}
      </Show>
      <p class="m-0 max-w-md text-sm text-fg-muted">{props.children}</p>
      <Show when={props.action}>{props.action}</Show>
    </div>
  )
}
