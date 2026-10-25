import { describe, expect, it } from 'vitest'
import { formatBytes } from './format-bytes'

// Ported from format-bytes.spec.ts, with the boundaries added.
describe('formatBytes', () => {
  it('formats byte counts for humans', () => {
    expect(formatBytes(0)).toBe('0 B')
    expect(formatBytes(1023)).toBe('1023 B')
    expect(formatBytes(2048)).toBe('2.0 kB')
    expect(formatBytes(5 * 1024 * 1024)).toBe('5.0 MB')
    expect(formatBytes(1024 ** 4 * 3)).toBe('3.0 TB')
    expect(formatBytes(1024 ** 5)).toBe('1024.0 TB')
  })
})
