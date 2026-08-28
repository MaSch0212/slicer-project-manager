import {
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
  signal,
  viewChild,
  viewChildren,
} from '@angular/core'
import { InterpolatePipe } from '@ngneers/signal-translate'
import { JigButton } from '@awdlab/jig/button'
import { JigIcon } from '@awdlab/jig/icon'
import { JigInputField } from '@awdlab/jig/input-field'
import { JigMessage } from '@awdlab/jig/message'
import { JigRadio, JigRadioGroup } from '@awdlab/jig/radio'
import { JigSelect } from '@awdlab/jig/select'
import { JigSpinner } from '@awdlab/jig/spinner'
import { JigTag } from '@awdlab/jig/tag'
import tablerPlus from '@iconify/icons-tabler/plus'
import tablerRefresh from '@iconify/icons-tabler/refresh'
import tablerTrash from '@iconify/icons-tabler/trash'
import type { SlicerConfigDto, SlicerId, SlicerInstallDto } from '@spm/contract/dtos.ts'
import { DETECTION_FAILED, isAppError } from '@spm/contract/errors.ts'
import { TranslateService } from '../../../core/i18n/translate.service'
import { SHELL_CLIENT } from '../../../core/api/api-client.token'
import { SLICER_PRODUCTS } from '../../../core/slicer-products'
import { SlicerSessionsCard } from '../../../core/slicer-sessions.card'

/** One product's row on the page: what is installed for it, and what is bound. */
type ProductRow = {
  id: SlicerId
  name: string
  installs: SlicerInstallDto[]
  /** The install this product launches, or null where nothing is bound. */
  boundId: string | null
  /** More than one install and nothing bound: the page asks rather than picking one. */
  mustChoose: boolean
}

/**
 * Which message the page shows, as a kind rather than a resolved string.
 *
 * A kind because the language switches at runtime (spec 6.4): a string frozen at the moment the
 * call failed would still be in the old language after the switch, and this page's own error is
 * exactly the sort of text that sits on screen while a user goes looking for the language setting.
 */
type FailureKind =
  | 'forbidden'
  | 'conflict'
  | 'notFound'
  | 'pickedGone'
  | 'validation'
  | 'detection'
  | 'load'
  | 'generic'

/**
 * `AppError.code` is what the UI switches on, and the two codes that need more than the code are
 * named here.
 *
 * `Internal` is the interesting one: it covers both "detection could not run" — a PowerShell that
 * timed out, a missing `powershell.exe`, an overflowed buffer — and everything unforeseen, and
 * only `details.reason` tells them apart. The constant crosses the boundary from
 * `@spm/contract/errors.ts` rather than being spelled here by hand, because a drifting literal
 * would fail silently: the page would just show its generic message.
 */
function classify(error: unknown): FailureKind {
  if (!isAppError(error)) return 'generic'
  switch (error.code) {
    // Never reached in the desktop shell — `SHELL_CLIENT` is always the IPC client — but this is
    // what `HttpApiClient` answers all seven of these calls with, so it is what a route reached
    // in the browser would produce, and saying so is better than "something went wrong".
    case 'Forbidden':
      return 'forbidden'
    case 'Conflict':
      return 'conflict'
    case 'NotFound':
      return 'notFound'
    case 'Validation':
      return 'validation'
    case 'Internal':
      return error.details?.['reason'] === DETECTION_FAILED ? 'detection' : 'generic'
    default:
      return 'generic'
  }
}

