/**
 * A single-line, in-place progress display for the CLI entry points.
 *
 * Two things make this more than a `console.log` in a loop:
 *
 * - **It throttles.** Core reports every file it touches, which for a real library is tens of
 *   thousands of callbacks; redrawing on each one would spend more time writing to the
 *   terminal than hashing.
 * - **It yields to log output.** The live line is written without a newline, so anything else
 *   printing would append to it and leave the half-line stranded. `write` clears the line
 *   first, which is what lets a logger and a progress bar share one terminal.
 *
 * When stdout is not a terminal (a pipe, a file, CI) there is no cursor to move, so it falls
 * back to plain appended lines at a much slower cadence -- a redirected log wants a readable
 * history, not 40,000 copies of the same sentence.
 */
export const TTY_INTERVAL_MS = 100
export const NON_TTY_INTERVAL_MS = 5000

export type Progress = {
  /** Redraw the live line, subject to throttling. `force` bypasses it for a phase change. */
  update(text: string, force?: boolean): void
  /** Erase the live line so something else can print cleanly. Safe to call repeatedly. */
  clear(): void
  /** Erase the live line for good; nothing further is drawn until the next `update`. */
  done(): void
}

export type ProgressDeps = {
  isTerminal: boolean
  write: (text: string) => void
  now: () => number
}

export function createProgress(deps: ProgressDeps): Progress {
  const interval = deps.isTerminal ? TTY_INTERVAL_MS : NON_TTY_INTERVAL_MS
  let lastDrawnAt = -Infinity
  let dirty = false

  const clear = (): void => {
    if (!dirty) return
    // \r returns to column 0 and \x1b[K erases to end of line, so a shorter line never
    // leaves the tail of a longer one behind.
    deps.write('\r\x1b[K')
    dirty = false
  }

  return {
    update(text, force = false) {
      const at = deps.now()
      if (!force && at - lastDrawnAt < interval) return
      lastDrawnAt = at
      if (deps.isTerminal) {
        clear()
        deps.write(text)
        dirty = true
      } else {
        deps.write(`${text}\n`)
      }
    },
    clear,
    done() {
      clear()
      lastDrawnAt = -Infinity
    },
  }
}

/** Writes to Deno's stdout, detecting whether there is a terminal on the other end. */
export function stdoutProgress(): Progress {
  const encoder = new TextEncoder()
  return createProgress({
    isTerminal: Deno.stdout.isTerminal(),
    write: (text) => {
      Deno.stdout.writeSync(encoder.encode(text))
    },
    now: () => Date.now(),
  })
}
