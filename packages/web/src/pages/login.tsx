import { Navigate, useNavigate } from '@solidjs/router'
import { createSignal, Show } from 'solid-js'
import { api } from '../core/api/client'
import { t } from '../core/i18n'
import { hasSession, signedIn } from '../core/session'
import { hasErrors, validateLogin } from '../core/validation'
import { Alert, Button, Card, FormField, Heading, Input } from '../ui'

export default function LoginPage() {
  const navigate = useNavigate()
  const [username, setUsername] = createSignal('')
  const [password, setPassword] = createSignal('')
  const [errors, setErrors] = createSignal<ReturnType<typeof validateLogin>>({})
  const [failed, setFailed] = createSignal(false)
  const [busy, setBusy] = createSignal(false)

  async function submit(event: SubmitEvent) {
    event.preventDefault()
    setFailed(false)
    const found = validateLogin({ username: username(), password: password() })
    setErrors(found)
    // An empty field never reaches the network, and so never spends the auth rate limit.
    if (hasErrors(found)) return
    setBusy(true)
    try {
      await signedIn(await api.auth.login(username(), password()))
      navigate('/projects', { replace: true })
    } catch (error) {
      // Unknown user, pending, disabled and wrong password are deliberately one message (parent
      // spec 5.1): telling them apart would be an enumeration oracle. What is logged is a
      // different thing from what is shown, so a misconfigured proxy still leaves a trace.
      console.error('sign-in failed', error)
      setFailed(true)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Show when={!hasSession()} fallback={<Navigate href="/projects" />}>
      <div class="mx-auto flex max-w-sm flex-col gap-6 pt-[8vh]">
        <Card padding="lg">
          <form class="flex flex-col gap-5" onSubmit={submit} novalidate>
            <Heading level={1}>{t('auth.signIn')}</Heading>
            <FormField label={t('auth.username')} error={errors().username}>
              <Input
                autocomplete="username"
                autocapitalize="none"
                spellcheck={false}
                value={username()}
                onInput={(event) => setUsername(event.currentTarget.value)}
              />
            </FormField>
            <FormField label={t('auth.password')} error={errors().password}>
              <Input
                type="password"
                autocomplete="current-password"
                value={password()}
                onInput={(event) => setPassword(event.currentTarget.value)}
              />
            </FormField>
            <Show when={failed()}>
              <Alert variant="danger">{t('auth.signInFailed')}</Alert>
            </Show>
            <Button type="submit" variant="primary" loading={busy()}>
              {t('auth.signIn')}
            </Button>
          </form>
        </Card>
      </div>
    </Show>
  )
}