/**
 * The slicers installed on this machine, and which install of each product the app launches
 * (spec D 8.4).
 *
 * **Desktop-only in the way spec 2.5 prescribes**: it lives under `features/desktop/` and is
 * referenced only from `routes.electron.ts`, so the web build physically cannot contain it — CI
 * greps both bundles for `DesktopSlicersPage` to prove it. Nothing in `features/settings/` imports
 * anything from here; the link over there is a `routerLink` string gated on `canConfigureSlicers`,
 * which is false in the browser column, so it never renders in a build where this route does not
 * exist.
 *
 * It injects `SHELL_CLIENT` rather than `API_CLIENT` for the same reason the connect page does:
 * `API_CLIENT` is whatever transport the *library* is on, and in remote mode that is
 * `HttpApiClient`, which refuses all seven of these calls. Which slicers this computer has is a
 * property of the computer, not of whichever library is open.
 *
 * **The page never picks an install for the user.** Two Curas side by side is the measured case
 * (spec 3.1, and this developer's own machine), the shell leaves such a product unbound on
 * purpose, and this page renders that as a question with nothing preselected. Silently preferring
 * the newer one is the behaviour the whole (path, version) identity model exists to avoid.
 *
 * Every mutating call answers with the **whole** new configuration, so `#run` replaces the state
 * rather than patching it and there is no reconciliation to get wrong.
 */
