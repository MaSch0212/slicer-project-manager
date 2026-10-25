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

describe('isServerAddress', () => {
  // The same table crates/spm-shell/tests/remote_origin.rs checks the Rust parser against.
  it.each(addresses.accepted)('accepts %j', (address) => {
    expect(isServerAddress(address)).toBe(true)
  })
  it.each(addresses.refused)('refuses %j', (address) => {
    expect(isServerAddress(address)).toBe(false)
  })
})
