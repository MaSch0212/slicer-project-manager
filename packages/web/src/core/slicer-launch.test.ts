import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { FileDto, SlicerConfigDto, SlicerLaunchDto } from '../api/generated'
import { ApiError } from './api/error'
import { createCuraHazardStore } from './cura-hazard'
import type { DesktopClient } from './desktop'
import { setLanguage } from './i18n'
import {
  createSlicerLaunch,
  handedMessage,
  launchErrorMessage,
  resolveLaunchSlicer,
} from './slicer-launch'

const FILE: FileDto = {
  id: 'f1',
  name: 'benchy.stl',
  kind: 'model',
  sizeBytes: 1,
  previewState: 'pending',
  rawUrl: '/x',
}
const CURA_PROJECT: FileDto = {
  ...FILE,
  id: 'f2',
  name: 'bracket.3mf',
  kind: 'slicer_project',
  slicer: 'cura',
}

const CONFIG: SlicerConfigDto = {
  installs: [],
  bindings: { cura: 'a', orca: 'b' },
  defaultSlicerId: 'orca',
  detectionSupported: true,
}
const LAUNCH: SlicerLaunchDto = {
  launchId: 'l',
  slicerId: 'orca',
  installLabel: 'OrcaSlicer',
  stripped: true,
  notices: [],
  pid: null,
}

type Client = DesktopClient['slicers'] & {
  get: ReturnType<typeof vi.fn>
  open: ReturnType<typeof vi.fn>
}

function fakeClient(overrides: Record<string, unknown> = {}): Client {
  return {
    get: vi.fn().mockResolvedValue(CONFIG),
    open: vi.fn().mockResolvedValue(LAUNCH),
    ...overrides,
  } as unknown as Client
}

const enabled = () => true

beforeEach(async () => {
  vi.spyOn(console, 'error').mockImplementation(() => {})
  await setLanguage('en')
})

describe('resolveLaunchSlicer', () => {
  it('prefers what the user chose over everything else', () => {
    expect(resolveLaunchSlicer('as-is', 'cura', 'bambu', 'orca')).toBe('bambu')
    expect(resolveLaunchSlicer('new-project', undefined, 'bambu', 'orca')).toBe('bambu')
  })

  it('uses the slicer the file names for as-is, and the default for a new project', () => {
    expect(resolveLaunchSlicer('as-is', 'cura', null, 'orca')).toBe('cura')
    // The new-project path deliberately does not: its target is usually *not* the product that
    // wrote the file, so defaulting to it would make the common case need an override.
    expect(resolveLaunchSlicer('new-project', 'cura', null, 'orca')).toBe('orca')
  })

  it('falls through to the default, and to nothing when there is not one', () => {
    expect(resolveLaunchSlicer('as-is', undefined, null, 'orca')).toBe('orca')
    expect(resolveLaunchSlicer('as-is', undefined, null, null)).toBeNull()
  })
})

describe('createSlicerLaunch', () => {
  it('loads the configuration only where a launch is possible', async () => {
    const client = fakeClient()
    const off = createSlicerLaunch(
      () => 'p1',
      () => false,
      { client },
    )
    await off.load()
    expect(client.get).not.toHaveBeenCalled()
    expect(off.available()).toBe(false)

    const on = createSlicerLaunch(() => 'p1', enabled, { client })
    expect(on.available()).toBe(false)
    await on.load()
    expect(client.get).toHaveBeenCalledTimes(1)
    expect(on.available()).toBe(true)
    expect(on.options()).toEqual([
      { value: 'cura', label: 'UltiMaker Cura' },
      { value: 'orca', label: 'OrcaSlicer' },
    ])
  })

  it('offers nothing, quietly, when the configuration cannot be read', async () => {
    const client = fakeClient({ get: vi.fn().mockRejectedValue(new ApiError('Conflict', 'newer')) })
    const launch = createSlicerLaunch(() => 'p1', enabled, { client })
    await launch.load()
    expect(launch.available()).toBe(false)
    expect(launch.error()).toBeNull()
  })

  it('names a file by id and a mode, and a slicer only when one was chosen', async () => {
    const client = fakeClient()
    const launch = createSlicerLaunch(() => 'p1', enabled, {
      client,
      hazard: createCuraHazardStore(),
    })
    await launch.load()
    await launch.request(FILE, 'new-project')
    expect(client.open).toHaveBeenCalledWith('f1', 'p1', { mode: 'new-project' })
    launch.setChosen('bambu')
    await launch.request(FILE, 'new-project')
    expect(client.open).toHaveBeenLastCalledWith('f1', 'p1', {
      mode: 'new-project',
      slicerId: 'bambu',
    })
    expect(handedMessage(launch.launched()!)).toBe('Handed benchy.stl to OrcaSlicer (OrcaSlicer)')
  })

  it('holds a Cura launch back until the user answers, and remembers "do not show again"', async () => {
    const client = fakeClient()
    const hazard = createCuraHazardStore()
    const launch = createSlicerLaunch(() => 'p1', enabled, { client, hazard })
    await launch.load()

    await launch.request(CURA_PROJECT, 'as-is')
    expect(client.open).not.toHaveBeenCalled()
    expect(launch.pending()).not.toBeNull()

    await launch.continueCura()
    expect(client.open).toHaveBeenCalledTimes(1)
    expect(hazard.acknowledged()).toBe(false)

    await launch.request(CURA_PROJECT, 'as-is')
    launch.setDontShowAgain(true)
    await launch.continueCura()
    expect(hazard.acknowledged()).toBe(true)

    await launch.request(CURA_PROJECT, 'as-is')
    expect(client.open).toHaveBeenCalledTimes(3)
    expect(launch.pending()).toBeNull()
  })

  it('launches what it warned about, not what the picker says by then', async () => {
    const client = fakeClient()
    const launch = createSlicerLaunch(() => 'p1', enabled, {
      client,
      hazard: createCuraHazardStore(),
    })
    await launch.load()
    launch.setChosen('cura')
    await launch.request(FILE, 'new-project')
    launch.setChosen('bambu')
    await launch.continueCura()
    expect(client.open).toHaveBeenCalledWith('f1', 'p1', { mode: 'new-project', slicerId: 'cura' })
  })

  it('shows the shell sentence for a refusal, and the generic one for anything else', async () => {
    expect(launchErrorMessage(new ApiError('Validation', 'Cura cannot open STEP files.'))).toBe(
      'Cura cannot open STEP files.',
    )
    expect(launchErrorMessage(new Error('boom'))).toBe('Something went wrong')
    const client = fakeClient({
      open: vi.fn().mockRejectedValue(new ApiError('Conflict', 'pick one')),
    })
    const launch = createSlicerLaunch(() => 'p1', enabled, {
      client,
      hazard: createCuraHazardStore(),
    })
    await launch.load()
    await launch.request(FILE, 'new-project')
    expect(launch.error()).toBe('pick one')
    expect(launch.launched()).toBeNull()
    launch.dismissError()
    expect(launch.error()).toBeNull()
  })
})
