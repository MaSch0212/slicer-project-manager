const UNITS = ['B', 'kB', 'MB', 'GB', 'TB']

/**
 * Shared by project-detail.page.ts (file sizes) and admin/users.page.ts (disk usage and
 * quotas, ruling 72.4) — extracted from project-detail.page.ts so the two pages cannot drift
 * into rendering the same kind of number in two different shapes.
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
