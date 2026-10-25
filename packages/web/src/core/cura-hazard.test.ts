import { describe, expect, it } from 'vitest'
import { createCuraHazardStore } from './cura-hazard'

// The legacy store had no spec of its own; its behaviour was exercised through the project page's
// launch tests, which are desktop-only and not ported here (see cura-hazard.ts).
describe('Cura hazard store', () => {
  it('has not been acknowledged until the user says so', () => {
    const store = createCuraHazardStore()
    expect(store.acknowledged()).toBe(false)
    store.acknowledge()
    expect(store.acknowledged()).toBe(true)
  })

  it('is per store, so a new session starts unacknowledged', () => {
    const first = createCuraHazardStore()
    first.acknowledge()
    expect(createCuraHazardStore().acknowledged()).toBe(false)
  })
})