@Component({
  selector: 'app-desktop-slicers-page',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    InterpolatePipe,
    JigButton,
    JigIcon,
    JigInputField,
    JigMessage,
    JigRadio,
    JigRadioGroup,
    JigSelect,
    JigSpinner,
    JigTag,
    SlicerSessionsCard,
  ],
  template: `
    <main class="spm-main spm-main--narrow">
      <div class="spm-stack">
        <div>
          <h1>{{ t.translations().slicers.title }}</h1>
          <p class="spm-muted">{{ t.translations().slicers.lead }}</p>
        </div>

        @if (config(); as cfg) {
          @if (cfg.detectionSupported) {
            <div class="spm-row">
              <button
                jigButton
                kind="primary"
                type="button"
                [disabled]="busy()"
                (click)="onRescan()"
              >
                <jig-icon [icon]="icons.rescan" />
                {{ t.translations().slicers.rescan }}
              </button>
              @if (busy()) {
                <jig-spinner [size]="20" />
              }
            </div>
          } @else {
            <!-- Spec 4.6: off Windows there is no detection at all, so the page says so once and
                 offers the mechanism that does work rather than a button that answers nothing. -->
            <jig-message color="info">{{ t.translations().slicers.windowsOnly }}</jig-message>
          }
        }

        @if (failureMessage(); as message) {
          <jig-message color="error" role="alert">
            <div class="spm-stack spm-stack--tight">
              <span>{{ message }}</span>
              @if (offerReset()) {
                <!-- The only way out of a slicers.json this build refuses to overwrite, and a
                     user action by construction: nothing else in the app may throw a newer
                     version's configuration away. -->
                <span>
                  <button
                    jigButton
                    kind="secondary"
                    color="error"
                    type="button"
                    [disabled]="busy()"
                    (click)="onReset()"
                  >
                    {{ t.translations().slicers.reset }}
                  </button>
                </span>
              }
            </div>
          </jig-message>
        }

        @if (config(); as cfg) {
          <div class="spm-card spm-stack">
            <div>
              <h2>{{ t.translations().slicers.defaultTitle }}</h2>
              <p class="spm-muted">{{ t.translations().slicers.defaultLead }}</p>
            </div>
            @if (defaultOptions().length) {
              <jig-input-field
                class="spm-block"
                inputId="slicers-default"
                [label]="t.translations().slicers.defaultTitle"
              >
                <jig-select
                  inputId="slicers-default"
                  [label]="t.translations().slicers.defaultTitle"
                  [options]="defaultOptions()"
                  [placeholder]="t.translations().slicers.defaultPlaceholder"
                  [disabled]="busy()"
                  [value]="cfg.defaultSlicerId"
                  (valueChange)="onSetDefault($event)"
                />
              </jig-input-field>
            } @else {
              <p class="spm-muted">{{ t.translations().slicers.defaultNone }}</p>
            }
            @if (cfg.defaultSlicerId !== null) {
              <!--
                Outside the block above, deliberately. It used to be inside it, so unbinding the
                last bound product took the whole select AND this button away, leaving a default
                still set with nothing on screen to clear it — the same "no way back" shape one
                step along from the one the nullable arm was added to remove. The launch path
                refuses by name in that state, so it is recoverable rather than broken; it is
                still a setting whose effect the user can see and cannot reach.
              -->
              <span>
                <button
                  jigButton
                  kind="text"
                  type="button"
                  [disabled]="busy()"
                  (click)="onSetDefault(null)"
                >
                  {{ t.translations().slicers.clearDefault }}
                </button>
              </span>
            }
          </div>

          @for (product of products(); track product.id) {
            <section class="spm-card spm-stack">
              <h2>{{ product.name }}</h2>

              @if (product.installs.length === 0) {
                <p class="spm-muted">{{ t.translations().slicers.notInstalled }}</p>
              } @else {
                @if (product.mustChoose) {
                  <!-- Spec 3.1's two-Cura case. Nothing is preselected below; this says why. -->
                  <jig-message color="warning" role="status">
                    {{
                      t.translations().slicers.chooseWhich
                        | interpolate: { count: product.installs.length, name: product.name }
                    }}
                  </jig-message>
                }
                <!-- orientation="vertical" is not decoration: jig's radio-group root is a flex
                     *row* until aria-orientation says otherwise, so this is what stacks the rows,
                     as well as what puts the arrow keys on the right axis. Measured; styles.css
                     says the same thing from the other side. -->
                <jig-radio-group
                  orientation="vertical"
                  [label]="
                    t.translations().slicers.chooseLabel | interpolate: { name: product.name }
                  "
                  [disabled]="busy()"
                  [value]="product.boundId"
                  (valueChange)="onBind(product.id, $event)"
                >
                  @for (install of product.installs; track install.id) {
                    <div class="spm-row spm-slicer-install">
                      <jig-radio class="spm-grow" [value]="install.id">
                        <span class="spm-slicer-install-text">
                          <span>{{ install.label }}</span>
                          <span class="spm-muted">
                            {{ install.version ?? t.translations().slicers.unknownVersion }}
                          </span>
                          <code class="spm-code">{{ install.path }}</code>
                        </span>
                      </jig-radio>
                      @if (install.state === 'missing') {
                        <jig-tag color="error">{{
                          t.translations().slicers.installMissing
                        }}</jig-tag>
                      }
                      <button
                        jigButton
                        kind="icon"
                        color="error"
                        type="button"
                        [disabled]="busy()"
                        [attr.aria-label]="t.translations().slicers.remove + ' ' + install.label"
                        (click)="onRemove(install.id)"
                      >
                        <jig-icon [icon]="icons.remove" />
                      </button>
                    </div>
                  }
                </jig-radio-group>
              }

              <span>
                <button
                  jigButton
                  kind="secondary"
                  type="button"
                  [disabled]="busy()"
                  (click)="onAddManual(product.id)"
                >
                  <jig-icon [icon]="icons.add" />
                  {{ t.translations().slicers.addManual }}
                </button>
                @if (product.boundId !== null) {
                  <button
                    jigButton
                    kind="text"
                    type="button"
                    [disabled]="busy()"
                    (click)="onUnbind(product.id)"
                  >
                    {{ t.translations().slicers.unbind }}
                  </button>
                }
              </span>
            </section>
          }
        } @else if (!failureMessage()) {
          <jig-spinner centered [size]="40" />
        }

        <!--
          Spec 6.3's unfinished-session list. It is on this page rather than only beside the
          launch control because a session outlives the project page it was started from — and
          outlives the run of the app, which is the case a settings page is the only home for.
          No project is named here, so an orphan is asked which one it belongs to.
        -->
        <app-slicer-sessions />
      </div>
    </main>
  `,
})
export class DesktopSlicersPage {
  private readonly shell = inject(SHELL_CLIENT)
  protected readonly t = inject(TranslateService)

  protected readonly icons = { rescan: tablerRefresh, add: tablerPlus, remove: tablerTrash }

