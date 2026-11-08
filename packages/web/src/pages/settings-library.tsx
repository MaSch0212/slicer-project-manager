import { useNavigate } from '@solidjs/router'
import { createResource, createSignal, Show } from 'solid-js'
import { desktop, type DesktopClient } from '../core/desktop'
import { t } from '../core/i18n'
import { notify } from '../core/notify'
import { Button, FolderOpen, Globe, SettingRow, Text } from '../ui'

/**
 * Where the library lives, on the desktop (subsystem G 6.1): the folder or the server that is open
 * now, and the way to another one. A card of the General tab, rendered only in the desktop app.
 *
 * In local mode it offers the two things G specified, a folder and a server; in remote mode the
 * folder control is not offered (the library on screen belongs to the server, and a folder button
 * beside it would swap the whole app to somebody else's data), so the one way out is the same
 * question the application menu asks.
 *
 * The shell loads the new library into this window itself, so nothing here navigates after a
 * choice; the connect page is where a server address is typed, so that is a plain navigation.
 *
 * The heading and the sentence above it belong to the settings page's Library section, not to
 * this card, so that the section menu and the heading can never drift apart.
 */
export function LibraryLocation(props: { client?: DesktopClient }) {
  const client = () => props.client ?? desktop
  const navigate = useNavigate()
  // A library the shell cannot describe (no desktop bridge: a browser that was told it can pick a
  // folder) leaves the card with its title and nothing to show, not an error.
  const [state] = createResource(() =>
    client()
      .libraryState()
      .catch(() => null),
  )
  const [busy, setBusy] = createSignal(false)

  async function run(action: () => Promise<unknown>) {
    setBusy(true)
    try {
      await action()
    } catch (error) {
      console.error('could not change the library', error)
      notify.error(t('settings.libraryFailed'))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div class="flex flex-col gap-5">
      <Show when={state()}>
        {(current) => (
          <>
            <SettingRow
              label={
                current().mode === 'remote'
                  ? t('settings.libraryCurrentServer')
                  : t('settings.libraryCurrentFolder')
              }
            >
              <Text variant="mono" class="break-all">
                {current().mode === 'remote'
                  ? (current().origin ?? '')
                  : (current().dir ?? t('settings.libraryNone'))}
              </Text>
            </SettingRow>
            <div class="flex flex-wrap gap-2">
              <Show
                when={current().mode !== 'remote'}
                fallback={
                  <Button
                    icon={FolderOpen}
                    loading={busy()}
                    onClick={() => void run(() => client().chooseLibrary())}
                  >
                    {t('settings.chooseLibrary')}
                  </Button>
                }
              >
                <Button
                  icon={FolderOpen}
                  loading={busy()}
                  onClick={() => void run(() => client().pickFolder())}
                >
                  {t('settings.chooseFolder')}
                </Button>
                <Button variant="ghost" icon={Globe} onClick={() => navigate('/desktop/connect')}>
                  {t('settings.connectToServer')}
                </Button>
              </Show>
            </div>
          </>
        )}
      </Show>
    </div>
  )
}
