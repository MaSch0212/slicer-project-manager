const UNITS = ['B', 'kB', 'MB', 'GB', 'TB']

/**
 * One shape for every byte count the app shows (file sizes, disk usage, quotas), so two pages
 * cannot drift into rendering the same kind of number differently.
 */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  let value = bytes
  let unit = 0
  while (value >= 1024 && unit < UNITS.length - 1) {
    value /= 1024
    unit++
  }
  return `${value.toFixed(1)} ${UNITS[unit]}`
}
