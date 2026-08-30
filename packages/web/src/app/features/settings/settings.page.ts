import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core'
import { Router, RouterOutlet, isActive } from '@angular/router'
import { JigTab, JigTabs } from '@awdlab/jig/tabs'
import { CapabilitiesStore } from '../../core/capabilities.store'
import { TranslateService } from '../../core/i18n/translate.service'

/**
 * The tab ids and the URL each one stands for.
 *
 * `GENERAL_TAB` is a word rather than the empty string its route path is: `jig-tabs` treats an
 * empty active id as "nothing is selected" and re-asserts its first tab every render pass, which
 * would make the General tab a permanent source of `activeTabChange` events.
 */
const GENERAL_TAB = 'general'
const SLICERS_TAB = 'slicers'
const SETTINGS_URL = '/settings'
const SLICERS_URL = '/settings/slicers'

/**
 * The settings page: a tab strip over a `<router-outlet />` (spec G 6).
 *
 * **The tabs are navigation, not a component-local flag.** Each `<jig-tab>` deliberately omits
 * its `#content` template — jig's own template renders a panel only `@if (content.template)`, so
 * with none it renders the header row alone — and the routed child lands in the outlet below.
 * That is what keeps `/settings/slicers` a real, deep-linkable, `authGuard`ed URL while giving it
 * the way back the previous version of this page had none of: the strip is above the outlet and
 * visible from the tab it took you to.
 *
 * `activeTab` reads the URL rather than being written by the click, so a deep link, a browser
 * Back and a click on a header all end up in the same state.
 *
 * **This file imports nothing from `features/desktop/`** — spec G C2's rule and the one CI's
 * bundle greps enforce. The Slicers tab is a capability flag plus a URL string; the route that
 * serves it is declared only in `routes.electron.ts`, so in the web build it does not exist and
 * `canConfigureSlicers` is false, and the header is never rendered.
 */
@Component({
  selector: 'app-settings-page',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterOutlet, JigTab, JigTabs],
  template: `
    <main class="spm-main">
      <div class="spm-stack">
        <h1>{{ t.translations().settings.title }}</h1>

        <jig-tabs [activeTab]="activeTab()" (activeTabChange)="onTabChange($event)">
          <jig-tab [tabId]="ids.general">
            <ng-template #header>{{ t.translations().settings.general }}</ng-template>
          </jig-tab>
          @if (capabilities.capabilities().canConfigureSlicers) {
            <jig-tab [tabId]="ids.slicers">
              <ng-template #header>{{ t.translations().settings.slicers }}</ng-template>
            </jig-tab>
          }
        </jig-tabs>
      </div>

      <!--
        The panel role, named by the tab that is open. The strip and the routed content are two
        sibling elements, and without a role here the content has no programmatic relation to the
        control that chose it. The name is an aria-label rather than an aria-labelledby pointing
        at the header, because jig generates the header ids internally and exposes neither them
        nor any attribute passthrough; the accessible name is the same either way. jig's own
        aria-controls on the headers still points at a panel it does not render in navigation
        mode -- that half is not reachable from this codebase.
      -->
      <div class="spm-settings-panel" role="tabpanel" [attr.aria-label]="activeTabLabel()">
        <router-outlet />
      </div>
    </main>
  `,
})
export class SettingsPage {
  protected readonly capabilities = inject(CapabilitiesStore)
  protected readonly t = inject(TranslateService)

  private readonly router = inject(Router)

  protected readonly ids = { general: GENERAL_TAB, slicers: SLICERS_TAB }

  /**
   * `isActive` is a computed over the router's last successful navigation, so this tracks the URL
   * without a subscription of its own and answers correctly on the first render of a deep link.
   * The default `paths: 'subset'` asks whether the current URL contains `/settings/slicers`,
   * which `/settings` does not.
   */
  private readonly slicersActive = isActive(SLICERS_URL, this.router)

  readonly activeTab = computed(() => (this.slicersActive() ? SLICERS_TAB : GENERAL_TAB))

  /** The open tab's own label, so the panel below the strip carries the same name its header does. */
  protected readonly activeTabLabel = computed(() => {
    const settings = this.t.translations().settings
    return this.activeTab() === SLICERS_TAB ? settings.slicers : settings.general
  })

  /**
   * Navigates rather than storing the selection, which is the whole point of a tab strip in
   * navigation mode: the URL is the state, and `activeTab` reads it back.
   *
   * The early return is not a micro-optimisation: what the URL already says is not a selection
   * the user just made, and re-navigating to it would push a duplicate history entry.
   *
   * **A warning for whoever adds the third tab.** `jig-tabs` re-asserts its **first** tab whenever
   * the active id matches none of the tabs it is rendering, and that re-assertion arrives here as
   * an ordinary change — indistinguishable from a click. Measured twice: in a real window, and by
   * calling this method with `'general'` while the router sat at `/settings/slicers`, which ended
   * at `/settings`. So a tab whose header is absent while its URL is open does not merely show
   * the wrong highlight; the page is navigated off the URL the user asked for.
   *
   * It cannot bite today because the Slicers header and the `slicers` route are gated by the same
   * `canConfigureSlicers` — hardcoded `true` in the desktop shell's capabilities, and the web
   * build has neither the header nor the route — so the active id always names a rendered tab.
   * **A third tab whose header is gated differently from its route makes this reachable.** There
   * is deliberately no guard here against it: the state is unreachable from any input this build
   * can produce, so a guard could not be proven by mutation on a reachable path, and dead code
   * with a comment claiming it works is worse than this warning.
   */
  onTabChange(tab: string): void {
    if (tab === this.activeTab()) return
    void this.router.navigateByUrl(tab === SLICERS_TAB ? SLICERS_URL : SETTINGS_URL)
  }
}
