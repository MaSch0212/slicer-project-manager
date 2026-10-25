import { createSignal, onCleanup } from 'solid-js'
import { Button } from './button'
import { Check, Copy } from './icons'
import { Input } from './input'

/** How long the button says "copied" before it goes back to "copy". */
const CONFIRM_MS = 2000

/**
 * A read-only value (an activation link) selectable in one click, with a button that copies it.
 * `copyLabel` names the button, `copiedLabel` replaces it for a moment after a copy, and `label` is
 * the field's accessible name. `onCopied` / `onFailed` let the caller say so in its own words (a
 * clipboard can be refused, and then the value is still there to select by hand).
 */
export function CopyField(props: {
  value: string
  label: string
  copyLabel: string
  copiedLabel: string
  onCopied?: () => void
  onFailed?: () => void
}) {
  const [copied, setCopied] = createSignal(false)
  let timer: ReturnType<typeof setTimeout> | undefined
  onCleanup(() => clearTimeout(timer))

  async function copy() {
    try {
      await navigator.clipboard.writeText(props.value)
    } catch {
      props.onFailed?.()
      return
    }
    setCopied(true)
    props.onCopied?.()
    clearTimeout(timer)
    timer = setTimeout(() => setCopied(false), CONFIRM_MS)
  }

  return (
    <div class="flex items-center gap-2">
      <div class="min-w-0 flex-1">
        <Input
          readOnly
          value={props.value}
          aria-label={props.label}
          class="font-mono text-xs"
          onFocus={(event) => event.currentTarget.select()}
        />
      </div>
      <Button icon={copied() ? Check : Copy} onClick={() => void copy()}>
        {copied() ? props.copiedLabel : props.copyLabel}
      </Button>
    </div>
  )
}
