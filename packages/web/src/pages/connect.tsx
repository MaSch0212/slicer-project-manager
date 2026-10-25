import { createSignal, Show } from 'solid-js'
import { desktop, type DesktopClient } from '../core/desktop'
import { t } from '../core/i18n'
import { isApiError } from '../core/api/error'
import { isServerAddress } from '../core/validation'
import { Alert, Button, FolderOpen, FormField, Globe, Input, PageHeader, SectionCard } from '../ui'

/**
 * Where the desktop app asks where the library is: a folder on this computer, or a server. It is
 * the first page of a first run, and the page the application menu's "Choose library…" sends a
 * connected app to; it needs no session, because there is no library yet to have one in.
 *
 * The page never names a folder: the operating system's dialog is opened by the shell and its
 * answer does not pass through here. It supplies one thing, a server address, and the shell asks
 * the user to confirm that address in a native dialog before anything connects. When either
 * succeeds the shell loads the new library into this window itself, so the page does not navigate.
 */
export default function ConnectPage(props: { client?: DesktopClient }) {
  const client = () => props.client ?? desktop
  const [url, setUrl] = createSignal('')
  const [urlError, setUrlError] = createSignal<string>()
  const [folderBusy, setFolderBusy] = createSignal(false)
  const [serverBusy, setServerBusy] = createSignal(false)
  const [failure, setFailure] = createSignal<string>()

  async function chooseFolder() {
    setFailure(undefined)
    setFolderBusy(true)
    try {
      await client().pickFolder()
    } catch (error) {
      console.error('could not open the library folder', error)
      setFailure(t('settings.libraryFailed'))
    } finally {
      setFolderBusy(false)
    }
  }

  async function connect(event: SubmitEvent) {
    event.preventDefault()
    setFailure(undefined)
    // A malformed address never reaches the shell, which would refuse it with the same words.
    if (!isServerAddress(url())) {
      setUrlError(t('settings.serverUrlInvalid'))
      return
    }
    setUrlError(undefined)
    setServerBusy(true)
    try {
      await client().connectRemote(url().trim())
    } catch (error) {
      console.error('could not connect to the server', error)
      // A refused address is the user's to fix; anything else is the connection's.
      setFailure(
        isApiError(error) && error.code === 'Validation'
          ? t('desktop.connectFailed')
          : t('settings.connectFailed'),
      )
    } finally {
      setServerBusy(false)
    }
  }

  return (
    <div class="mx-auto flex max-w-2xl flex-col gap-6 pt-[6vh]">
      <PageHeader title={t('desktop.connectTitle')} description={t('desktop.connectLead')} />
      <Show when={failure()}>{(message) => <Alert variant="danger">{message()}</Alert>}</Show>
      <SectionCard title={t('desktop.localHeading')} description={t('desktop.localLead')}>
        <div>
          <Button
            variant="primary"
            icon={FolderOpen}
            loading={folderBusy()}
            onClick={() => void chooseFolder()}
          >
            {t('desktop.chooseFolder')}
          </Button>
        </div>
      </SectionCard>
      <SectionCard title={t('desktop.remoteHeading')} description={t('desktop.remoteLead')}>
        <form class="flex flex-col gap-4" onSubmit={connect} novalidate>
          <FormField
            label={t('desktop.serverUrl')}
            hint={t('desktop.serverUrlHint')}
            error={urlError()}
          >
            <Input
              type="url"
              inputmode="url"
              autocapitalize="none"
              spellcheck={false}
              placeholder="https://"
              value={url()}
              onInput={(event) => setUrl(event.currentTarget.value)}
            />
          </FormField>
          <div>
            <Button type="submit" icon={Globe} loading={serverBusy()}>
              {t('desktop.connect')}
            </Button>
          </div>
        </form>
      </SectionCard>
    </div>
  )
}
