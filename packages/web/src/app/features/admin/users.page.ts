import {
  ChangeDetectionStrategy,
  Component,
  computed,
  ElementRef,
  inject,
  resource,
  signal,
} from '@angular/core'
import { FormField, form, submit, validateStandardSchema } from '@angular/forms/signals'
import { JigButton } from '@awdlab/jig/button'
import { JigCheckbox } from '@awdlab/jig/checkbox'
import { JigErrors } from '@awdlab/jig/errors'
import { JigHint } from '@awdlab/jig/hint'
import { JigInput } from '@awdlab/jig/input'
import { JigInputField } from '@awdlab/jig/input-field'
import { JigMessage } from '@awdlab/jig/message'
import { JigSpinner } from '@awdlab/jig/spinner'
import { JigTag } from '@awdlab/jig/tag'
import { JigTooltip } from '@awdlab/jig/tooltip'
import { JigIcon } from '@awdlab/jig/icon'
import tablerCopy from '@iconify/icons-tabler/copy'
import tablerMailForward from '@iconify/icons-tabler/mail-forward'
import tablerTrash from '@iconify/icons-tabler/trash'
import tablerUserPlus from '@iconify/icons-tabler/user-plus'
import type { UserDto } from '@spm/contract/dtos.ts'
import { isAppError } from '@spm/contract/errors.ts'
import { createUserSchema, updateUserSchema } from '@spm/contract/schemas.ts'
import { API_CLIENT } from '../../core/api/api-client.token'
import { formatBytes } from '../../core/format-bytes'
import { TranslateService } from '../../core/i18n/translate.service'

const MIB = 1024 * 1024

type CreateModel = {
  username: string
  displayName: string
  isAdmin: boolean
  quotaBytes: number | null
}

const EMPTY_CREATE_MODEL: CreateModel = {
  username: '',
  displayName: '',
  isAdmin: false,
  quotaBytes: null,
}

