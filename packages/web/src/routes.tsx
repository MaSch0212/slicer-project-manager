import { Navigate, type RouteDefinition } from '@solidjs/router'
import { lazy, type Component } from 'solid-js'
import { RequireAdmin, RequireAuth, RequireCapability, type CapabilityFlag } from './core/guards'
import ActivatePage from './pages/activate'
import ImportPage from './pages/import'
import LoginPage from './pages/login'
import NotFoundPage from './pages/not-found'
import ProjectDetailPage from './pages/project-detail'
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

// Lazy chunks. The viewer will carry Three.js, so it is split off from the start.
const ViewerPage = lazy(() => import('./pages/viewer'))
const AdminUsersPage = lazy(() => import('./pages/admin-users'))
const BrowsePage = lazy(() => import('./pages/browse'))
const SlicersPage = lazy(() => import('./pages/slicers'))
const ConnectPage = lazy(() => import('./pages/connect'))

const redirectToProjects: Component = () => <Navigate href="/projects" />

export const routes: RouteDefinition[] = [
  { path: '/', component: redirectToProjects },
  { path: '/login', component: LoginPage },
  { path: '/activate', component: ActivatePage },
  { path: '/projects', component: auth(ProjectsPage) },
  { path: '/projects/:id', component: auth(ProjectDetailPage) },
  { path: '/projects/:id/view/:fileId', component: auth(ViewerPage) },
  { path: '/import', component: auth(ImportPage) },
  { path: '/settings', component: auth(SettingsPage) },
  { path: '/settings/slicers', component: capability('canConfigureSlicers', SlicersPage) },
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
