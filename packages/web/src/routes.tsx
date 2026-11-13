import { Navigate, type RouteDefinition } from '@solidjs/router'
import { lazy, type Component } from 'solid-js'
import { RequireAdmin, RequireAuth, RequireCapability, type CapabilityFlag } from './core/guards'
import ActivatePage from './pages/activate'
import ImportPage from './pages/import'
import LoginPage from './pages/login'
import NotFoundPage from './pages/not-found'
import ProjectsPage from './pages/projects'
import SettingsPage from './pages/settings'

/**
 * THE ROUTE TABLE. One place that says which paths exist, who may open them and what loads when.
 *
 * - Public: `/login`, `/activate` (the link format the server prints is `/activate#<token>`).
 * - `auth(...)`: signed in, or a shell that needs no sign-in (`requiresAuth: false`).
 * - `admin(...)`: auth plus `canManageUsers` and an administrator.
 * - `capability(flag, ...)`: auth plus a capability, for desktop-only surfaces. These are lazy
 *   chunks: the web and desktop builds are one bundle, and the capability gate decides who can
 *   reach them (the server never serves them an API, because those are Tauri commands).
 *
 * Web parts 2 and 3 replace the page components; paths and guards stay.
 */
const auth =
  (Page: Component): Component =>
  () => (
    <RequireAuth>
      <Page />
    </RequireAuth>
  )

const admin =
  (Page: Component): Component =>
  () => (
    <RequireAdmin>
      <Page />
    </RequireAdmin>
  )

const capability =
  (flag: CapabilityFlag, Page: Component, options?: { authenticated?: boolean }): Component =>
  () => (
    <RequireCapability flag={flag} authenticated={options?.authenticated}>
      <Page />
    </RequireCapability>
  )

// Lazy chunks. (The 3D viewer is one too, loaded by the file preview, not by a route.)
const AdminUsersPage = lazy(() => import('./pages/admin-users'))
const BrowsePage = lazy(() => import('./pages/browse'))
const ConnectPage = lazy(() => import('./pages/connect'))

const redirectToProjects: Component = () => <Navigate href="/projects" />
const redirectToSettings: Component = () => <Navigate href="/settings" />

export const routes: RouteDefinition[] = [
  { path: '/', component: redirectToProjects },
  { path: '/login', component: LoginPage },
  { path: '/activate', component: ActivatePage },
  // One route, three paths: `/projects/abc` is the list with that project open beside it, and
  // `/projects/abc/view/f1` is that with one of its files in the preview popup. Keeping it the
  // same route is what stops the list reloading every time one is selected or previewed, and the
  // address is what makes the back button close the popup and a link reopen it.
  {
    path: ['/projects', '/projects/:id', '/projects/:id/view/:fileId'],
    component: auth(ProjectsPage),
  },
  { path: '/import', component: auth(ImportPage) },
  { path: '/settings', component: auth(SettingsPage) },
  // Slicers was its own page until the settings page became one scroll. The capability gate moved
  // onto the section; this is here so links and bookmarks still land somewhere sensible.
  { path: '/settings/slicers', component: redirectToSettings },
  { path: '/admin/users', component: admin(AdminUsersPage) },
  { path: '/browse', component: capability('canBrowseModelSites', BrowsePage) },
  // Where a desktop shell with no library yet chooses one, so it cannot require a session.
  {
    path: '/desktop/connect',
    component: capability('canPickLocalFolder', ConnectPage, { authenticated: false }),
  },
  // Development only: the constant is replaced at build time, so production carries no gallery.
  ...(import.meta.env.DEV
    ? [{ path: '/_ui', component: lazy(() => import('./gallery/ui-gallery')) }]
    : []),
  { path: '*', component: NotFoundPage },
]
