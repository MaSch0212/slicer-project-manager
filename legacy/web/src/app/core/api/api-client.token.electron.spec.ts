import { TestBed } from '@angular/core/testing'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { HttpApiClient } from './http-api-client'
import { BRIDGE_MISSING, IpcApiClient, UPLOAD_LENGTH_HEADER } from './ipc-api-client'
import { API_CLIENT, desktopMode, proxiedFetch } from './api-client.token.electron'

/**
 * The seam spec 2.6 turns on: which transport the desktop renderer builds its `ApiClient` with.
 *
 * This file is swapped in for `api-client.token.ts` by `fileReplacements` in the electron build
 * only, so nothing in the web bundle reaches it — CI greps both bundles to prove that. It is
 * still worth a unit test, because it is the one place a wrong answer is silent: the app would
 * come up talking IPC to a shell that has no library, or fetching `/api/...` off an origin with
 * no server behind it, and either looks like a backend failure rather than a wiring one.
 */

/**
 * A bridge with the two functions a real preload publishes, so the local branch can actually
 * build its client. `desktopBridge()` checks for both before `IpcApiClient` will construct.
 */
function withBridge(mode: unknown): void {
  ;(globalThis as { spm?: unknown }).spm =
    mode === undefined
      ? undefined
      : {
          mode,
          invoke: () => Promise.resolve({ ok: true, value: null }),
          canStreamFromDisk: () => false,
        }
}

afterEach(() => {
  delete (globalThis as { spm?: unknown }).spm
  vi.restoreAllMocks()
})

describe('desktopMode', () => {
  it('is remote only when the shell said so', () => {
    withBridge('remote')
    expect(desktopMode()).toBe('remote')
  })

  it('is local for every other answer, including no bridge at all', () => {
    // A missing preload has to fall to IPC and not to HTTP: `IpcApiClient` reports the missing
    // bridge as an `AppError` that `CapabilitiesStore` already degrades from, where
    // `HttpApiClient` would fetch `/api/...` off an origin that has no server behind it.
    for (const value of ['local', 'REMOTE', 'unset', '', null, 1]) {
      withBridge(value)
      expect(desktopMode(), String(value)).toBe('local')
    }
    delete (globalThis as { spm?: unknown }).spm
    expect(desktopMode()).toBe('local')
  })
})

describe('API_CLIENT', () => {
  // Resolved through the injector rather than by reaching into the token, because the factory
  // running lazily on the first `inject` is itself part of the contract: it is what makes a
  // missing preload an `AppError` at that point rather than at module evaluation.
  function inject(): unknown {
    TestBed.resetTestingModule()
    TestBed.configureTestingModule({})
    return TestBed.inject(API_CLIENT)
  }

  it('resolves to the HTTP transport in remote mode', () => {
    withBridge('remote')
    expect(inject()).toBeInstanceOf(HttpApiClient)
  })

  it('resolves to the IPC transport in local mode', () => {
    withBridge('local')
    expect(inject()).toBeInstanceOf(IpcApiClient)
  })

  /**
   * What a missing preload actually does, which is not what this file's comment used to claim.
   *
   * It said `CapabilitiesStore.load()` would catch this and fall back to the offline defaults.
   * It cannot: the store takes its client in a field initializer, so the throw happens while the
   * store is being constructed — which `app.config.ts` does in its app initializer, outside
   * `load()`'s `try`. The failure is a blank window, and this pins it rather than the recovery.
   */
  it('throws the missing-bridge error rather than recovering, when there is no preload', () => {
    delete (globalThis as { spm?: unknown }).spm
    expect(() => inject()).toThrowError(BRIDGE_MISSING)
  })
})

describe('proxiedFetch', () => {
  function capture(): { calls: RequestInit[] } {
    const calls: RequestInit[] = []
    vi.stubGlobal('fetch', (_input: string, init: RequestInit = {}) => {
      calls.push(init)
      return Promise.resolve(new Response('{}'))
    })
    return { calls }
  }

  it('declares the size of a Blob body, which is the arm the UI uses', async () => {
    const { calls } = capture()
    await proxiedFetch('/api/projects/p/files', {
      method: 'POST',
      headers: { 'x-spm-file-name': 'a.stl' },
      body: new Blob([new Uint8Array(4096)]),
    })
    const headers = new Headers(calls[0]?.headers)
    expect(headers.get(UPLOAD_LENGTH_HEADER)).toBe('4096')
    // The header the client itself set has to survive alongside it.
    expect(headers.get('x-spm-file-name')).toBe('a.stl')
  })

  it('declares the size a stream body stated, which fetch itself cannot', async () => {
    const { calls } = capture()
    // `HttpApiClient`'s stream arm sets `content-length` explicitly. It is a forbidden header
    // name, so Chromium strips it — but not before this runs, which is the only reason this arm
    // can be covered at all.
    await proxiedFetch('/api/import/curamanager', {
      method: 'POST',
      headers: { 'content-length': '90210' },
      body: new ReadableStream(),
    })
    expect(new Headers(calls[0]?.headers).get(UPLOAD_LENGTH_HEADER)).toBe('90210')
  })

  it('leaves every request that is not an upload exactly as it was', async () => {
    const { calls } = capture()
    await proxiedFetch('/api/capabilities')
    await proxiedFetch('/api/projects', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{"name":"n"}',
    })
    // A JSON string body has a length fetch will work out for itself; declaring one here would be
    // the shell overriding a length it did not measure.
    for (const init of calls) expect(new Headers(init.headers).get(UPLOAD_LENGTH_HEADER)).toBeNull()
  })

  it('ignores a content-length that is not a plain integer', async () => {
    const { calls } = capture()
    await proxiedFetch('/api/x', {
      method: 'POST',
      headers: { 'content-length': '1e3' },
      body: 'x',
    })
    expect(new Headers(calls[0]?.headers).get(UPLOAD_LENGTH_HEADER)).toBeNull()
  })
})
