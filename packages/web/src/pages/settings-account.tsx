import { createSignal } from 'solid-js'
import { api } from '../core/api/client'
import { isApiError } from '../core/api/error'
import { t } from '../core/i18n'
import { errorMessage } from '../core/i18n/errors'
import { notify } from '../core/notify'
import { auth } from '../core/stores'
import {
  hasErrors,
  validatePasswordChange,
  validateProfile,
  type FieldErrors,
} from '../core/validation'
import { Button, Divider, FormField, Heading, Input, SectionCard } from '../ui'

/**
 * The signed-in user's own account: display name and password. Shown only where there is a session
 * (a shell that signs nobody in has no account to edit, and the server has no password route).
 */
export function AccountSection() {
  return (
    <SectionCard title={t('settings.accountTitle')} description={t('settings.accountLead')}>
      <ProfileForm />
      <Divider />
      <PasswordForm />
    </SectionCard>
  )
}

function ProfileForm() {
  const [name, setName] = createSignal(auth.user()?.displayName ?? '')
  const [errors, setErrors] = createSignal<FieldErrors<'displayName'>>({})
  const [busy, setBusy] = createSignal(false)

  async function submit(event: SubmitEvent) {
    event.preventDefault()
    const found = validateProfile({ displayName: name() })
    setErrors(found)
    if (hasErrors(found)) return
    setBusy(true)
    try {
      auth.setUser(await api.account.updateProfile({ displayName: name().trim() }))
      setName(auth.user()?.displayName ?? name().trim())
      notify.success(t('settings.profileSaved'))
    } catch (error) {
      notify.error(errorMessage(error))
    } finally {
      setBusy(false)
    }
  }

  return (
    <form class="flex flex-col gap-4" onSubmit={submit} novalidate>
      <FormField label={t('settings.username')}>
        <Input value={auth.user()?.username ?? ''} readOnly />
      </FormField>
      <FormField label={t('settings.displayName')} error={errors().displayName}>
        <Input
          autocomplete="name"
          value={name()}
          maxLength={200}
          onInput={(event) => setName(event.currentTarget.value)}
        />
      </FormField>
      <div>
        <Button type="submit" variant="primary" loading={busy()}>
          {t('settings.saveProfile')}
        </Button>
      </div>
    </form>
  )
}

function PasswordForm() {
  const [current, setCurrent] = createSignal('')
  const [next, setNext] = createSignal('')
  const [confirm, setConfirm] = createSignal('')
  const [errors, setErrors] = createSignal<FieldErrors<'current' | 'next' | 'confirm'>>({})
  const [busy, setBusy] = createSignal(false)

  async function submit(event: SubmitEvent) {
    event.preventDefault()
    const found = validatePasswordChange({ current: current(), next: next(), confirm: confirm() })
    setErrors(found)
    if (hasErrors(found)) return
    setBusy(true)
    try {
      await api.account.changePassword(current(), next())
      setCurrent('')
      setNext('')
      setConfirm('')
      notify.success(t('settings.passwordChanged'))
    } catch (error) {
      // A wrong current password is the server's `Unauthorized`, and it belongs on that field.
      if (isApiError(error) && error.code === 'Unauthorized') {
        setErrors({ current: t('settings.passwordWrong') })
      } else {
        notify.error(errorMessage(error))
      }
    } finally {
      setBusy(false)
    }
  }

  return (
    <form class="flex flex-col gap-4" onSubmit={submit} novalidate>
      <Heading level={3}>{t('settings.passwordTitle')}</Heading>
      <FormField label={t('settings.passwordCurrent')} error={errors().current}>
        <Input
          type="password"
          autocomplete="current-password"
          value={current()}
          onInput={(event) => setCurrent(event.currentTarget.value)}
        />
      </FormField>
      <FormField
        label={t('settings.passwordNew')}
        hint={t('common.tooShort', { min: 10 })}
        error={errors().next}
      >
        <Input
          type="password"
          autocomplete="new-password"
          value={next()}
          onInput={(event) => setNext(event.currentTarget.value)}
        />
      </FormField>
      <FormField label={t('auth.confirmPassword')} error={errors().confirm}>
        <Input
          type="password"
          autocomplete="new-password"
          value={confirm()}
          onInput={(event) => setConfirm(event.currentTarget.value)}
        />
      </FormField>
      <div>
        <Button type="submit" loading={busy()}>
          {t('settings.passwordSubmit')}
        </Button>
      </div>
    </form>
  )
}
