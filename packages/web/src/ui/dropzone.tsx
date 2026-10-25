import { createSignal, Show, type JSX } from 'solid-js'
import { Dynamic } from 'solid-js/web'
import { Button } from './button'
import { cx } from './cx'
import { Upload, type IconComponent } from './icons'

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
