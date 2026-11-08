/**
 * How wide the project panel is, remembered on this device.
 *
 * **Not a server setting**, unlike the theme or the default view. A panel width is a fact about
 * the screen it is on: the same account on a laptop and on a wide monitor wants two different
 * numbers, and syncing one over the other would be a setting that keeps going wrong. It lives
 * beside the cached theme, in the browser's own storage.
 */
const KEY = 'spm.projectPanelWidth'

export const PANEL_MIN_WIDTH = 320
export const PANEL_MAX_WIDTH = 900
export const PANEL_DEFAULT_WIDTH = 460

/** Inside the bounds, rounded, and the default for anything that is not a number. */
export function clampPanelWidth(value: unknown): number {
  // Numbers and the strings storage hands back, and nothing else: `Number(null)` is 0 and
  // `Number('')` is 0, so a bare `Number(value)` would turn "no width" into the narrowest one.
  const width =
    typeof value === 'number'
      ? value
      : typeof value === 'string' && value.trim() !== ''
        ? Number(value)
        : Number.NaN
  if (!Number.isFinite(width)) return PANEL_DEFAULT_WIDTH
  return Math.round(Math.min(PANEL_MAX_WIDTH, Math.max(PANEL_MIN_WIDTH, width)))
}

/** What was stored, or the default. Storage can be unavailable or hold nonsense; neither throws. */
export function readPanelWidth(): number {
  try {
    const stored = window.localStorage.getItem(KEY)
    return stored === null ? PANEL_DEFAULT_WIDTH : clampPanelWidth(stored)
  } catch {
    return PANEL_DEFAULT_WIDTH
  }
}

/** Remembers it. A refusal (private mode, storage full) costs the user nothing but the memory. */
export function writePanelWidth(width: number): void {
  try {
    window.localStorage.setItem(KEY, String(clampPanelWidth(width)))
  } catch {
    // Not worth telling anyone about: the panel is the width they just dragged it to.
  }
}
