import { For, Show } from 'solid-js'
import { t } from '../core/i18n'
import { createArchiveImport, summarizeImport } from '../core/import-archive'
import {
  Alert,
  Card,
  DropZone,
  FileArchive,
  LinkButton,
  PageHeader,
  Spinner,
  StatList,
  Text,
} from '../ui'

/**
 * `/import`: upload a zipped CuraManager library. Each project folder inside becomes a project and
 * brings the tags, source URL and archived state it carries. One archive at a time; what came of it
 * (or why it was refused) is shown right here.
 */
export default function ImportPage() {
  const importer = createArchiveImport()

  return (
    <div class="mx-auto flex w-full max-w-2xl flex-col gap-6">
      <PageHeader title={t('import.heading')} description={t('import.intro')} />

      <Show when={importer.result()}>
        {(result) => {
          const summary = () => summarizeImport(result())
          return (
            <Alert variant="success" title={t('import.doneTitle')}>
              <div class="flex flex-col gap-3 pt-1">
                <Text variant="muted">
                  {t('import.done', {
                    projects: result().projectsExtracted,
                    files: result().filesExtracted,
                    tags: result().tagsApplied,
                  })}
                </Text>
                <StatList items={summary().stats} />
                <For each={summary().notes}>{(note) => <Text variant="small">{note}</Text>}</For>
                <div>
                  <LinkButton href="/projects" variant="primary" size="sm">
                    {t('import.viewProjects')}
                  </LinkButton>
                </div>
              </div>
            </Alert>
          )
        }}
      </Show>

      <Show when={importer.error()}>
        {(message) => <Alert variant="danger">{message()}</Alert>}
      </Show>

      <Show
        when={!importer.busy()}
        fallback={
          <Card class="flex items-center gap-3" padding="lg">
            <Spinner label={t('common.loading')} />
            <Text>{t('import.running')}</Text>
          </Card>
        }
      >
        <DropZone
          icon={FileArchive}
          label={t('import.dropLabel')}
          buttonLabel={importer.result() ? t('import.importAnother') : t('import.pick')}
          accept=".zip,application/zip"
          multiple={false}
          onFiles={(files) => void importer.run(files)}
        />
      </Show>
    </div>
  )
}