  // Writable in here, readable everywhere else — `CapabilitiesStore`'s convention. A page whose
  // state can be written from outside has no single place its state changes.
  readonly #configState = signal<SlicerConfigDto | null>(null)
  readonly #busyState = signal(false)
  readonly #failureState = signal<FailureKind | null>(null)
  readonly config = this.#configState.asReadonly()
  readonly busy = this.#busyState.asReadonly()
  readonly failure = this.#failureState.asReadonly()

  /**
   * The two kinds of control that own a value of their own, so a refused change can be put back.
   *
   * `jig-radio-group` and `jig-select` write their own model signal the moment the user picks;
   * this page binds one-way from `config()`. On success the configuration changes and Angular
   * rewrites the input, which is what `onBind`'s early return is about. On **failure** nothing in
   * `config()` changed, so Angular writes nothing, and the control would sit there showing the
   * install the shell had just refused — underneath a banner saying it was refused.
   */
  private readonly radioGroups = viewChildren(JigRadioGroup)
  private readonly defaultSelect = viewChild(JigSelect)

  /**
   * Resolves once the first `slicers.get()` has settled, so a spec can await the load rather than
   * counting microtasks. Same device `TranslateService.ready` is, for the same reason.
   */
  readonly ready: Promise<void>

  constructor() {
    this.ready = this.#run(() => this.shell.slicers.get(), { generic: 'load' })
  }

  protected readonly products = computed<ProductRow[]>(() => {
    const cfg = this.config()
    return SLICER_PRODUCTS.map((product) => {
      const installs = (cfg?.installs ?? []).filter((install) => install.slicerId === product.id)
      const boundId = cfg?.bindings[product.id] ?? null
      return {
        id: product.id,
        name: product.name,
        installs,
        boundId,
        mustChoose: installs.length > 1 && boundId === null,
      }
    })
  })

  /**
   * Only products with a binding. A default naming a product with no install to launch is a
   * setting that would fail at the moment it mattered; the shell allows it, and the UI does not
   * offer it.
   */
  protected readonly defaultOptions = computed(() =>
    this.products()
      .filter((product) => product.boundId !== null)
      .map((product) => ({ label: product.name, value: product.id })),
  )

  protected readonly failureMessage = computed(() => {
    const kind = this.failure()
    if (kind === null) return null
    const strings = this.t.translations().slicers
    switch (kind) {
      case 'forbidden':
        return strings.errorForbidden
      case 'conflict':
        return strings.errorConflict
      case 'notFound':
        return strings.errorNotFound
      case 'pickedGone':
        return strings.errorPickedGone
      case 'validation':
        return strings.errorValidation
      case 'detection':
        return strings.errorDetection
      case 'load':
        return strings.errorLoad
      case 'generic':
        return this.t.translations().errors.generic
    }
  })

  /** A `Conflict` is a configuration this build refuses to overwrite, and reset is the way out. */
  protected readonly offerReset = computed(() => this.failure() === 'conflict')

  async onRescan(): Promise<void> {
    await this.#run(() => this.shell.slicers.scan())
  }

  async onAddManual(slicerId: SlicerId): Promise<void> {
    // `NotFound` means something different here from what it means anywhere else on this page, and
    // it was measured rather than reasoned about: picking a path that is not there really does
    // come back `NotFound`, and the shared sentence — "that install is not listed any more, rescan"
    // — is about a stale row in a list, which is not what happened. The file the user just chose
    // is gone; say that, and do not send them to a scan that cannot help.
    await this.#run(() => this.shell.slicers.addManual(slicerId), { notFound: 'pickedGone' })
  }

  async onRemove(installId: string): Promise<void> {
    await this.#run(() => this.shell.slicers.remove(installId))
  }

  async onBind(slicerId: SlicerId, installId: string | null): Promise<void> {
    // The group re-emits its bound value as the input re-syncs after a replace; binding to what
    // is already bound would be a second IPC round trip for nothing. `null` used to return here
    // too, which silently made "launch nothing for this product" unreachable — see `onUnbind`.
    if (installId === null || installId === this.config()?.bindings[slicerId]) return
    await this.#run(() => this.shell.slicers.bind(slicerId, installId))
  }