@Component({
  selector: 'spm-users-page',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    FormField,
    JigButton,
    JigCheckbox,
    JigErrors,
    JigHint,
    JigIcon,
    JigInput,
    JigInputField,
    JigMessage,
    JigSpinner,
    JigTag,
    JigTooltip,
  ],
  template: `
    <main class="spm-main">
      <div class="spm-page-head">
        <h1>{{ t.translations().admin.title }}</h1>
      </div>

      <form class="spm-card spm-row spm-new-user" (submit)="onCreate(); $event.preventDefault()">
        <div class="spm-field spm-grow">
          <jig-input-field [label]="t.translations().auth.username" labelKind="on">
            <input
              jigInput
              [formField]="createForm.username"
              jigErrors
              [jigErrorsHint]="usernameHint"
            />
          </jig-input-field>
          <jig-hint #usernameHint />
        </div>
        <div class="spm-field spm-grow">
          <jig-input-field [label]="t.translations().admin.displayName" labelKind="on">
            <input
              jigInput
              [formField]="createForm.displayName"
              jigErrors
              [jigErrorsHint]="displayNameHint"
            />
          </jig-input-field>
          <jig-hint #displayNameHint />
        </div>
        <button jigButton kind="primary" type="submit" [disabled]="createForm().submitting()">
          <jig-icon [icon]="icons.create" />
          {{ t.translations().admin.createUser }}
        </button>
      </form>

      <!-- The activation link is returned exactly once; the admin copies it out of band
           (spec 5.7). -->
      @if (activationUrl(); as url) {
        <jig-message color="info" class="spm-block-mb">
          <span class="spm-row">
            <code class="spm-grow spm-code">{{ url }}</code>
            <button jigButton kind="secondary" type="button" (click)="onCopy(url)">
              <jig-icon [icon]="icons.copy" />
              {{ t.translations().admin.copyLink }}
            </button>
          </span>
        </jig-message>
      }
      @if (errorMessage(); as message) {
        <jig-message color="error" role="alert" class="spm-block-mb">{{ message }}</jig-message>
      }

      <!--
        Ruling 70: value() throws once a load settles to the public 'error' status
        (Resource has no isError()), so every read is gated on status() first — the
        same loadFailed/loaded pair as project-detail.page.ts, applied to a list resource.
      -->
      @if (usersLoadFailed()) {
        <jig-message color="error" role="alert">{{ t.translations().errors.generic }}</jig-message>
      } @else if (loadedUsers(); as list) {
        <div class="spm-table-wrap">
          <table class="spm-table">
            <thead>
              <tr>
                <th>{{ t.translations().auth.username }}</th>
                <th>{{ t.translations().admin.status }}</th>
                <th>{{ t.translations().admin.isAdmin }}</th>
                <th>{{ t.translations().admin.usage }}</th>
                <th>{{ t.translations().admin.quota }}</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              @for (user of list; track user.id) {
                <tr>
                  <td>{{ user.username }}</td>
                  <td>
                    <jig-tag [color]="statusColor(user.status)">{{ user.status }}</jig-tag>
                  </td>
                  <td>
                    <jig-checkbox
                      #adminBox
                      [value]="user.isAdmin"
                      (valueChange)="onToggleAdmin(user, $event === true, adminBox)"
                      [label]="t.translations().admin.isAdmin + ': ' + user.username"
                    />
                  </td>
                  <td>
                    <!-- Ruling 72.4: shared with project-detail.page.ts, so a file size and a
                         disk-usage figure never render two different shapes. -->
                    {{ formatBytes(user.diskUsageBytes) }}
                    @if (usagePercent(user); as percent) {
                      <span class="spm-muted"> ({{ percent }}%)</span>
                    }
                  </td>
                  <td>
                    <div class="spm-row spm-quota">
                      <!-- Ruling 72.3: the stored quota renders in the same human units the
                           input is labelled with, not a raw byte count beside a MiB field. -->
                      <span class="spm-muted">
                        {{
                          user.quotaBytes === null
                            ? t.translations().admin.unlimited
                            : formatBytes(user.quotaBytes)
                        }}
                      </span>
                      <jig-input-field class="spm-quota-field">
                        <!-- jigInput type=number rather than jigNumberInput: the latter
                             formats its own value, while onQuotaInput reads the raw value
                             off the event target. -->
                        <input
                          jigInput
                          type="number"
                          step="any"
                          [attr.aria-label]="t.translations().admin.quotaMiB"
                          (change)="onQuotaInput(user, $event)"
                        />
                      </jig-input-field>
                    </div>
                  </td>
                  <td>
                    <div class="spm-row">
                      <button
                        jigButton
                        kind="icon"
                        type="button"
                        [jigTooltip]="t.translations().admin.reissue"
                        jigTooltipAutoAriaMode="label"
                        (click)="onReissue(user)"
                      >
                        <jig-icon [icon]="icons.reissue" />
                      </button>
                      <button jigButton kind="text" type="button" (click)="onToggleDisabled(user)">
                        {{
                          user.status === 'disabled'
                            ? t.translations().admin.enable
                            : t.translations().admin.disable
                        }}
                      </button>
                      @if (deleteArmedId() === user.id) {
                        <button
                          jigButton
                          kind="primary"
                          color="error"
                          type="button"
                          (click)="confirmDelete(user)"
                        >
                          {{ t.translations().projects.confirmDeleteAction }}
                        </button>
                        <button jigButton kind="text" type="button" (click)="cancelDelete()">
                          {{ t.translations().projects.cancel }}
                        </button>
                      } @else {
                        <button
                          jigButton
                          kind="icon"
                          color="error"
                          type="button"
                          (click)="armDelete(user)"
                          [jigTooltip]="t.translations().admin.deleteUser + ' ' + user.username"
                          jigTooltipAutoAriaMode="label"
                        >
                          <jig-icon [icon]="icons.delete" />
                        </button>
                      }
                    </div>
                  </td>
                </tr>
                @if (deleteArmedId() === user.id) {
                  <tr>
                    <td colspan="6">
                      <!-- Ruling 73: deleting a user cascades all of their project and file
                           metadata, with no undo — and (the genuinely surprising part) their
                           library folder is deliberately left on disk, so this has to say so. -->
                      <jig-message color="warning" role="alert">
                        {{ t.translations().admin.confirmDeleteUser }}
                      </jig-message>
                    </td>
                  </tr>
                }
              }
            </tbody>
          </table>
        </div>
      } @else {
        <jig-spinner centered [size]="40" />
      }
    </main>
  `,
})
export class UsersPage {
  private readonly api = inject(API_CLIENT)
  protected readonly t = inject(TranslateService)
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef)

  protected readonly icons = {
    create: tablerUserPlus,
    copy: tablerCopy,
    reissue: tablerMailForward,
    delete: tablerTrash,
  }

  /** Status reads at a glance rather than as a bare word in a cell. */
  protected statusColor(status: string): 'success' | 'warning' | 'surface' {
    if (status === 'active') return 'success'
    if (status === 'pending') return 'warning'
    return 'surface'
  }
  protected readonly formatBytes = formatBytes

  readonly users = resource({ loader: () => this.api.users.list() })

  /** See the template comment above: `value()` throws once status() is 'error'. */
  protected readonly usersLoadFailed = computed(() => this.users.status() === 'error')
  /** undefined while loading, and (unlike `value()`) safe to read after a failed load. */
  protected readonly loadedUsers = computed<UserDto[] | undefined>(() =>
    this.users.hasValue() ? this.users.value() : undefined,
  )

  readonly activationUrl = signal<string | null>(null)
  readonly errorMessage = signal<string | null>(null)

  /** Ruling 73: which row's delete is armed, waiting for a confirming second press. */
  readonly deleteArmedId = signal<string | null>(null)

  readonly createModel = signal<CreateModel>({ ...EMPTY_CREATE_MODEL })
  // Ruling 71: the same schema the server validates with, via submit() so an empty or
  // too-short username surfaces in the jig hints instead of firing a request the server can
  // only reject (the fourth time this plan made this exact mistake).
  protected readonly createForm = form(this.createModel, (path) => {
    validateStandardSchema(path, createUserSchema)
  })

  usagePercent(user: UserDto): number | null {
    if (user.quotaBytes === null || user.quotaBytes === 0) return null
    return Math.round((user.diskUsageBytes / user.quotaBytes) * 100)
  }

  private describe(error: unknown): string {
    return isAppError(error) && error.code === 'LastActiveAdmin'
      ? this.t.translations().admin.lastAdmin
      : this.t.translations().errors.generic
  }

  /** Returns whether `action` landed, so a caller can undo an optimistic UI change. */
  private async guard(action: () => Promise<void>): Promise<boolean> {
    this.errorMessage.set(null)
    try {
      await action()
      return true
    } catch (error) {
      this.errorMessage.set(this.describe(error))
      return false
    }
  }

  async onCreate(): Promise<void> {
    this.errorMessage.set(null)
    await submit(this.createForm, {
      // `submit` runs `action` only when the form is valid, and it is try/finally with no
      // catch (established fact) — the network call needs its own try/catch, same as
      // LoginPage/ProjectDetailPage.
      action: async () => {
        try {
          const result = await this.api.users.create(this.createModel())
          this.activationUrl.set(result.activationUrl)
          this.createModel.set({ ...EMPTY_CREATE_MODEL })
          this.users.reload()
        } catch (error) {
          this.errorMessage.set(this.describe(error))
        }
      },
      // jigErrors shows on `touched`, so an untouched invalid field would fail silently.
      onInvalid: (field) => {
        field().markAsTouched()
      },
    })
  }

  async onReissue(user: UserDto): Promise<void> {
    await this.guard(async () => {
      this.activationUrl.set((await this.api.users.reissueInvite(user.id)).activationUrl)
    })
  }

  async onToggleDisabled(user: UserDto): Promise<void> {
    await this.guard(async () => {
      await this.api.users.update(user.id, { isDisabled: user.status !== 'disabled' })
      this.users.reload()
    })
  }

  /**
   * `event` carries the checkbox the browser has already flipped. `[checked]` binds to
   * `user.isAdmin`, which a refused toggle never changes — and Angular only writes a
   * property binding when its value changes, so nothing puts the box back on its own.
   * Reloading the list does not do it either: with `track user.id` the same input element is
   * reused and the binding's value is identical. So a refusal (a `LastActiveAdmin` 409, most
   * of all) used to leave the box visually demoted right beside the error explaining that it
   * had not been. Restoring it by hand is what keeps the control honest.
   */
  async onToggleAdmin(user: UserDto, next: boolean, box?: JigCheckbox<false>): Promise<void> {
    // Every emission that already agrees with the stored state is an echo, not a user
    // action, and acting on one is a real bug rather than a wasted call: the restore below
    // emits, and `update` would then fire a *second* time carrying the same patch — which
    // succeeds, quietly performing the very change the server had just refused. Angular
    // writing the one-way [value] binding back into the model does the same thing.
    if (next === user.isAdmin) return

    const ok = await this.guard(async () => {
      await this.api.users.update(user.id, { isAdmin: next })
      this.users.reload()
    })
    if (ok) return
    if (!box) return

    // Restoring the model alone is not enough, and this is the whole reason the method takes
    // the control at all. The browser flips the native checkbox itself, so the DOM is already
    // wrong before Angular hears about it; the model then goes false and back to true inside
    // one change-detection cycle, which means Angular's binding cache only ever observed
    // `true` and it writes nothing. The box would sit unchecked beside the error explaining
    // that it had not been unchecked.
    //
    // So: put the model right, then repair the element the browser desynchronised. The
    // element is found through the control's own public `inputId()` rather than by reaching
    // into its internals; jig generates that id to be document-unique, which is exactly what
    // getElementById wants and saves escaping it into a selector.
    box.value.set(user.isAdmin)
    const input = this.host.nativeElement.ownerDocument.getElementById(box.inputId())
    if (input instanceof HTMLInputElement) input.checked = user.isAdmin
  }

  /**
   * Ruling 72: `megabytes` is the already-parsed, unit-converted number the caller wants
   * stored (the template's onQuotaInput, or a direct call) — `null` clears the quota back to
   * unlimited. Any other value is validated against the exact schema the server enforces
   * (`updateUserSchema`'s `quotaBytes`: an integer, positive byte count) *before* any network
   * call: zero and negative numbers are invalid input, and a fractional MiB entry (e.g. 0.3)
   * can multiply into a fractional byte count that the schema — and the server — would
   * reject anyway. Refused, not reinterpreted: nothing here silently maps an invalid entry
   * onto some other meaning.
   */
  async onSetQuota(user: UserDto, megabytes: number | null): Promise<void> {
    if (megabytes !== null) {
      const bytes = megabytes * MIB
      if (!updateUserSchema.shape.quotaBytes.safeParse(bytes).success) {
        this.errorMessage.set(this.t.translations().admin.invalidQuota)
        return
      }
    }
    await this.guard(async () => {
      await this.api.users.update(user.id, {
        quotaBytes: megabytes === null ? null : megabytes * MIB,
      })
      this.users.reload()
    })
  }

  /**
   * Ruling 72.1: an emptied field means "clear the quota" (→ null); any other text is parsed
   * as a MiB count and handed to onSetQuota, which does the actual validation. The old
   * `valueAsNumber || null` mapped both an empty field *and* a typed `0` onto "unlimited" —
   * the same outcome for two opposite intents.
   */
  protected onQuotaInput(user: UserDto, event: Event): void {
    const element = event.target as HTMLInputElement
    const raw = element.value.trim()
    void this.onSetQuota(user, raw === '' ? null : element.valueAsNumber)
  }

  /** Ruling 73: first press arms a row; a second, confirming press actually deletes it. */
  armDelete(user: UserDto): void {
    this.errorMessage.set(null)
    this.deleteArmedId.set(user.id)
  }

  cancelDelete(): void {
    this.deleteArmedId.set(null)
  }

  confirmDelete(user: UserDto): Promise<void> {
    this.deleteArmedId.set(null)
    return this.onDelete(user)
  }

  async onDelete(user: UserDto): Promise<void> {
    await this.guard(async () => {
      await this.api.users.delete(user.id)
      this.users.reload()
    })
  }

  protected async onCopy(url: string): Promise<void> {
    try {
      await navigator.clipboard.writeText(url)
    } catch {
      // The activation link is shown exactly once (spec 5.7); a silently failed copy would
      // leave the admin thinking it worked when it did not.
      this.errorMessage.set(this.t.translations().errors.generic)
    }
  }
}
