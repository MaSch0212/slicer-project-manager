import { cleanup } from '@solidjs/testing-library'
import { afterEach } from 'vitest'

// jsdom has no layout engine; the primitives under the component library read these.
globalThis.ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
}
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
