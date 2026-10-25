import { describe, expect, it } from 'vitest'
import { createCuraHazardStore } from './cura-hazard'

// The legacy store had no spec of its own; its behaviour was exercised through the project page's
// launch tests. Those are ported as `pages/project-detail-slicers.test.tsx` and
// `core/slicer-launch.test.ts`, which wire this store into the launch flow.
describe('Cura hazard store', () => {
  it('has not been acknowledged until the user says so', () => {
    const store = createCuraHazardStore()
    expect(store.acknowledged()).toBe(false)
    store.acknowledge()
    expect(store.acknowledged()).toBe(true)
  })

  it('can be forgotten, which is what a new session starts from', () => {
    const store = createCuraHazardStore()
    store.acknowledge()
    store.reset()
    expect(store.acknowledged()).toBe(false)
  })

  it('is per store, so a new session starts unacknowledged', () => {
    const first = createCuraHazardStore()
    first.acknowledge()
    expect(createCuraHazardStore().acknowledged()).toBe(false)
  })
})
