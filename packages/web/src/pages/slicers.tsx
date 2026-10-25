import { createMemo, For, onMount, Show } from 'solid-js'
import { t, type TranslationKey } from '../core/i18n'
import { desktop, type DesktopClient } from '../core/desktop'
import {
  createSlicersSettings,
  defaultOptions,
  productRows,
  type FailureKind,
} from '../core/slicers'
import {
  Alert,
  Badge,
  Button,
  ChoiceList,
  FormField,
  IconButton,
  Plus,
  RefreshCw,
  SectionCard,
  Select,
  Spinner,
  Text,
  Trash2,
} from '../ui'
import { SettingsLayout } from './settings-layout'
import { SlicerSessionsCard } from './slicer-sessions-card'

const FAILURE_KEY: Record<FailureKind, TranslationKey> = {
  forbidden: 'slicers.errorForbidden',
  conflict: 'slicers.errorConflict',
  notFound: 'slicers.errorNotFound',
  pickedGone: 'slicers.errorPickedGone',
  validation: 'slicers.errorValidation',
  detection: 'slicers.errorDetection',
  load: 'slicers.errorLoad',
  generic: 'errors.generic',
}

/**
 * The slicers installed on this computer, and which install of each product the app launches
 * (spec D 8.4): the Slicers tab of the settings page, reachable only where `canConfigureSlicers`
 * says the shell can do it.
 *
 * **It talks to the shell, not to the library API.** Which slicers this computer has is a property
 * of the computer, not of whichever library is open, so this works the same in local and in remote
 * mode.
 *
 * **The page never picks an install for the user.** Two Curas side by side is the measured case,
 * the shell leaves such a product unbound on purpose, and this page renders that as a question with
 * nothing preselected. Silently preferring the newer one is the behaviour the whole (path, version)
 * identity model exists to avoid.
 */
export default function SlicersPage(props: { client?: DesktopClient }) {
  const settings = createSlicersSettings((props.client ?? desktop).slicers)
  onMount(() => void settings.load())
  const rows = createMemo(() => productRows(settings.config()))
  const defaults = createMemo(() => defaultOptions(rows()))

  return (
    <SettingsLayout active="slicers">
      <div class="flex flex-col gap-6">
        <Text variant="muted">{t('slicers.lead')}</Text>

        <Show when={settings.config()}>
          {(config) => (
            <Show
              when={config().detectionSupported}
              fallback={
                // Off Windows there is no detection at all, so the page says so once and offers the
                // mechanism that does work rather than a button that answers nothing.
                <Alert variant="info">{t('slicers.windowsOnly')}</Alert>
              }
            >
              <div class="flex flex-wrap items-center gap-3">
                <Button
                  variant="primary"
                  icon={RefreshCw}
                  disabled={settings.busy()}
                  onClick={() => void settings.rescan()}
                >
                  {t('slicers.rescan')}
                </Button>
                <Show when={settings.busy()}>
                  <Spinner label={t('common.loading')} />
                </Show>
              </div>
            </Show>
          )}
        </Show>

        <Show when={settings.failure()}>
          {(kind) => (
            <Alert variant="danger">
              <div class="flex flex-col items-start gap-3">
                <span>{t(FAILURE_KEY[kind()])}</span>
                {/* The only way out of a slicers.json this build refuses to overwrite, and a user
                    action by construction: nothing else in the app may throw a newer version's
                    configuration away. */}
                <Show when={settings.offerReset()}>
                  <Button
                    variant="secondary"
                    disabled={settings.busy()}
                    onClick={() => void settings.reset()}
                  >
                    {t('slicers.reset')}
                  </Button>
                </Show>
              </div>
            </Alert>
          )}
        </Show>

        <Show
          when={settings.config()}
          fallback={
            <Show when={!settings.failure()}>
              <Spinner size="lg" label={t('common.loading')} />
            </Show>
          }
        >
          {(config) => (
            <>
              <SectionCard title={t('slicers.defaultTitle')} description={t('slicers.defaultLead')}>
                <Show
                  when={defaults().length > 0}
                  fallback={<Text variant="muted">{t('slicers.defaultNone')}</Text>}
                >
                  <FormField label={t('slicers.defaultTitle')}>
                    <Select
                      placeholder={t('slicers.defaultPlaceholder')}
                      disabled={settings.busy()}
                      options={defaults()}
                      value={config().defaultSlicerId ?? undefined}
                      onChange={(value) => void settings.setDefault(value)}
                    />
                  </FormField>
                </Show>
                {/* Outside the block above, deliberately: unbinding the last bound product takes
                    the select away, and a default still set with nothing on screen to clear it is
                    a setting whose effect the user can see and cannot reach. */}
                <Show when={config().defaultSlicerId !== null}>
                  <div>
                    <Button
                      variant="ghost"
                      disabled={settings.busy()}
                      onClick={() => void settings.setDefault(null)}
                    >
                      {t('slicers.clearDefault')}
                    </Button>
                  </div>
                </Show>
              </SectionCard>

              <For each={rows()}>
                {(product) => (
                  <SectionCard title={product.name}>
                    <Show
                      when={product.installs.length > 0}
                      fallback={<Text variant="muted">{t('slicers.notInstalled')}</Text>}
                    >
                      {/* The two-Cura case. Nothing is preselected below; this says why. */}
                      <Show when={product.mustChoose}>
                        <Alert variant="warning">
                          {t('slicers.chooseWhich', {
                            count: product.installs.length,
                            name: product.name,
                          })}
                        </Alert>
                      </Show>
                      <ChoiceList
                        label={t('slicers.chooseLabel', { name: product.name })}
                        value={product.boundId}
                        disabled={settings.busy()}
                        onChange={(installId) => void settings.bind(product.id, installId)}
                        options={product.installs.map((install) => ({
                          value: install.id,
                          label: install.label,
                          detail: install.version ?? t('slicers.unknownVersion'),
                          code: install.path,
                          badge:
                            install.state === 'missing' ? (
                              <Badge variant="danger">{t('slicers.installMissing')}</Badge>
                            ) : undefined,
                          action: (
                            <IconButton
                              icon={Trash2}
                              label={`${t('slicers.remove')} ${install.label}`}
                              disabled={settings.busy()}
                              onClick={() => void settings.remove(install.id)}
                            />
                          ),
                        }))}
                      />
                    </Show>
                    <div class="flex flex-wrap gap-2">
                      <Button
                        variant="secondary"
                        icon={Plus}
                        disabled={settings.busy()}
                        onClick={() => void settings.addManual(product.id)}
                      >
                        {t('slicers.addManual')}
                      </Button>
                      <Show when={product.boundId !== null}>
                        <Button
                          variant="ghost"
                          disabled={settings.busy()}
                          onClick={() => void settings.unbind(product.id)}
                        >
                          {t('slicers.unbind')}
                        </Button>
                      </Show>
                    </div>
                  </SectionCard>
                )}
              </For>
            </>
          )}
        </Show>

        {/* Spec 6.3's unfinished-session list. It is on this page rather than only beside the
            launch control because a session outlives the project page it was started from, and
            outlives the run of the app, which is the case a settings page is the only home for.
            No project is named here, so an orphan is asked which one it belongs to. */}
        <SlicerSessionsCard deps={props.client ? { client: props.client.slicers } : undefined} />
      </div>
    </SettingsLayout>
  )
}
