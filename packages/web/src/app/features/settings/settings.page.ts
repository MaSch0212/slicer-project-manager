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

      <div class="spm-settings-panel">
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

  /**
   * Navigates rather than storing the selection, which is the whole point of a tab strip in
   * navigation mode: the URL is the state, and `activeTab` reads it back.
   *
   * The early return is not a micro-optimisation: what the URL already says is not a selection
   * the user just made, and re-navigating to it would push a duplicate history entry.
   */
  onTabChange(tab: string): void {
    if (tab === this.activeTab()) return
    if (tab === SLICERS_TAB && !this.capabilities.capabilities().canConfigureSlicers) return
    void this.router.navigateByUrl(tab === SLICERS_TAB ? SLICERS_URL : SETTINGS_URL)
  }
}
