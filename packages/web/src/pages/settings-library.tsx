import { useNavigate } from '@solidjs/router'
import { createResource, createSignal, onCleanup, Show } from 'solid-js'
import type { LibrarySyncDto } from '../api/generated'
import { desktop, type DesktopClient } from '../core/desktop'
import { t } from '../core/i18n'
import { notify } from '../core/notify'
import { Button, FolderOpen, Globe, RefreshCw, SettingRow, Text } from '../ui'

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
 * With a server connected, the server's library is also on this computer: synced into a folder
 * (a default one until the user chooses another), both ways, like a cloud drive. The card names
 * that folder, says how the sync is going, and lets the user move it.
 *
 * The heading and the sentence above it belong to the settings page's Library section, not to
 * this card, so that the section menu and the heading can never drift apart.
 */
export function LibraryLocation(props: { client?: DesktopClient }) {
  const client = () => props.client ?? desktop
  const navigate = useNavigate()
  // A library the shell cannot describe (no desktop bridge: a browser that was told it can pick a
  // folder) leaves the card with its title and nothing to show, not an error.
  const [state, { refetch }] = createResource(() =>
    client()
      .libraryState()
      .catch(() => null),
  )
  const [busy, setBusy] = createSignal(false)
  // The sync's status moves on its own: look again every few seconds while a server is connected.
  const timer = setInterval(() => {
    if (state()?.mode === 'remote') void refetch()
  }, 4000)
  onCleanup(() => clearInterval(timer))

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
            <Show when={current().sync}>
              {(sync) => (
                <>
                  <SettingRow label={t('settings.syncFolder')} hint={t('settings.syncFolderHint')}>
                    <Text variant="mono" class="break-all">
                      {sync().dir}
                    </Text>
                  </SettingRow>
                  <SettingRow label={t('settings.syncStatus')}>
                    <span data-testid="sync-status">
                      <Text>{syncStatusText(sync())}</Text>
                    </span>
                  </SettingRow>
                </>
              )}
            </Show>
            <div class="flex flex-wrap gap-2">
              <Show when={current().sync}>
                <Button
                  icon={RefreshCw}
                  loading={busy()}
                  onClick={() =>
                    void run(async () => {
                      await client().chooseSyncFolder()
                      await refetch()
                    })
                  }
                >
                  {t('settings.chooseSyncFolder')}
                </Button>
              </Show>
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

/** One line for where the sync is: synced at what time, working, waiting for a sign-in, or why it stopped. */
export function syncStatusText(sync: LibrarySyncDto): string {
  switch (sync.phase) {
    case 'starting':
    case 'syncing':
      return t('settings.syncSyncing')
    case 'waitingForSignIn':
      return t('settings.syncWaitingForSignIn')
    case 'error':
      return t('settings.syncError', { error: sync.lastError ?? '' })
    case 'idle':
      return sync.lastSyncedAt === null
        ? t('settings.syncSyncing')
        : t('settings.syncIdle', { time: new Date(sync.lastSyncedAt).toLocaleTimeString() })
  }
}
