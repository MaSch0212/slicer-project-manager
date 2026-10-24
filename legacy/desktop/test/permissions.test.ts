import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { Session } from 'electron'
import {
  APP_SESSION_PERMISSIONS,
  applyAppSessionPermissions,
  isAppSessionPermissionAllowed,
} from '../src/permissions.ts'

/**
 * The app's own session (spec 3.7, open question 9.20), as a table rather than as a launch.
 *
 * What Electron actually does with these handlers is not this file's claim and could not be: it is
 * measured against the running shell in `test/shell.spec.ts`, which drives a real
 * `navigator.clipboard.writeText` through a real click and reads `navigator.permissions.query` back.
 * What is here is the half that suite cannot show cheaply — that **both** handlers are installed and
 * that both answer off the same list, so a future edit cannot leave the check handler behind while
 * the request handler tightens.
 *
 * `permissions.ts` imports `electron` for a **type** only, which is erased, so all of it runs under
 * plain `node --test` against the fake below — the same seam `browse/notices.ts` keeps.
 */

type Installed = {
  session: Session
  request: (permission: string) => boolean
  check: (permission: string) => boolean
}

function install(): Installed {
  let requestHandler:
    ((contents: unknown, permission: string, callback: (allowed: boolean) => void) => void) | null =
    null
  let checkHandler: ((contents: unknown, permission: string) => boolean) | null = null
  const session = {
    setPermissionRequestHandler: (handler: typeof requestHandler) => {
      requestHandler = handler
    },
    setPermissionCheckHandler: (handler: typeof checkHandler) => {
      checkHandler = handler
    },
  } as unknown as Session

  applyAppSessionPermissions(session)
  assert.notEqual(requestHandler, null, 'no permission request handler was installed')
  assert.notEqual(checkHandler, null, 'no permission check handler was installed')
  return {
    session,
    request: (permission) => {
      let answer: boolean | null = null
      requestHandler?.(null, permission, (allowed) => {
        answer = allowed
      })
      assert.notEqual(answer, null, 'the request handler never called its callback')
      return answer as unknown as boolean
    },
    check: (permission) => checkHandler?.(null, permission) ?? false,
  }
}

/**
 * The names in the table are the ones the recorder on `defaultSession` actually saw, not a
 * plausible list: `clipboard-sanitized-write` is what Chromium raises for
 * `navigator.clipboard.writeText`, and `clipboard-write` — the spelling the web API uses — is
 * **not** a name that ever arrives. A handler written against it would deny the one thing the app
 * asks for, which is why both spellings are in this assertion.
 */
test('the app session grants the clipboard write it makes and refuses everything else', () => {
  const { request, check } = install()

  assert.equal(request('clipboard-sanitized-write'), true)
  assert.equal(check('clipboard-sanitized-write'), true)

  for (const permission of [
    'clipboard-write',
    'clipboard-read',
    'geolocation',
    'notifications',
    'media',
    'midi',
    'midiSysex',
    'pointerLock',
    'openExternal',
    'web-app-installation',
    'persistent-storage',
  ]) {
    assert.equal(request(permission), false, `request(${permission}) should be refused`)
    assert.equal(check(permission), false, `check(${permission}) should be refused`)
  }
})

/*
 * The check handler is the half a tightening edit forgets, and forgetting it is not free: measured
 * on the browse partition and again on `defaultSession`, with the request handler alone
 * `navigator.permissions.query` still answers `granted` out of an API that raises no request. So
 * this asserts the two answer the same thing for every name, rather than each separately.
 */
test('both handlers answer off the same list, for a granted name and a refused one', () => {
  const { request, check } = install()

  for (const permission of [...APP_SESSION_PERMISSIONS, 'geolocation', 'notifications']) {
    assert.equal(
      request(permission),
      check(permission),
      `the two handlers disagree about ${permission}`,
    )
    assert.equal(request(permission), isAppSessionPermissionAllowed(permission))
  }
})

/*
 * The list itself, pinned. It is an allow-list of one on purpose — a second entry is a capability
 * granted to the app's own session, and this is where that has to be argued for rather than
 * arriving as a diff nobody reads.
 */
test('the allow-list holds exactly the one permission that was measured', () => {
  assert.deepEqual([...APP_SESSION_PERMISSIONS], ['clipboard-sanitized-write'])
})
