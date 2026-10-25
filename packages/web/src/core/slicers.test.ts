import { beforeEach, describe, expect, it, vi } from 'vitest'
import { DETECTION_FAILED, type SlicerConfigDto, type SlicerInstallDto } from '../api/generated'
import { ApiError } from './api/error'
import { classify, createSlicersSettings, defaultOptions, productRows } from './slicers'
import type { SlicersClient } from './slicers'

const install = (id: string, slicerId: SlicerInstallDto['slicerId']): SlicerInstallDto => ({
  id,
  slicerId,
  label: id,
  version: null,
  path: `C:\\${id}.exe`,
  origin: 'manual',
  state: 'ok',
})

const EMPTY: SlicerConfigDto = {
  installs: [],
  bindings: {},
  defaultSlicerId: null,
  detectionSupported: true,
}

function fakeClient(config: SlicerConfigDto = EMPTY, overrides: Partial<SlicersClient> = {}) {
  return {
    get: vi.fn().mockResolvedValue(config),
    scan: vi.fn().mockResolvedValue(config),
    addManual: vi.fn().mockResolvedValue(config),
    remove: vi.fn().mockResolvedValue(config),
    bind: vi.fn().mockResolvedValue(config),
    setDefault: vi.fn().mockResolvedValue(config),
    resetConfig: vi.fn().mockResolvedValue(config),
    ...overrides,
  } as unknown as SlicersClient & Record<string, ReturnType<typeof vi.fn>>
}

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

describe('classify', () => {
  it('reads the failure kind off the code, and the reason off an Internal', () => {
    expect(classify(new ApiError('Forbidden', ''))).toBe('forbidden')
    expect(classify(new ApiError('Conflict', ''))).toBe('conflict')
    expect(classify(new ApiError('NotFound', ''))).toBe('notFound')
    expect(classify(new ApiError('Validation', ''))).toBe('validation')
    expect(classify(new ApiError('Internal', '', { details: { reason: DETECTION_FAILED } }))).toBe(
      'detection',
    )
    expect(classify(new ApiError('Internal', ''))).toBe('generic')
    expect(classify(new ApiError('QuotaExceeded', ''))).toBe('generic')
    expect(classify(new Error('boom'))).toBe('generic')
  })
})

describe('productRows', () => {
  it('lists the five products in the shell order, installed or not', () => {
    expect(productRows(null).map((row) => row.id)).toEqual([
      'cura',
      'prusaslicer',
      'anycubic',
      'bambu',
      'orca',
    ])
  })

  it('asks only when a product has several installs and none bound', () => {
    const two = productRows({
      ...EMPTY,
      installs: [install('a', 'cura'), install('b', 'cura')],
    })
    expect(two[0]).toMatchObject({ mustChoose: true, boundId: null })
    const bound = productRows({
      ...EMPTY,
      installs: [install('a', 'cura'), install('b', 'cura')],
      bindings: { cura: 'b' },
    })
    expect(bound[0]).toMatchObject({ mustChoose: false, boundId: 'b' })
    const one = productRows({ ...EMPTY, installs: [install('a', 'cura')] })
    expect(one[0]).toMatchObject({ mustChoose: false })
  })

  it('offers as a default only the products that have a binding', () => {
    const rows = productRows({
      ...EMPTY,
      installs: [install('a', 'cura'), install('p', 'prusaslicer')],
      bindings: { prusaslicer: 'p' },
    })
    expect(defaultOptions(rows)).toEqual([{ value: 'prusaslicer', label: 'PrusaSlicer' }])
  })
})

describe('createSlicersSettings', () => {
  it('replaces the configuration with whatever the shell answers', async () => {
    const next = { ...EMPTY, installs: [install('a', 'cura')] }
    const settings = createSlicersSettings(fakeClient(next))
    await settings.load()
    expect(settings.config()).toEqual(next)
    expect(settings.failure()).toBeNull()
  })

  it('does not touch the configuration for a cancelled dialog, and is not a failure', async () => {
    const client = fakeClient(EMPTY, { addManual: vi.fn().mockResolvedValue(null) })
    const settings = createSlicersSettings(client)
    await settings.load()
    await settings.addManual('cura')
    expect(settings.config()).toEqual(EMPTY)
    expect(settings.failure()).toBeNull()
  })

  it('drops a second call while one is in flight', async () => {
    let release: (value: SlicerConfigDto) => void = () => {}
    const client = fakeClient(EMPTY, {
      scan: vi.fn().mockReturnValue(new Promise<SlicerConfigDto>((resolve) => (release = resolve))),
    })
    const settings = createSlicersSettings(client)
    const first = settings.rescan()
    expect(settings.busy()).toBe(true)
    await settings.remove('x')
    release(EMPTY)
    await first
    expect(client.remove).not.toHaveBeenCalled()
    expect(settings.busy()).toBe(false)
  })

  it('does not rebind what is bound, unbind what is not, or reset a default to itself', async () => {
    const client = fakeClient({
      ...EMPTY,
      installs: [install('a', 'cura')],
      bindings: { cura: 'a' },
      defaultSlicerId: 'cura',
    })
    const settings = createSlicersSettings(client)
    await settings.load()
    await settings.bind('cura', 'a')
    await settings.unbind('orca')
    await settings.setDefault('cura')
    expect(client.bind).not.toHaveBeenCalled()
    expect(client.setDefault).not.toHaveBeenCalled()
    await settings.unbind('cura')
    expect(client.bind).toHaveBeenCalledWith('cura', null)
  })

  it('offers the reset only for a Conflict, and clears the failure on the next success', async () => {
    const client = fakeClient(EMPTY, {
      scan: vi.fn().mockRejectedValueOnce(new ApiError('Conflict', 'newer')),
    })
    const settings = createSlicersSettings(client)
    await settings.rescan()
    expect(settings.failure()).toBe('conflict')
    expect(settings.offerReset()).toBe(true)
    await settings.reset()
    expect(settings.failure()).toBeNull()
    expect(settings.offerReset()).toBe(false)
  })
})
