import { Injectable, computed, inject, signal } from '@angular/core'
import type { UserDto } from '@spm/contract/dtos.ts'
import { API_CLIENT } from './api/api-client.token'

@Injectable({ providedIn: 'root' })
export class AuthStore {
  private readonly api = inject(API_CLIENT)
  private readonly state = signal<UserDto | null>(null)

  readonly user = this.state.asReadonly()
  readonly isAuthenticated = computed(() => this.state() !== null)
  readonly isAdmin = computed(() => this.state()?.isAdmin === true)

  setUser(user: UserDto | null): void {
    this.state.set(user)
  }

  async refresh(): Promise<void> {
    try {
      this.state.set(await this.api.account.me())
    } catch {
      // A 401 at bootstrap is the normal "not logged in yet" case.
      this.state.set(null)
    }
  }

  async logout(): Promise<void> {
    await this.api.auth.logout()
    this.state.set(null)
  }
}
