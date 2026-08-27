import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { Capabilities } from '@spm/contract/dtos.ts'
import {
  isCapabilities,
  LOCAL_SHELL_CAPABILITIES,
  REMOTE_SHELL_CAPABILITIES,
  unionCapabilities,
} from '../src/capabilities.ts'

/**
 * Spec 2.4, which is the one part of the capability model a single-mode app never exercises.
 *
 * The columns are asserted **whole**, not flag by flag, for the reason task 4 gave: a later task
 * must not be able to flip one quietly. The union is asserted against the spec's own table, and
 * against the naive answer it would give over a single flat shell column — which is the defect
 * this file exists to prevent.
 */

/**
 * The backend column the Deno server actually publishes, copied from
 * `packages/server/src/routes/capabilities.ts`.
 *
 * Copied rather than imported: `packages/server` is Deno code and this suite runs under
 * `node --test`. `test/remote.spec.ts` closes the loop the copy leaves open — it starts the real
 * server and reads its real `/api/capabilities` through the proxy — so a change on that side
 * fails there rather than passing quietly here.
 */
const SERVER_CAPABILITIES: Capabilities = {
  requiresAuth: true,
  canManageUsers: true,
  canPickLocalFolder: false,
  canLaunchSlicer: false,
  canConfigureSlicers: false,
  canBrowseModelSites: false,
}

test('the shell columns are exactly what spec 2.4 says the shell contributes', () => {
  assert.deepEqual(LOCAL_SHELL_CAPABILITIES, {
    requiresAuth: false,
    canManageUsers: false,
    canPickLocalFolder: true,
    // False until specs D and E ship them, which is a deliberate departure from the spec table:
    // a capability whose feature does not exist lights up UI that goes nowhere.
    canLaunchSlicer: false,
    canConfigureSlicers: false,
    canBrowseModelSites: false,
  })

  assert.deepEqual(REMOTE_SHELL_CAPABILITIES, {
    requiresAuth: false,
    canManageUsers: false,
    // **The one flag that differs, and the whole reason there are two columns.** The library on
    // screen belongs to the server; a "change library folder" control beside it would swap the
    // app to somebody else's library while the page still showed remote data.
    canPickLocalFolder: false,
    canLaunchSlicer: false,
    canConfigureSlicers: false,
    canBrowseModelSites: false,
  })
})

test('local mode is the shell column alone, with no backend to union with', () => {
  // Spec 2.4's second column, minus the three flags specs D and E own. There is no second
  // operand: with no backend, unioning the column with itself would be a no-op that read as if
  // it were doing something.
  assert.deepEqual(LOCAL_SHELL_CAPABILITIES, {
    requiresAuth: false,
    canManageUsers: false,
    canPickLocalFolder: true,
    canLaunchSlicer: false,
    canConfigureSlicers: false,
    canBrowseModelSites: false,
  })
})

test('remote mode is the union, and it is spec 2.4 third column', () => {
  assert.deepEqual(unionCapabilities(REMOTE_SHELL_CAPABILITIES, SERVER_CAPABILITIES), {
    // Contributed by the backend, and a *restriction*: the shell's `false` must not switch off a
    // login screen while every request still comes back 401.
    requiresAuth: true,
    // Contributed by the backend: only a server with user rows can offer this.
    canManageUsers: true,
    // Neither column offers it. Spec 2.4 says `no` for this row.
    canPickLocalFolder: false,
    canLaunchSlicer: false,
    canConfigureSlicers: false,
    canBrowseModelSites: false,
  })
})

/**
 * The defect the union is written to prevent, stated as a test rather than as a paragraph.
 *
 * Union the *local* column with the server's — which is what a shell with one flat capability
 * constant would do, and what this package had until task 5 — and `canPickLocalFolder` comes out
 * true in remote mode, contradicting spec 2.4. The operator is not the mistake; the operand is.
 */
test('unioning the local column with a backend would light up a folder control that must not be', () => {
  const naive = unionCapabilities(LOCAL_SHELL_CAPABILITIES, SERVER_CAPABILITIES)
  assert.equal(naive.canPickLocalFolder, true, 'this is the wrong answer, and it is why')
  assert.equal(
    unionCapabilities(REMOTE_SHELL_CAPABILITIES, SERVER_CAPABILITIES).canPickLocalFolder,
    false,
    'the mode-scoped column is what makes the union right',
  )
})

/**
 * The row spec 2.4 wrote the union for: the Electron app pointed at a remote server needs remote
 * auth *and* local slicer launching at the same time. Nothing ships those three flags yet, so
 * this drives the union with the columns spec D will produce rather than with today's.
 */
test('a backend cannot veto a capability the shell has', () => {
  const withSlicers: Capabilities = {
    ...REMOTE_SHELL_CAPABILITIES,
    canLaunchSlicer: true,
    canConfigureSlicers: true,
    canBrowseModelSites: true,
  }
  assert.deepEqual(unionCapabilities(withSlicers, SERVER_CAPABILITIES), {
    requiresAuth: true,
    canManageUsers: true,
    canPickLocalFolder: false,
    canLaunchSlicer: true,
    canConfigureSlicers: true,
    canBrowseModelSites: true,
  })
})

test('a shell cannot veto a capability the backend has', () => {
  // The mirror of the case above, and the reason `&&` is wrong for the backend-owned flags too.
  assert.equal(
    unionCapabilities(REMOTE_SHELL_CAPABILITIES, SERVER_CAPABILITIES).canManageUsers,
    true,
  )
})

test('a backend answer that is not a capability set is refused rather than unioned', () => {
  assert.equal(isCapabilities(SERVER_CAPABILITIES), true)
  assert.equal(isCapabilities(null), false)
  assert.equal(isCapabilities('{}'), false)
  assert.equal(isCapabilities({}), false)
  // A partial object is the dangerous one: unioned, its missing keys read as `false` and would
  // switch off affordances the shell really has.
  assert.equal(isCapabilities({ requiresAuth: true }), false)
  assert.equal(isCapabilities({ ...SERVER_CAPABILITIES, canManageUsers: 'yes' }), false)
  assert.equal(isCapabilities({ ...SERVER_CAPABILITIES, extra: 1 }), true)
})
