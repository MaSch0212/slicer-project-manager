import { describe, expect, it } from 'vitest'
import { applyTheme, cachedTheme, resolveTheme, themeAttribute } from './theme'

describe('theme resolution', () => {
  it('pins light and dark and leaves system to the OS', () => {
    expect(themeAttribute('light')).toBe('light')
    expect(themeAttribute('dark')).toBe('dark')
    expect(themeAttribute('system')).toBeNull()
  })

  it('resolves system by the OS preference and an explicit theme by itself', () => {
    expect(resolveTheme('system', true)).toBe('dark')
    expect(resolveTheme('system', false)).toBe('light')
    expect(resolveTheme('light', true)).toBe('light')
    expect(resolveTheme('dark', false)).toBe('dark')
  })
})

describe('applyTheme', () => {
  const memory = () => {
    const data = new Map<string, string>()
    return {
      getItem: (key: string) => data.get(key) ?? null,
      setItem: (key: string, value: string) => void data.set(key, value),
    }
  }

  it('sets data-theme for an explicit theme and removes it for system', () => {
    const root = document.createElement('html')
    applyTheme('dark', root, memory())
    expect(root.getAttribute('data-theme')).toBe('dark')
    applyTheme('system', root, memory())
    expect(root.hasAttribute('data-theme')).toBe(false)
  })

  it('caches what it applied so the next load does not flash', () => {
    const storage = memory()
    applyTheme('dark', document.createElement('html'), storage)
    expect(cachedTheme(storage)).toBe('dark')
  })

  it('ignores a junk or unreadable cache', () => {
    expect(cachedTheme({ getItem: () => 'purple' })).toBe('system')
    expect(
      cachedTheme({
        getItem: () => {
          throw new Error('blocked')
        },
      }),
    ).toBe('system')
  })
})
