import { cleanup } from '@solidjs/testing-library'
import { afterEach } from 'vitest'

// jsdom has no layout engine; the primitives under the component library read these.
globalThis.ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
}
// Nothing ever intersects here, which is the point: the settings page's section spy falls back to
// "the first section" with no layout to measure, and `pickActive` is tested on its own.
globalThis.IntersectionObserver ??= class {
  readonly root = null
  readonly rootMargin = ''
  readonly thresholds: readonly number[] = []
  observe() {}
  unobserve() {}
  disconnect() {}
  takeRecords() {
    return []
  }
} as unknown as typeof IntersectionObserver
window.matchMedia ??= ((query: string) => ({
  matches: false,
  media: query,
  onchange: null,
  addEventListener() {},
  removeEventListener() {},
  addListener() {},
  removeListener() {},
  dispatchEvent: () => false,
})) as typeof window.matchMedia

afterEach(() => {
  cleanup()
  document.documentElement.removeAttribute('data-theme')
})
