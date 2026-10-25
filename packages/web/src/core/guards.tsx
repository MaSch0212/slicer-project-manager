import { Navigate } from '@solidjs/router'
import { Show, type JSX } from 'solid-js'
import type { Capabilities } from '../api/generated'
import { auth, capabilities } from './stores'

/** What a guard decides: let the visitor through, or send them to a path. */
export type GuardDecision = true | string

export type Session = { isAuthenticated: boolean; isAdmin: boolean }

/**
 * A shell with no sign-in at all (desktop local mode, `requiresAuth: false`) has no session to
 * demand, so nothing may depend on one (parent spec 2.6).
 */
export function authDecision(caps: Capabilities, session: Session): GuardDecision {
  if (!caps.requiresAuth || session.isAuthenticated) return true
  return '/login'
}

export function adminDecision(caps: Capabilities, session: Session): GuardDecision {
  if (caps.canManageUsers && session.isAdmin) return true
  return '/projects'
}

export type CapabilityFlag = Exclude<keyof Capabilities, 'requiresAuth'>

/** A desktop-only surface is reachable only where the capability says it exists. */
export function capabilityDecision(caps: Capabilities, flag: CapabilityFlag): GuardDecision {
  return caps[flag] ? true : '/projects'
}

const session = (): Session => ({
  isAuthenticated: auth.isAuthenticated(),
  isAdmin: auth.isAdmin(),
})

function Guard(props: { decide: () => GuardDecision; children: JSX.Element }) {
  // Reactive on purpose: signing out redirects the page the user is on, with no extra wiring.
  return (
    <Show when={props.decide() === true} fallback={<Navigate href={props.decide() as string} />}>
      {props.children}
    </Show>
  )
}

export function RequireAuth(props: { children: JSX.Element }) {
  return (
    <Guard decide={() => authDecision(capabilities.capabilities(), session())}>
      {props.children}
    </Guard>
  )
}

export function RequireAdmin(props: { children: JSX.Element }) {
  return (
    <Guard
      decide={() => {
        const auth = authDecision(capabilities.capabilities(), session())
        return auth === true ? adminDecision(capabilities.capabilities(), session()) : auth
      }}
    >
      {props.children}
    </Guard>
  )
}

export function RequireCapability(props: {
  flag: CapabilityFlag
  /** Also require a session (default). A page that runs before any library is chosen opts out. */
  authenticated?: boolean
  children: JSX.Element
}) {
  return (
    <Guard
      decide={() => {
        const auth =
          props.authenticated === false
            ? true
            : authDecision(capabilities.capabilities(), session())
        return auth === true ? capabilityDecision(capabilities.capabilities(), props.flag) : auth
      }}
    >
      {props.children}
    </Guard>
  )
}
