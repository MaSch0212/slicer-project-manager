import { describe, expect, it } from 'vitest'
import { formatBytes } from './format-bytes'

// Moved from project-detail.page.spec.ts (ruling 72.4): formatBytes is now shared between
// project-detail.page.ts (file sizes) and admin/users.page.ts (disk usage and quotas), so its
// tests live where the implementation does rather than under one of its two callers.
describe('formatBytes', () => {
  it('formats byte counts for humans', () => {
    expect(formatBytes(0)).toBe('0 B')
    expect(formatBytes(2048)).toBe('2.0 kB')
    expect(formatBytes(5 * 1024 * 1024)).toBe('5.0 MB')
  })
})
