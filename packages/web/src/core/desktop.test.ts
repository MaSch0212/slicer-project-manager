import { describe, expect, it, vi } from 'vitest'
import { ApiError } from './api/error'
import { createDesktopClient, isDesktop } from './desktop'
import addresses from './server-addresses.json'
import { isServerAddress } from './validation'

describe('isDesktop', () => {
  it('is false in a browser, where there is no Tauri bridge', () => {
    expect(isDesktop()).toBe(false)
  })
})

describe('the desktop client', () => {
  it('names each command exactly as the shell registers it, and passes no path', async () => {
    const invoke = vi.fn().mockResolvedValue(null)
    const client = createDesktopClient(invoke)
    await client.libraryState()
    await client.pickFolder()
    await client.connectRemote('https://print.example.com')
    await client.chooseLibrary()
    expect(invoke.mock.calls).toEqual([
      ['desktop_library_state', undefined],
      ['desktop_library_pick', undefined],
      ['desktop_library_connect', { url: 'https://print.example.com' }],
      ['desktop_library_choose', undefined],
    ])
  })

  it('rebuilds the shell error ({ code, message }) as the one ApiError every call rejects with', async () => {
    const client = createDesktopClient(() =>
      Promise.reject({ code: 'Validation', message: 'not a URL: x' }),
    )
    const error = await client.connectRemote('x').catch((e: unknown) => e)
    expect(error).toBeInstanceOf(ApiError)
    expect(error).toMatchObject({ code: 'Validation', message: 'not a URL: x' })
  })

  it('turns a refusal that is only a string (an ACL "not allowed") into an Internal error', async () => {
    const client = createDesktopClient(() => Promise.reject('desktop_library_pick not allowed'))
    const error = await client.pickFolder().catch((e: unknown) => e)
    expect(error).toBeInstanceOf(ApiError)
    expect(error).toMatchObject({ code: 'Internal' })
  })

  it('does not trust an unknown error code from the other side', async () => {
    const client = createDesktopClient(() => Promise.reject({ code: 'Nope', message: 'x' }))
    const error = await client.pickFolder().catch((e: unknown) => e)
    expect(error).toMatchObject({ code: 'Internal' })
  })
})

describe('the slicer commands', () => {
  it('names each command as the shell registers it, with ids and values and never a path', async () => {
    const invoke = vi.fn().mockResolvedValue(null)
    const { slicers } = createDesktopClient(invoke)
    await slicers.get()
    await slicers.scan()
    await slicers.addManual('cura')
    await slicers.remove('registry:HKLM:Cura')
    await slicers.bind('cura', 'registry:HKLM:Cura')
    await slicers.bind('cura', null)
    await slicers.setDefault('orca')
    await slicers.setDefault(null)
    await slicers.resetConfig()
    await slicers.open('f1', 'p1', { mode: 'new-project', slicerId: 'bambu' })
    await slicers.open('f2', 'p1', { mode: 'as-is' })
    await slicers.sessions()
    await slicers.resolveSession('l1', 'import', { projectId: 'p1' })
    await slicers.resolveSession('l2', 'discard')
    await slicers.discardSessions(['a', 'b'])
    expect(invoke.mock.calls).toEqual([
      ['desktop_slicers_get', undefined],
      ['desktop_slicers_scan', undefined],
      ['desktop_slicers_add_manual', { slicerId: 'cura' }],
      ['desktop_slicers_remove', { installId: 'registry:HKLM:Cura' }],
      ['desktop_slicers_bind', { slicerId: 'cura', installId: 'registry:HKLM:Cura' }],
      // `null` is "unbind", and it is sent: an absent key is a different (refused) request.
      ['desktop_slicers_bind', { slicerId: 'cura', installId: null }],
      ['desktop_slicers_set_default', { slicerId: 'orca' }],
      ['desktop_slicers_set_default', { slicerId: null }],
      ['desktop_slicers_reset_config', undefined],
      [
        'desktop_slicers_open',
        { fileId: 'f1', projectId: 'p1', opts: { mode: 'new-project', slicerId: 'bambu' } },
      ],
      ['desktop_slicers_open', { fileId: 'f2', projectId: 'p1', opts: { mode: 'as-is' } }],
      ['desktop_slicers_sessions', undefined],
      ['desktop_slicers_resolve_session', { launchId: 'l1', action: 'import', projectId: 'p1' }],
      ['desktop_slicers_resolve_session', { launchId: 'l2', action: 'discard', projectId: null }],
      ['desktop_slicers_discard_sessions', { launchIds: ['a', 'b'] }],
    ])
  })

  it('keeps the details of a shell error, because a reason can be all that tells two apart', async () => {
    const { slicers } = createDesktopClient(() =>
      Promise.reject({
        code: 'Internal',
        message: 'could not look for slicers installed on this machine',
        details: { reason: 'detection-failed', cause: 'ETIMEDOUT' },
      }),
    )
    const error = await slicers.scan().catch((e: unknown) => e)
    expect(error).toBeInstanceOf(ApiError)
    expect(error).toMatchObject({
      code: 'Internal',
      details: { reason: 'detection-failed', cause: 'ETIMEDOUT' },
    })
  })
})

describe('isServerAddress', () => {
  // The same table crates/spm-shell/tests/remote_origin.rs checks the Rust parser against.
  it.each(addresses.accepted)('accepts %j', (address) => {
    expect(isServerAddress(address)).toBe(true)
  })
  it.each(addresses.refused)('refuses %j', (address) => {
    expect(isServerAddress(address)).toBe(false)
  })
})