  /**
   * Unbinds a product, which is the only way back from a binding the app made by itself.
   *
   * A product with exactly one install is bound the moment it is detected, and `remove` does not
   * undo that: the install is still installed, so the next scan finds it and binds it again for
   * being the only one. Rendered only where there is something to unbind.
   */
  async onUnbind(slicerId: SlicerId): Promise<void> {
    if (this.config()?.bindings[slicerId] === undefined) return
    await this.#run(() => this.shell.slicers.bind(slicerId, null))
  }

  async onSetDefault(slicerId: SlicerId | null): Promise<void> {
    if (slicerId === this.config()?.defaultSlicerId) return
    await this.#run(() => this.shell.slicers.setDefault(slicerId))
  }

  async onReset(): Promise<void> {
    await this.#run(() => this.shell.slicers.resetConfig())
  }

  /**
   * One call, one replacement, one message.
   *
   * **The `busy` gate is load-bearing and not only cosmetic.** `addManual` opens a native dialog
   * in the main process and refuses a second one for a *different* product with `Conflict` — the
   * same code an unwritable `slicers.json` uses, with no `details` to tell them apart. This page
   * cannot issue that second call: every control it renders is disabled while a call is in
   * flight, and this returns early if one somehow gets through. So a `Conflict` reaching the
   * template here means the file, which is what `offerReset` acts on.
   */
  async #run(
    call: () => Promise<SlicerConfigDto | null>,
    overrides: { generic?: FailureKind; notFound?: FailureKind } = {},
  ): Promise<void> {
    if (this.busy()) return
    this.#busyState.set(true)
    this.#failureState.set(null)
    try {
      const next = await call()
      // `null` is the user cancelling the shell's executable picker, which is an ordinary outcome
      // and not a failure: they were shown the dialog they said no to, and nothing changed.
      if (next !== null) this.#configState.set(next)
    } catch (error) {
      // Two codes mean something operation-specific, and only those two are overridable. A failed
      // first load says the configuration could not be read rather than "something went wrong";
      // `addManual`'s `NotFound` is a file the user just picked rather than a stale row. Every
      // other code says the same thing whichever call raised it, and a `Forbidden` on the load
      // still says what it is rather than being flattened into the override.
      const kind = classify(error)
      const override =
        kind === 'generic'
          ? overrides.generic
          : kind === 'notFound'
            ? overrides.notFound
            : undefined
      this.#failureState.set(override ?? kind)
      // Before `busy` is cleared, deliberately: writing a model signal re-emits `valueChange`, and
      // the handler it reaches short-circuits twice over — on the value being what is already
      // stored, and on `#run` refusing to start while a call is in flight.
      this.#resyncControls()
      // The sentence the user is shown is this app's own, in this app's language; the shell's
      // message and its `details.cause` — the Node error behind a failed detection — are the
      // diagnosis, and this is where they land.
      console.error('slicers: a configuration call failed', error)
    } finally {
      this.#busyState.set(false)
    }
  }

  /**
   * Puts every control back to what the stored configuration actually says.
   *
   * No index lines up with anything: whatever install a group is *showing* as chosen, the truth
   * about that install is its own product's binding, so each group answers for itself and a group
   * that never diverged is left alone.
   */
  #resyncControls(): void {
    const config = this.config()
    for (const group of this.radioGroups()) {
      // Total, and deliberately branchless past this: whatever install a group is *showing*, the
      // stored truth about it is its own product's binding, and an id the configuration no longer
      // carries means nothing is bound. A group that never moved is written its own value back.
      //
      // An earlier version skipped groups it judged already in step. That judgement had no
      // observable consequence — a signal written its current value emits a `valueChange` the
      // handler discards — so it was a branch no assertion could ever fail on, and it is gone.
      const install = config?.installs.find((row) => row.id === group.value())
      group.value.set(install ? (config?.bindings[install.slicerId] ?? null) : null)
    }
    this.defaultSelect()?.value.set(config?.defaultSlicerId ?? null)
  }
}
