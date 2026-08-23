import {
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
  resource,
  signal,
} from '@angular/core'
import { FormField, form, submit, validateStandardSchema } from '@angular/forms/signals'
import { JigErrors } from '@awdlab/jig/errors'
import { JigHint } from '@awdlab/jig/hint'
import { JigInput } from '@awdlab/jig/input'
import { JigInputField } from '@awdlab/jig/input-field'
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
  imports: [FormField, JigInputField, JigInput, JigHint, JigErrors],
  template: `
    <h1>{{ t.translations().admin.title }}</h1>

    <form (submit)="onCreate(); $event.preventDefault()">
      <jig-input-field [label]="t.translations().auth.username">
        <input
          jigInput
          [formField]="createForm.username"
          jigErrors
          [jigErrorsHint]="usernameHint"
        />
        <jig-hint #usernameHint />
      </jig-input-field>
      <jig-input-field [label]="t.translations().admin.displayName">
        <input
          jigInput
          [formField]="createForm.displayName"
          jigErrors
          [jigErrorsHint]="displayNameHint"
        />
        <jig-hint #displayNameHint />
      </jig-input-field>
      <button type="submit" [disabled]="createForm().submitting()">
        {{ t.translations().admin.createUser }}
      </button>
    </form>

    <!-- The activation link is returned exactly once; the admin copies it out of band
         (spec 5.7). -->
    @if (activationUrl(); as url) {
      <p>
        <code>{{ url }}</code>
        <button type="button" (click)="onCopy(url)">{{ t.translations().admin.copyLink }}</button>
      </p>
    }
    @if (errorMessage()) {
      <p role="alert">{{ errorMessage() }}</p>
    }

    <!--
      Ruling 70: value() throws once a load settles to the public 'error' status
      (Resource has no isError()), so every read is gated on status() first — the
      same loadFailed/loaded pair as project-detail.page.ts, applied to a list resource.
    -->
    @if (usersLoadFailed()) {
      <p role="alert">{{ t.translations().errors.generic }}</p>
    } @else if (loadedUsers(); as list) {
      <table>
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
              <td>{{ user.status }}</td>
              <td>
                <input
                  type="checkbox"
                  [checked]="user.isAdmin"
                  (change)="onToggleAdmin(user)"
                  [attr.aria-label]="t.translations().admin.isAdmin"
                />
              </td>
              <td>
                <!-- Ruling 72.4: shared with project-detail.page.ts, so a file size and a
                     disk-usage figure never render two different shapes. -->
                {{ formatBytes(user.diskUsageBytes) }}
                @if (usagePercent(user); as percent) {
                  <span> ({{ percent }}%)</span>
                }
              </td>
              <td>
                <!-- Ruling 72.3: the stored quota now renders in the same human units the
                     input is labelled with, instead of a raw byte count next to a MiB field. -->
                <span>
                  {{
                    user.quotaBytes === null
                      ? t.translations().admin.unlimited
                      : formatBytes(user.quotaBytes)
                  }}
                </span>
                <input
                  type="number"
                  step="any"
                  [attr.aria-label]="t.translations().admin.quotaMiB"
                  (change)="onQuotaInput(user, $event)"
                />
              </td>
              <td>
                <button type="button" (click)="onReissue(user)">
                  {{ t.translations().admin.reissue }}
                </button>
                <button type="button" (click)="onToggleDisabled(user)">
                  {{
                    user.status === 'disabled'
                      ? t.translations().admin.enable
                      : t.translations().admin.disable
                  }}
                </button>
                @if (deleteArmedId() === user.id) {
                  <button type="button" (click)="confirmDelete(user)">
                    {{ t.translations().projects.confirmDeleteAction }}
                  </button>
                  <button type="button" (click)="cancelDelete()">
                    {{ t.translations().projects.cancel }}
                  </button>
                } @else {
                  <button
                    type="button"
                    (click)="armDelete(user)"
                    [attr.aria-label]="t.translations().admin.deleteUser + ' ' + user.username"
                  >
                    x
                  </button>
                }
              </td>
            </tr>
            @if (deleteArmedId() === user.id) {
              <tr>
                <td colspan="6">
                  <!-- Ruling 73: deleting a user cascades all of their project and file
                       metadata, with no undo — and (the genuinely surprising part) their
                       library folder is deliberately left on disk, so this has to say so. -->
                  <p role="alert">{{ t.translations().admin.confirmDeleteUser }}</p>
                </td>
              </tr>
            }
          }
        </tbody>
      </table>
    } @else {
      <p>...</p>
    }
  `,
})
export class UsersPage {
  private readonly api = inject(API_CLIENT)
  protected readonly t = inject(TranslateService)
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

  private async guard(action: () => Promise<void>): Promise<void> {
    this.errorMessage.set(null)
    try {
      await action()
    } catch (error) {
      this.errorMessage.set(this.describe(error))
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

  onReissue(user: UserDto): Promise<void> {
    return this.guard(async () => {
      this.activationUrl.set((await this.api.users.reissueInvite(user.id)).activationUrl)
    })
  }

  onToggleDisabled(user: UserDto): Promise<void> {
    return this.guard(async () => {
      await this.api.users.update(user.id, { isDisabled: user.status !== 'disabled' })
      this.users.reload()
    })
  }

  onToggleAdmin(user: UserDto): Promise<void> {
    return this.guard(async () => {
      await this.api.users.update(user.id, { isAdmin: !user.isAdmin })
      this.users.reload()
    })
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
  onSetQuota(user: UserDto, megabytes: number | null): Promise<void> {
    if (megabytes !== null) {
      const bytes = megabytes * MIB
      if (!updateUserSchema.shape.quotaBytes.safeParse(bytes).success) {
        this.errorMessage.set(this.t.translations().admin.invalidQuota)
        return Promise.resolve()
      }
    }
    return this.guard(async () => {
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

  onDelete(user: UserDto): Promise<void> {
    return this.guard(async () => {
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
