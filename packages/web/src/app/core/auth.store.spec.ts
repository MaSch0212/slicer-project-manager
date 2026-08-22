import { TestBed } from '@angular/core/testing'
import type { ApiClient } from '@spm/contract/api-client.ts'
import { AppError } from '@spm/contract/errors.ts'
import type { UserDto } from '@spm/contract/dtos.ts'
import { API_CLIENT } from './api/api-client.token'
import { AuthStore } from './auth.store'

const USER: UserDto = {
  id: 'u1',
  username: 'marc',
  displayName: 'Marc',
  isAdmin: false,
  status: 'active',
  diskUsageBytes: 0,
  quotaBytes: null,
  createdAt: 0,
}

describe('AuthStore', () => {
  it('signs the user out locally even when the server call fails', async () => {
    const api = {
      auth: { logout: () => Promise.reject(new AppError('Internal', 'server is down')) },
    } as unknown as ApiClient
    TestBed.resetTestingModule()
    TestBed.configureTestingModule({ providers: [{ provide: API_CLIENT, useValue: api }] })
    const store = TestBed.inject(AuthStore)
    store.setUser(USER)

    // The failure still has to surface — the caller decides what to tell the user — but the
    // session must not appear to be alive afterwards.
    await expect(store.logout()).rejects.toBeInstanceOf(AppError)
    expect(store.user()).toBeNull()
  })
})
