import { createEffect, createSignal, on, Show } from 'solid-js'
import type { CreateUserInput } from '../api/generated'
import { isApiError } from '../core/api/error'
import { t } from '../core/i18n'
import { errorMessage } from '../core/i18n/errors'
import { notify } from '../core/notify'
import {
  hasErrors,
  parseQuotaMib,
  validateNewUser,
  type CreateUserErrors,
} from '../core/validation'
import { Alert, Button, Checkbox, CopyField, Dialog, FormField, Input } from '../ui'

/** The dialog that creates a user. It closes only once the server has accepted the user. */
export function CreateUserDialog(props: {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Creates the user. Rejects with the server's refusal, which the dialog shows. */
  onCreate: (input: CreateUserInput) => Promise<void>
}) {
  const [username, setUsername] = createSignal('')
  const [displayName, setDisplayName] = createSignal('')
  const [isAdmin, setIsAdmin] = createSignal(false)
  const [quota, setQuota] = createSignal('')
  const [errors, setErrors] = createSignal<CreateUserErrors>({})
  const [failure, setFailure] = createSignal<string | null>(null)
  const [busy, setBusy] = createSignal(false)

  // Every opening starts empty, not from whatever was typed last time.
  createEffect(
    on(
      () => props.open,
      (open) => {
        if (!open) return
        setUsername('')
        setDisplayName('')
        setIsAdmin(false)
        setQuota('')
        setErrors({})
        setFailure(null)
      },
    ),
  )

  async function submit(event: SubmitEvent) {
    event.preventDefault()
    setFailure(null)
    const found = validateNewUser({
      username: username(),
      displayName: displayName(),
      quotaMib: quota(),
    })
    setErrors(found)
    if (hasErrors(found)) return
    const quotaBytes = parseQuotaMib(quota())
    setBusy(true)
    try {
      await props.onCreate({
        username: username().trim(),
        displayName: displayName().trim(),
        isAdmin: isAdmin(),
        quotaBytes: quotaBytes === 'invalid' ? null : quotaBytes,
      })
      props.onOpenChange(false)
    } catch (error) {
      if (isApiError(error) && error.code === 'Conflict') {
        setErrors({ username: t('admin.usernameTaken') })
      } else {
        setFailure(errorMessage(error))
      }
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog
      open={props.open}
      onOpenChange={props.onOpenChange}
      title={t('admin.createTitle')}
      description={t('admin.createLead')}
      closeLabel={t('common.close')}
      footer={
        <>
          <Button variant="secondary" onClick={() => props.onOpenChange(false)}>
            {t('common.cancel')}
          </Button>
          <Button variant="primary" type="submit" form="create-user-form" loading={busy()}>
            {t('admin.createUser')}
          </Button>
        </>
      }
    >
      <form id="create-user-form" class="flex flex-col gap-4 py-1" onSubmit={submit} novalidate>
        <FormField
          label={t('auth.username')}
          hint={t('admin.usernameRule')}
          error={errors().username}
          required
        >
          <Input
            autofocus
            autocomplete="off"
            autocapitalize="none"
            spellcheck={false}
            value={username()}
            onInput={(event) => setUsername(event.currentTarget.value)}
          />
        </FormField>
        <FormField label={t('admin.displayName')} error={errors().displayName} required>
          <Input
            autocomplete="off"
            value={displayName()}
            onInput={(event) => setDisplayName(event.currentTarget.value)}
          />
        </FormField>
        <FormField label={t('admin.quotaMiB')} hint={t('admin.quotaHint')} error={errors().quota}>
          <Input
            inputmode="numeric"
            autocomplete="off"
            value={quota()}
            onInput={(event) => setQuota(event.currentTarget.value)}
          />
        </FormField>
        <Checkbox label={t('admin.isAdmin')} checked={isAdmin()} onChange={setIsAdmin} />
        <Show when={failure()}>{(message) => <Alert variant="danger">{message()}</Alert>}</Show>
      </form>
    </Dialog>
  )
}

/** Shows an activation link once, to copy out of band: there is no mail. */
export function ActivationDialog(props: {
  /** The user the link is for and the link itself; `null` keeps the dialog shut. */
  link: { name: string; url: string } | null
  onClose: () => void
}) {
  return (
    <Dialog
      open={props.link !== null}
      onOpenChange={(open) => !open && props.onClose()}
      title={t('admin.activationTitle')}
      description={t('admin.activationLead', { name: props.link?.name ?? '' })}
      closeLabel={t('common.close')}
      footer={
        <Button variant="primary" onClick={() => props.onClose()}>
          {t('admin.done')}
        </Button>
      }
    >
      <div class="py-2">
        <CopyField
          value={props.link?.url ?? ''}
          label={t('admin.linkField')}
          copyLabel={t('admin.copyLink')}
          copiedLabel={t('admin.copied')}
          onFailed={() => notify.error(t('admin.copyFailed'))}
        />
      </div>
    </Dialog>
  )
}

/** Sets or clears one user's quota, in whole MiB. Empty means no limit. */
export function QuotaDialog(props: {
  /** The user being edited and the field's starting text; `null` keeps the dialog shut. */
  target: { name: string; initial: string } | null
  onClose: () => void
  /** Resolves true when the server accepted it; the dialog closes only then. */
  onSave: (bytes: number | null) => Promise<boolean>
}) {
  const [text, setText] = createSignal('')
  const [error, setError] = createSignal<string | undefined>()
  const [busy, setBusy] = createSignal(false)

  createEffect(
    on(
      () => props.target,
      (target) => {
        if (!target) return
        setText(target.initial)
        setError(undefined)
      },
    ),
  )

  async function submit(event: SubmitEvent) {
    event.preventDefault()
    const parsed = parseQuotaMib(text())
    if (parsed === 'invalid') return setError(t('admin.invalidQuota'))
    setError(undefined)
    setBusy(true)
    try {
      if (await props.onSave(parsed)) props.onClose()
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog
      open={props.target !== null}
      onOpenChange={(open) => !open && props.onClose()}
      size="sm"
      title={t('admin.setQuotaTitle', { name: props.target?.name ?? '' })}
      closeLabel={t('common.close')}
      footer={
        <>
          <Button variant="secondary" onClick={() => props.onClose()}>
            {t('common.cancel')}
          </Button>
          <Button variant="primary" type="submit" form="quota-form" loading={busy()}>
            {t('projects.save')}
          </Button>
        </>
      }
    >
      <form id="quota-form" class="py-1" onSubmit={submit} novalidate>
        <FormField label={t('admin.quotaMiB')} hint={t('admin.quotaHint')} error={error()}>
          <Input
            autofocus
            inputmode="numeric"
            autocomplete="off"
            value={text()}
            onInput={(event) => setText(event.currentTarget.value)}
          />
        </FormField>
      </form>
    </Dialog>
  )
}
