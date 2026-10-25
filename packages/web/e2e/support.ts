import { expect, test, type Page } from '@playwright/test'
import { applySession, startServer, type SeededServer, type StartOptions } from './seed'

/** A cold `cargo run` compiles the server first, so the hook that starts it gets a long budget. */
const SERVER_START_TIMEOUT_MS = 420_000

export type ServerState<T> = { server: SeededServer; seeded: T }

/**
 * One real `spm-server` over a throwaway library for the spec file that calls this, started before
 * its first test and stopped (library deleted) after its last. Files run in parallel workers, each
 * against a server of its own, so no file's data or rate-limit budget is shared with another's.
 *
 * `seed` runs once after the server is up and its result is `state.seeded`. Tests in a file share
 * the server: each one creates what it needs under a name nothing else uses.
 */
export function useServer<T = undefined>(
  seed?: (server: SeededServer) => Promise<T>,
  options?: StartOptions,
): ServerState<T> {
  const state = {} as ServerState<T>
  test.beforeAll(async () => {
    test.setTimeout(SERVER_START_TIMEOUT_MS)
    state.server = await startServer(options)
    state.seeded = (await seed?.(state.server)) as T
  })
  test.afterAll(async () => {
    await state.server?.stop()
  })
  return state
}

/** Opens `path` on the file's server. */
export const open = (page: Page, server: SeededServer, path: string) =>
  page.goto(`${server.origin}${path}`)

/** Signs the page's browser context in as the seeded admin, without spending a login attempt. */
export const asAdmin = (page: Page, server: SeededServer) => applySession(page.context(), server)

/** Signs in through the login form, the way a person does. */
export async function signInThroughForm(
  page: Page,
  server: SeededServer,
  username: string,
  password: string,
): Promise<void> {
  await open(page, server, '/login')
  await page.getByLabel('Username').fill(username)
  await page.getByLabel('Password', { exact: true }).fill(password)
  await page.getByRole('button', { name: 'Sign in' }).click()
}

/** The navigation landmark of the permanent sidebar (the drawer's, when open, is a second one). */
export const sidebarNav = (page: Page) =>
  page.getByRole('navigation', { name: 'Main navigation' }).first()

/** Resolves when the next successful settings PUT lands (the settings store is optimistic). */
export const settingsSaved = (page: Page) =>
  page.waitForResponse(
    (response) =>
      response.url().includes('/api/account/settings') &&
      response.request().method() === 'PUT' &&
      response.ok(),
  )

/** Asserts a heading of the given level and name is on the page: "the page has arrived". */
export const expectHeading = (page: Page, name: string | RegExp, level = 1) =>
  expect(page.getByRole('heading', { name, level })).toBeVisible()
