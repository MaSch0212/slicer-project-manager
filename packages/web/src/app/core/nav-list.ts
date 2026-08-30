import { ChangeDetectionStrategy, Component, inject, input, output } from '@angular/core'
import { RouterLink, RouterLinkActive } from '@angular/router'
import { JigIcon } from '@awdlab/jig/icon'
import { JigTooltip } from '@awdlab/jig/tooltip'
import { NavEntriesStore } from './nav-entries'

/**
 * The navigation, rendered (spec G 4.2 and 4.3).
 *
 * **Two hosts render this component: the desktop sidebar and the mobile drawer, both in
 * `app.ts`.** That is the whole reason it is a component rather than markup in the shell. A
 * second copy of the navigation is the cross-referenced-pair defect this project keeps finding,
 * and the cheapest way not to have it is not to have a second copy — the alternative was a
 * sidebar and a drawer that agree today and disagree the first time an entry, or a gate, is
 * changed in one of them.
 *
 * What the entries *are* lives in `NavEntriesStore` (`core/nav-entries.ts`), because the shell
 * also has to know whether there are any without rendering them. This component owns only how
 * they look: an anchor per destination, a `<button>` for sign out, and what changes when the
 * sidebar is collapsed.
 *
 * It imports nothing from `features/desktop/` (constraint C2, which CI's bundle greps enforce).
 */
@Component({
  selector: 'spm-nav-list',
  imports: [RouterLink, RouterLinkActive, JigIcon, JigTooltip],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <ul class="spm-nav-list" [class.spm-nav-list--collapsed]="collapsed()">
      @for (entry of navEntries.entries(); track entry.id) {
        <li>
          <!-- The tooltip is bound to null when the labels are visible, and a falsy content is
               how JigTooltip is told there is no tooltip (read from the installed control: it
               removes its aria attributes and never constructs the overlay). So an expanded
               entry does not carry a tooltip repeating the words next to it.

               jigTooltipAutoAriaMode="none" because the accessible name is already the label
               span, which is only ever *visually* hidden. Left at its default the directive
               would add an aria-description saying the same thing the name says. -->
          @if (entry.route; as route) {
            <a
              class="spm-nav-entry"
              [routerLink]="route"
              routerLinkActive="spm-nav-active"
              [jigTooltip]="collapsed() ? entry.label : null"
              jigTooltipAutoAriaMode="none"
            >
              <jig-icon [icon]="entry.icon" />
              <span class="spm-nav-label">{{ entry.label }}</span>
            </a>
          } @else {
            <button
              class="spm-nav-entry"
              type="button"
              [jigTooltip]="collapsed() ? entry.label : null"
              jigTooltipAutoAriaMode="none"
              (click)="signOut.emit()"
            >
              <jig-icon [icon]="entry.icon" />
              <span class="spm-nav-label">{{ entry.label }}</span>
            </button>
          }
        </li>
      }
    </ul>
  `,
})
export class SpmNavList {
  protected readonly navEntries = inject(NavEntriesStore)

  /**
   * Icons only, labels kept in the accessibility tree. Ignored by the drawer, which is always
   * the full list (spec G 4.3) — so this input has a default and the drawer simply omits it.
   */
  readonly collapsed = input(false)

  /**
   * Sign out is an action, so the entry list cannot complete it on its own: the shell owns the
   * navigation to `/login` that has to follow, and owns it for both hosts at once.
   */
  readonly signOut = output<void>()
}
