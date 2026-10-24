import type { Routes } from '@angular/router'
import { authGuard } from './core/guards'
import { sharedRoutes } from './routes.shared'

/**
 * `sharedRoutes` with the desktop-only Slicers tab appended to the `settings` route's children.
 *
 * Spec D 8.4's `/settings/slicers`, now a genuine child rather than a sibling that only spelled
 * like one: spec G 6 turned the settings page into a tab strip over a `<router-outlet />`, and
 * `routes.shared.ts` declares the parent and the General child so this file has somewhere to
 * append to. It carries **no guard of its own** — `canActivate: [authGuard]` on the parent covers
 * every child — which is what makes the two builds' guarding of this URL impossible to drift
 * apart rather than merely equal today.
 *
 * The lookup throws rather than returning the list unchanged. A `.map` that matched nothing would
 * produce a desktop build whose settings page has no Slicers tab and whose `/settings/slicers`
 * falls through to the `**` redirect, silently, which is the shape of failure this project keeps
 * paying for.
 */
function withSlicersTab(routes: Routes): Routes {
  const settings = routes.find((route) => route.path === 'settings')
  if (!settings) {
    throw new Error("routes.electron: routes.shared.ts no longer declares a 'settings' route")
  }
  return routes.map((route) =>
    route === settings
      ? {
          ...route,
          children: [
            ...(route.children ?? []),
            {
              path: 'slicers',
              loadComponent: () =>
                import('./features/desktop/slicers/slicers.page').then((m) => m.DesktopSlicersPage),
            },
          ],
        }
      : route,
  )
}

/**
 * Desktop-only routes live here and are referenced from nowhere else, so the web build cannot
 * pull them in. Spec D added /settings/slicers, which is now a child of the shared `settings`
 * route rather than an entry of its own; spec E has taken the /browse it reserved. Both live
 * under ./features/desktop/*.
 *
 * `fileReplacements` swaps this file in for routes.ts, so it must import the shared list from
 * routes.shared.ts: './routes' would be replaced with this very file.
 */
export const routes: Routes = [
  ...withSlicersTab(sharedRoutes),
  {
    /*
     * Spec E 7.4, guarded exactly as `/settings` is in routes.shared.ts and for the reason that
     * guard is written the way it is (`!capabilities.requiresAuth || auth.isAuthenticated()`): in
     * local mode `requiresAuth` is false and it passes on the first arm, while in remote mode an
     * unauthenticated window has no business anywhere but /login.
     *
     * **This route is never navigated to a model site.** It is an spm://app route hosting a
     * native sibling `WebContentsView`, which the page attaches on init and destroys on teardown;
     * the main window keeps `sandbox`, `contextIsolation` and `nodeIntegration: false` throughout.
     * That is why the CI grep pair for `DesktopBrowsePage` matters more than the others: this page
     * in the web build would be a UI expecting a containment a browser tab cannot provide.
     */
    path: 'browse',
    canActivate: [authGuard],
    loadComponent: () =>
      import('./features/desktop/browse/browse.page').then((m) => m.DesktopBrowsePage),
  },
  {
    /*
     * Where the shell sends the window when the user answers its mode question with "a server".
     * No guard: it is the page that decides which library there is, so it has to work with no
     * library, no session and `requiresAuth` unknown — the state every guard in the app exists
     * to keep users out of.
     *
     * Listed before the bare `desktop` route: a leaf route only matches when it consumes the
     * whole URL, so the order is not load-bearing today — but it would become so the moment
     * `desktop` grew children, and the more specific path reading first costs nothing.
     */
    path: 'desktop/connect',
    loadComponent: () =>
      import('./features/desktop/connect.page').then((m) => m.DesktopConnectPage),
  },
  {
    path: 'desktop',
    loadComponent: () =>
      import('./features/desktop/placeholder.page').then((m) => m.DesktopPlaceholderPage),
  },
  { path: '**', redirectTo: 'projects' },
]
