import { createSignal, Show, type JSX } from 'solid-js'
import { Dynamic } from 'solid-js/web'
import { Button } from './button'
import { cx } from './cx'
import { IconButton } from './icon-button'
import { Plus, Upload, type IconComponent } from './icons'

/**
 * A place to drop files, with a button for people who would rather pick them. Reports the files
 * as a plain array and nothing else: what to do with them (validate, upload, queue) is the page's.
 * A drag that carries no files (text, a link) is ignored, so dragging a selection across the page
 * never lights it up.
 */
export function DropZone(props: {
  onFiles: (files: File[]) => void
  /** The sentence inside the zone: "Drop files here". */
  label: string
  buttonLabel: string
  hint?: JSX.Element
  accept?: string
  multiple?: boolean
  disabled?: boolean
  icon?: IconComponent
  class?: string
}) {
  const [over, setOver] = createSignal(false)
  let input: HTMLInputElement | undefined

  const carriesFiles = (event: DragEvent) =>
    Array.from(event.dataTransfer?.types ?? []).includes('Files')

  function take(list: FileList | null | undefined): void {
    const files = Array.from(list ?? [])
    if (files.length > 0) props.onFiles(props.multiple === false ? files.slice(0, 1) : files)
  }

  return (
    <div
      class={cx(
        'flex flex-col items-center gap-3 rounded-card border border-dashed px-4 py-6 text-center transition-colors',
        over() ? 'border-accent bg-accent-soft' : 'border-border-input bg-surface',
        props.disabled && 'opacity-50',
        props.class,
      )}
      onDragEnter={(event) => {
        if (props.disabled || !carriesFiles(event)) return
        event.preventDefault()
        setOver(true)
      }}
      onDragOver={(event) => {
        if (props.disabled || !carriesFiles(event)) return
        // Without this the browser opens the file instead of dropping it here.
        event.preventDefault()
        setOver(true)
      }}
      onDragLeave={(event) => {
        // Moving onto a child fires leave on the parent; only leaving the zone itself counts.
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setOver(false)
      }}
      onDrop={(event) => {
        if (props.disabled || !carriesFiles(event)) return
        event.preventDefault()
        setOver(false)
        take(event.dataTransfer?.files)
      }}
    >
      <Dynamic component={props.icon ?? Upload} class="size-6 text-fg-muted" aria-hidden="true" />
      <p class="text-sm text-fg">{props.label}</p>
      <Show when={props.hint}>
        <p class="text-xs text-fg-muted">{props.hint}</p>
      </Show>
      <Button
        variant="secondary"
        size="sm"
        disabled={props.disabled}
        onClick={() => input?.click()}
      >
        {props.buttonLabel}
      </Button>
      <input
        ref={(el) => (input = el)}
        type="file"
        class="hidden"
        tabindex="-1"
        accept={props.accept}
        multiple={props.multiple !== false}
        disabled={props.disabled}
        onChange={(event) => {
          take(event.currentTarget.files)
          // The same file picked twice in a row must still fire a change.
          event.currentTarget.value = ''
        }}
      />
    </div>
  )
}

/**
 * A region that takes dropped files without showing a drop zone until there is something to drop.
 * The dashed target appears over the region only while files are being dragged across it — the
 * big empty box that used to sit there permanently said nothing the "+" button does not.
 *
 * Counted rather than flagged: entering a child fires `dragenter` on it before `dragleave` on the
 * parent, so a flag flickers off at every child border. A drag that carries no files (a selection,
 * a link) never lights it up.
 */
export function DropTarget(props: {
  onFiles: (files: File[]) => void
  /** What the target says while files are over it: "Drop to add them to this project". */
  label: string
  disabled?: boolean
  class?: string
  children: JSX.Element
}) {
  const [depth, setDepth] = createSignal(0)
  const carriesFiles = (event: DragEvent) =>
    Array.from(event.dataTransfer?.types ?? []).includes('Files')
  const ignore = (event: DragEvent) => props.disabled || !carriesFiles(event)

  return (
    <div
      class={cx('relative', props.class)}
      onDragEnter={(event) => {
        if (ignore(event)) return
        event.preventDefault()
        setDepth((count) => count + 1)
      }}
      onDragOver={(event) => {
        if (ignore(event)) return
        // Without this the browser opens the file instead of dropping it here.
        event.preventDefault()
        if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy'
      }}
      onDragLeave={(event) => {
        if (ignore(event)) return
        setDepth((count) => Math.max(0, count - 1))
      }}
      onDrop={(event) => {
        if (ignore(event)) return
        event.preventDefault()
        setDepth(0)
        const files = Array.from(event.dataTransfer?.files ?? [])
        if (files.length > 0) props.onFiles(files)
      }}
    >
      {props.children}
      <Show when={depth() > 0}>
        <div class="pointer-events-none absolute inset-2 z-20 flex flex-col items-center justify-center gap-2 rounded-card border-2 border-dashed border-accent bg-accent-soft px-4 text-center animate-fade">
          <Upload class="size-6 text-accent-text" aria-hidden="true" />
          <p class="text-sm font-medium text-fg">{props.label}</p>
        </div>
      </Show>
    </div>
  )
}

/** An icon button that opens the system's file picker and hands back what was picked. */
export function FilePickButton(props: {
  label: string
  onFiles: (files: File[]) => void
  icon?: IconComponent
  disabled?: boolean
  multiple?: boolean
  accept?: string
}) {
  let input: HTMLInputElement | undefined
  return (
    <>
      <IconButton
        icon={props.icon ?? Plus}
        label={props.label}
        disabled={props.disabled}
        onClick={() => input?.click()}
      />
      <input
        ref={(el) => (input = el)}
        type="file"
        class="hidden"
        tabindex="-1"
        accept={props.accept}
        multiple={props.multiple !== false}
        disabled={props.disabled}
        onChange={(event) => {
          const files = Array.from(event.currentTarget.files ?? [])
          if (files.length > 0) props.onFiles(files)
          // The same file picked twice in a row must still fire a change.
          event.currentTarget.value = ''
        }}
      />
    </>
  )
}
