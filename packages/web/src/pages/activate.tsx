import { useLocation, useNavigate } from '@solidjs/router'
import { createSignal, Match, onMount, Show, Switch } from 'solid-js'
import { api } from '../core/api/client'
import { isApiError } from '../core/api/error'
import { t } from '../core/i18n'
import { signedIn } from '../core/session'
import { hasErrors, validateActivation } from '../core/validation'
import { Alert, Button, Card, FormField, Heading, Input, Spinner, Text } from '../ui'

/** Only a dead token means the link itself is bad; anything else leaves a working form up. */
const DEAD_TOKEN_CODES = new Set(['InvalidToken', 'TokenExpired', 'NotFound'])

type Phase = 'checking' | 'invalid' | 'ready'

/**
 * `/activate#<token>`: the link the server prints. The token is in the fragment so it never
 * reaches a server log or a Referer header. The link is checked before a password is asked for.
 */
export default function ActivatePage() {
  const navigate = useNavigate()
  const location = useLocation()
  const token = () => location.hash.replace(/^#/, '')

  const [phase, setPhase] = createSignal<Phase>('checking')
  const [username, setUsername] = createSignal<string>()
  const [password, setPassword] = createSignal('')
  const [confirm, setConfirm] = createSignal('')
  const [errors, setErrors] = createSignal<ReturnType<typeof validateActivation>>({})
  const [failed, setFailed] = createSignal(false)
  const [busy, setBusy] = createSignal(false)

  onMount(async () => {
    if (token() === '') return setPhase('invalid')
    try {
      const check = await api.auth.checkToken(token())
      if (!check.valid) return setPhase('invalid')
      setUsername(check.username)
      setPhase('ready')
    } catch {
      setPhase('invalid')
    }
  })

  async function submit(event: SubmitEvent) {
    event.preventDefault()
    setFailed(false)
    const found = validateActivation({ password: password(), confirm: confirm() })
    setErrors(found)
    if (hasErrors(found)) return
    setBusy(true)
    try {
      await signedIn(await api.auth.activate(token(), password()))
      navigate('/projects', { replace: true })
    } catch (error) {
      if (isApiError(error) && DEAD_TOKEN_CODES.has(error.code)) setPhase('invalid')
      else setFailed(true)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div class="mx-auto flex max-w-sm flex-col gap-6 pt-[8vh]">
      <Switch>
        <Match when={phase() === 'checking'}>
          <div class="flex justify-center">
            <Spinner size="lg" label={t('common.loading')} />
          </div>
        </Match>
        <Match when={phase() === 'invalid'}>
          <Alert variant="danger">{t('auth.activateInvalid')}</Alert>
        </Match>
        <Match when={phase() === 'ready'}>
          <Card padding="lg">
            <form class="flex flex-col gap-5" onSubmit={submit} novalidate>
              <div class="flex flex-col gap-1">
                <Heading level={1}>{t('auth.activateTitle')}</Heading>
                <Show when={username()}>
                  <Text variant="muted">{username()}</Text>
                </Show>
              </div>
              <FormField
                label={t('auth.password')}
                hint={t('common.tooShort', { min: 10 })}
                error={errors().password}
              >
                <Input
                  type="password"
                  autocomplete="new-password"
                  value={password()}
                  onInput={(event) => setPassword(event.currentTarget.value)}
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
              <Show when={failed()}>
                <Alert variant="danger">{t('errors.generic')}</Alert>
              </Show>
              <Button type="submit" variant="primary" loading={busy()}>
                {t('auth.activateSubmit')}
              </Button>
            </form>
          </Card>
        </Match>
      </Switch>
    </div>
  )
}
