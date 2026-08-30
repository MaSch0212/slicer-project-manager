import { ChangeDetectionStrategy, Component, computed, effect, inject, signal } from '@angular/core'
import { takeUntilDestroyed } from '@angular/core/rxjs-interop'
import { NavigationEnd, Router, RouterLink, RouterOutlet } from '@angular/router'
import { ColorSchemeService } from '@awdlab/jig/api/ng'
import { JigButton } from '@awdlab/jig/button'
import { JigDrawer } from '@awdlab/jig/drawer'
import { JigIcon } from '@awdlab/jig/icon'
import { JigTooltip } from '@awdlab/jig/tooltip'
import tablerLayoutSidebarLeftCollapse from '@iconify/icons-tabler/layout-sidebar-left-collapse'
import tablerLayoutSidebarLeftExpand from '@iconify/icons-tabler/layout-sidebar-left-expand'
import tablerMenu2 from '@iconify/icons-tabler/menu-2'
import { AuthStore } from './core/auth.store'
import { TranslateService } from './core/i18n/translate.service'
import { NavEntriesStore } from './core/nav-entries'
import { SpmNavList } from './core/nav-list'
import { NotifyService } from './core/notify.service'
import { SettingsStore } from './core/settings.store'

/** The shell: routing, nav and the theme sync. */
@Component({
  selector: 'app-root',
  imports: [RouterLink, RouterOutlet, JigButton, JigDrawer, JigIcon, JigTooltip, SpmNavList],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="spm-shell">
      <!-- No entries, no chrome.

           On /login of a shell that requires authentication the entry list is empty, and what
           used to render around it was a 240px column holding a brand and a control to collapse
           nothing -- with a collapse button that PUTs /api/settings, is answered 401, and shows
           the user an error for an action the shell itself invited. The condition is the list's
           own length and not a repeat of the auth gate: a gate written twice is a gate that can
           disagree with itself, and this is the honest question anyway ("is there anywhere to
           go?"). It is why the entries live in a store rather than inside the component this
           block would otherwise be wrapped around. -->
      @if (navEntries.entries().length > 0) {
        <!-- Above the breakpoint. Hidden below it by the one media query in styles.css, which is
             a rule about the viewport and not about the shell: a narrow desktop window gets the
             drawer too, because the constraint is width. -->
        <nav
          class="spm-sidebar"
          [class.spm-sidebar--collapsed]="collapsed()"
          [attr.aria-label]="t.translations().nav.label"
        >
          <!-- The same mark the browser tab shows: the favicon in packages/web/public, which the
               Angular build copies to the site root unhashed.

               alt="" is what does the work. The link's own text already names the app, so a
               second accessible name here would have a screen reader announce "Slicer Project
               Manager Slicer Project Manager". aria-hidden says the same thing twice on
               purpose: this is exactly the kind of decoration someone later "fixes" by adding
               alt text.

               That makes the span the link's only accessible name, in both states -- which is
               why styles.css hides it when collapsed with the clip pattern rather than with
               display:none. A collapsed brand link styled the obvious way is a link with no
               name at all, and it is the first thing a keyboard user reaches.

               width and height are the intrinsic box, so the sidebar head does not reflow between
               layout and image decode. The src is resolved through the base href="/" in
               index.html, which is what makes it spm://app/favicon.svg in the Electron
               renderer rather than a lookup relative to the current route.

               No backticks in this comment, and no dollar-brace either: the template is a JS
               template literal, so both are syntax before they are text. Measured -- a first
               version of this comment quoted the file path in backticks and esbuild failed
               with 'Expected "}" but found "packages"'.

               There is exactly one of these in the document. The narrow top bar below carries a
               plain title instead of a second brand link, so "the link that names the app" stays
               a single element for anything looking for it by name. -->
          <a class="spm-brand" routerLink="/projects">
            <img
              class="spm-brand-mark"
              src="favicon.svg"
              alt=""
              aria-hidden="true"
              width="28"
              height="28"
            />
            <span class="spm-brand-name">{{ t.translations().app.title }}</span>
          </a>

          <spm-nav-list [collapsed]="collapsed()" (signOut)="onSignOut()" />

          <!-- The accessible name does not change with the state; only the icon does. A control
               whose name flips between "Collapse" and "Expand" is announced as a different
               control each time it is pressed, which is what aria-expanded is for saying instead.

               The name comes from the tooltip rather than a separate aria-label: JigTooltip's
               autoAria writes aria-label itself in "label" mode, and *removes* any aria-label it
               did not write. An aria-label set here alongside a tooltip would be deleted on the
               next render. -->
          <button
            jigButton
            kind="icon"
            class="spm-nav-toggle"
            type="button"
            [attr.aria-expanded]="!collapsed()"
            [jigTooltip]="t.translations().nav.toggle"
            jigTooltipAutoAriaMode="label"
            (click)="onToggleCollapsed()"
          >
            <jig-icon [icon]="collapsed() ? icons.expand : icons.collapse" />
          </button>
        </nav>
      }

      <div class="spm-shell-body">
        <!-- At or below the breakpoint, and nowhere else. No brand link here: see the sidebar. -->
        <div class="spm-topbar">
          @if (navEntries.entries().length > 0) {
            <button
              jigButton
              kind="icon"
              type="button"
              [attr.aria-expanded]="drawerOpen()"
              [attr.aria-label]="t.translations().nav.open"
              (click)="drawerOpen.set(true)"
            >
              <jig-icon [icon]="icons.menu" />
            </button>
          }
          <span class="spm-topbar-title">{{ t.translations().app.title }}</span>
        </div>

        <router-outlet />
      </div>

      <!-- The same list component the sidebar renders, and never a second copy of the entries.
           No collapsed input: navCollapsed has no effect on mobile, where the drawer is always
           the full list.

           lazy, with the entries in a #content template rather than projected between the tags:
           projected content is instantiated by *this* template regardless of the drawer's state,
           so a closed drawer would keep a full second navigation in the document -- reachable by
           anything that walks the DOM, and a second set of links for a test to trip over.
           Deferring it means a closed drawer holds nothing at all. -->
      <jig-drawer
        [(open)]="drawerOpen"
        [modal]="true"
        [lazy]="true"
        position="start"
        [header]="t.translations().app.title"
      >
        <ng-template #content>
          <nav [attr.aria-label]="t.translations().nav.label">
            <spm-nav-list (signOut)="onSignOut()" />
          </nav>
        </ng-template>
      </jig-drawer>
    </div>
  `,
})
export class App {
  protected readonly t = inject(TranslateService)
  protected readonly navEntries = inject(NavEntriesStore)
  private readonly auth = inject(AuthStore)
  private readonly notify = inject(NotifyService)
  private readonly settings = inject(SettingsStore)
  // The actual theme hook: @awdlab/jig ships a `dark` class toggle driven by this service,
  // not a `data-theme` attribute. ColorScheme is 'light' | 'dark' | 'system' — the same
  // union as SettingsDto['theme'] — so 'system' needs no manual resolution here:
  // ColorSchemeService itself resolves it against `(prefers-color-scheme: dark)` and stays
  // reactive to that media query changing.
  private readonly colorScheme = inject(ColorSchemeService)
  private readonly router = inject(Router)

  protected readonly icons = {
    menu: tablerMenu2,
    collapse: tablerLayoutSidebarLeftCollapse,
    expand: tablerLayoutSidebarLeftExpand,
  }

  /**
   * Read straight off the store, never mirrored into a local signal.
   *
   * `SettingsStore.patch` is optimistic: it writes the key, sends the PUT, and puts the old
   * value back if the server refuses. A local signal set alongside the patch would keep the
   * value the server rejected, so the sidebar would sit collapsed under a message saying the
   * change did not save. Deriving it means the rollback *is* the visual undo.
   */
  protected readonly collapsed = computed(() => this.settings.settings().navCollapsed)

  /**
   * Mobile only. Nothing persists it: a drawer is open for as long as it is being used.
   *
   * Public because `[(open)]` is two-way — the drawer writes its own closes back into this
   * signal, so reading it is reading the control's state and not a copy of it.
   */
  readonly drawerOpen = signal(false)

  constructor() {
    effect(() => {
      this.colorScheme.set(this.settings.settings().theme)
    })

    // A drawer left open over the page the user just navigated to is the defect this
    // subscription exists to prevent (spec G 4.3). NavigationEnd rather than NavigationStart so
    // a navigation that a guard cancels does not close it for nothing.
    this.router.events.pipe(takeUntilDestroyed()).subscribe((event) => {
      if (event instanceof NavigationEnd) {
        this.drawerOpen.set(false)
      }
    })
  }

  /**
   * Collapses or expands the sidebar, and persists the choice.
   *
   * The setting is the state — there is nothing to set here beyond asking the store to move it,
   * because the template reads the store. A refused write therefore needs no undo of its own:
   * the store has already put the previous value back by the time this catch runs, and all that
   * is left to do is say so. `patch` rethrows after rolling back, which is why this is a `try`
   * and not a `.then`.
   */
  async onToggleCollapsed(): Promise<void> {
    try {
      await this.settings.patch({ navCollapsed: !this.settings.settings().navCollapsed })
    } catch {
      this.notify.error(this.t.translations().errors.generic)
    }
  }

  /**
   * The nav used to bind `(click)="auth.logout()"` straight through. Two defects in one:
   * `AuthStore.logout` rethrows after clearing local state in its `finally`, so a failed
   * logout escaped as an unhandled rejection with nothing shown; and nothing navigated, so
   * a *successful* sign-out left the user on `/projects` with the grid still rendered.
   *
   * It stays in the shell rather than in `SpmNavList` because the navigation to `/login` that
   * has to follow is the shell's business, and both hosts of the list route through this one
   * handler.
   */
  async onSignOut(): Promise<void> {
    try {
      await this.auth.logout()
    } catch {
      // The local session is already gone (logout clears it in a `finally`); what may have
      // survived is the server's own session row, which the user cannot fix from here — so
      // this reports, it does not offer a retry. A snackbar and not a banner: it is the result
      // of an action the user just took (spec G 7).
      this.notify.error(this.t.translations().errors.generic)
    }
    // Outside the try on purpose: either way the user is signed out locally, so leaving
    // them on an authenticated route would be the same bug in both branches.
    await this.router.navigateByUrl('/login')
  }
}
