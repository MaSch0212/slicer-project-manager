import { inject } from '@angular/core'
import { Router, type CanActivateFn } from '@angular/router'
import { AuthStore } from './auth.store'
import { CapabilitiesStore } from './capabilities.store'

export const authGuard: CanActivateFn = () => {
  const capabilities = inject(CapabilitiesStore).capabilities()
  const auth = inject(AuthStore)
  // In Electron local mode requiresAuth is false and there is no session at all (spec 2.6).
  if (!capabilities.requiresAuth || auth.isAuthenticated()) return true
  return inject(Router).createUrlTree(['/login'])
}

export const adminGuard: CanActivateFn = () => {
  const capabilities = inject(CapabilitiesStore).capabilities()
  const auth = inject(AuthStore)
  if (capabilities.canManageUsers && auth.isAdmin()) return true
  return inject(Router).createUrlTree(['/projects'])
}
