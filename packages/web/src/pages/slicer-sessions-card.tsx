import { For, onMount, Show } from 'solid-js'
import type { FileState } from '../api/generated'
import { t } from '../core/i18n'
import {
  createSlicerSessions,
  describeSession,
  stateKey,
  type SessionsDeps,
} from '../core/slicer-sessions'
import {
  Alert,
  Badge,
  Button,
  Card,
  FormField,
  Heading,
  RefreshCw,
  SectionCard,
  Select,
  Spinner,
  Text,
  type BadgeVariant,
} from '../ui'

const STATE_VARIANT: Record<FileState, BadgeVariant> = {
  unchanged: 'neutral',
  changed: 'accent',
  settling: 'neutral',
  unreadable: 'danger',
}

/**
 * After a launch: what came back, what did not, and what the user wants done about it (spec D 6.3).
 *
 * Two pages render it: `/settings/slicers`, where it lists every session there is (a session
 * outlives the project page it was started from, and outlives the run of the app), and the project
 * page, narrowed to that project's own sessions plus any orphan (a file with no record, which has
 * to be offered *somewhere*). Both are desktop-only: `canLaunchSlicer` is false in a browser, so
 * nothing mounts it there.
 *
 * It says what was measured and nothing more: never "the slicer was closed", never which setting
 * changed, never that anything was deleted on the user's behalf. Nothing in this list disappears
 * without one of its two buttons being pressed.
 */
export function SlicerSessionsCard(props: {
  /** The project this card is shown beside, or nothing on a page that is about no project. */
  projectId?: string
  /** Fired after something was imported, so the page holding this can reload what it shows. */
  onImported?: () => void
  /** Test seams: a fake shell client, project list and clock. */
  deps?: Partial<SessionsDeps>
}) {
  const sessions = createSlicerSessions(
    { scope: () => props.projectId ?? null, onImported: () => props.onImported?.() },
    props.deps,
  )
  onMount(() => void sessions.reload())

  return (
    <SectionCard title={t('slicerSessions.title')} description={t('slicerSessions.lead')}>
      <Show when={sessions.failure()}>
        {(message) => <Alert variant="danger">{message()}</Alert>}
      </Show>

      <div class="flex flex-wrap items-center gap-2">
        {/* The only way to re-ask. Nothing is pushed from the shell (there is no dependable
            "slicer closed" signal to push on), so this is a pull, and a pull with no control on
            it reads as broken to somebody who has just pressed Ctrl+S. */}
        <Button
          variant="secondary"
          icon={RefreshCw}
          disabled={sessions.busy()}
          onClick={() => void sessions.reload()}
        >
          {t('slicerSessions.refresh')}
        </Button>
        <Show when={sessions.staleRows().length > 1}>
          <Button
            variant="secondary"
            disabled={sessions.busy()}
            onClick={() => void sessions.discardStale()}
          >
            {t('slicerSessions.discardStale', { count: sessions.staleRows().length })}
          </Button>
        </Show>
        <Show when={sessions.loading() || sessions.busy()}>
          <Spinner label={t('common.loading')} />
        </Show>
      </div>

      <Show when={!sessions.loading() && sessions.rows().length === 0}>
        <Text variant="muted">{t('slicerSessions.none')}</Text>
      </Show>

      <ul class="m-0 flex list-none flex-col gap-3 p-0">
        <For each={sessions.rows()}>
          {(row) => (
            <li>
              <Card class="flex flex-col gap-3" padding="md">
                <div class="flex flex-wrap items-center gap-2">
                  <Heading level={3}>{row.session.fileName}</Heading>
                  <Badge variant={STATE_VARIANT[row.session.fileState]}>
                    {t(stateKey(row.session.fileState))}
                  </Badge>
                  <Show when={row.session.isOrphan}>
                    <Badge variant="warning">{t('slicerSessions.orphan')}</Badge>
                  </Show>
                  <Show when={row.stale}>
                    <Badge>{t('slicerSessions.stale')}</Badge>
                  </Show>
                </div>

                <Show when={describeSession(row.session) !== ''}>
                  <Text variant="muted">{describeSession(row.session)}</Text>
                </Show>

                {/* Restated where the user meets the consequence. Cura never saves in place (its
                    Ctrl+S is always a Save-As into a folder of its own), so a Cura session sits
                    here reading "Nothing came back" for ever, and the pre-launch warning that said
                    why was dismissible and is long gone by the time anybody reads this row. */}
                <Show when={row.curaLimit}>
                  <Alert variant="warning">{t('slicerSessions.curaLimit')}</Alert>
                </Show>

                {/* Whether the process the app spawned is alive is the only thing it can observe,
                    and it is not "the slicer is open": several slicers hand the file over and exit
                    while the window stays up. */}
                <Text variant="small">
                  {row.session.processAlive
                    ? t('slicerSessions.processAlive')
                    : t('slicerSessions.processGone')}
                </Text>

                <Show when={row.session.entryDiff}>
                  {(diff) => (
                    <div class="flex flex-col gap-1">
                      <Text variant="label">{t('slicerSessions.diffTitle')}</Text>
                      <ul class="m-0 flex list-none flex-col gap-0.5 p-0">
                        <For each={diff().changed}>
                          {(name) => (
                            <li>
                              <Text variant="mono" as="span">
                                {t('slicerSessions.diffChanged', { name })}
                              </Text>
                            </li>
                          )}
                        </For>
                        <For each={diff().added}>
                          {(name) => (
                            <li>
                              <Text variant="mono" as="span">
                                {t('slicerSessions.diffAdded', { name })}
                              </Text>
                            </li>
                          )}
                        </For>
                        <For each={diff().removed}>
                          {(name) => (
                            <li>
                              <Text variant="mono" as="span">
                                {t('slicerSessions.diffRemoved', { name })}
                              </Text>
                            </li>
                          )}
                        </For>
                      </ul>
                      {/* Stated as plainly as the findings: it says an entry changed, never which
                          setting inside it did. */}
                      <Text variant="small">{t('slicerSessions.diffLimit')}</Text>
                    </div>
                  )}
                </Show>

                <Show when={row.needsProject}>
                  <FormField label={t('slicerSessions.whichProject')}>
                    <Select
                      placeholder={t('slicerSessions.whichProjectPlaceholder')}
                      disabled={sessions.busy()}
                      value={sessions.chosenProject(row.session.launchId) ?? undefined}
                      onChange={(projectId) =>
                        sessions.setChosenProject(row.session.launchId, projectId)
                      }
                      options={sessions
                        .projects()
                        .map((project) => ({ value: project.id, label: project.name }))}
                    />
                  </FormField>
                </Show>

                <div class="flex flex-wrap gap-2">
                  <Show when={row.canImport}>
                    <Button
                      variant="primary"
                      disabled={
                        sessions.busy() ||
                        (row.needsProject && sessions.chosenProject(row.session.launchId) === null)
                      }
                      onClick={() => void sessions.importRow(row)}
                    >
                      {t('slicerSessions.import')}
                    </Button>
                  </Show>
                  <Button
                    variant="ghost"
                    disabled={sessions.busy()}
                    onClick={() => void sessions.discardRow(row)}
                  >
                    {t('slicerSessions.discard')}
                  </Button>
                </div>
              </Card>
            </li>
          )}
        </For>
      </ul>
    </SectionCard>
  )
}
