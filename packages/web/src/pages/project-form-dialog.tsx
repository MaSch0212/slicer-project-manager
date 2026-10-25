import { createEffect, createSignal, on, Show } from 'solid-js'
import { errorMessage } from '../core/i18n/errors'
import { t } from '../core/i18n'
import { TAG_MAX_LENGTH } from '../core/project-detail'
import { hasErrors, validateProjectForm, type ProjectFormErrors } from '../core/validation'
import { Alert, Button, Dialog, FormField, Input, TagInput, Textarea } from '../ui'

export type ProjectFormValues = {
  name: string
  website: string
  notes: string
  tags: string[]
}

/**
 * One dialog for both "new project" and "edit project": name, source URL, notes and, when creating,
 * tags (an existing project's tags are edited in place on its page, where each change is its own
 * request). Validates the cheap rules before sending, hands the values to `onSubmit`, and shows what
 * the server said when that rejects. The dialog closes only when `onSubmit` resolves.
 */
export function ProjectFormDialog(props: {
  open: boolean
  onOpenChange: (open: boolean) => void
  title: string
  description?: string
  submitLabel: string
  initial?: Partial<ProjectFormValues>
  withTags?: boolean
  tagSuggestions?: readonly string[]
  onSubmit: (values: ProjectFormValues) => Promise<void>
}) {
  const [name, setName] = createSignal('')
  const [website, setWebsite] = createSignal('')
  const [notes, setNotes] = createSignal('')
  const [tags, setTags] = createSignal<string[]>([])
  const [errors, setErrors] = createSignal<ProjectFormErrors>({})
  const [failure, setFailure] = createSignal<string | null>(null)
  const [busy, setBusy] = createSignal(false)

  // Every opening starts from the initial values, not from whatever was typed last time.
  createEffect(
    on(
      () => props.open,
      (open) => {
        if (!open) return
        setName(props.initial?.name ?? '')
        setWebsite(props.initial?.website ?? '')
        setNotes(props.initial?.notes ?? '')
        setTags(props.initial?.tags ?? [])
        setErrors({})
        setFailure(null)
      },
    ),
  )

  async function submit(event: SubmitEvent) {
    event.preventDefault()
    setFailure(null)
    const found = validateProjectForm({ name: name(), website: website(), notes: notes() })
    setErrors(found)
    if (hasErrors(found)) return
    setBusy(true)
    try {
      await props.onSubmit({
        name: name().trim(),
        website: website().trim(),
        notes: notes(),
        tags: tags(),
      })
      props.onOpenChange(false)
    } catch (error) {
      // The typed values stay put: a failed create is retried, not retyped.
      setFailure(errorMessage(error))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog
      open={props.open}
      onOpenChange={props.onOpenChange}
      title={props.title}
      description={props.description}
      closeLabel={t('common.close')}
      footer={
        <>
          <Button variant="secondary" onClick={() => props.onOpenChange(false)}>
            {t('common.cancel')}
          </Button>
          <Button variant="primary" type="submit" form="project-form" loading={busy()}>
            {props.submitLabel}
          </Button>
        </>
      }
    >
      <form id="project-form" class="flex flex-col gap-4 py-1" onSubmit={submit} novalidate>
        <FormField label={t('projects.name')} error={errors().name} required>
          <Input
            autofocus
            value={name()}
            maxLength={400}
            onInput={(event) => setName(event.currentTarget.value)}
          />
        </FormField>
        <FormField label={t('projects.website')} error={errors().website}>
          <Input
            type="url"
            inputmode="url"
            autocomplete="off"
            placeholder="https://"
            value={website()}
            onInput={(event) => setWebsite(event.currentTarget.value)}
          />
        </FormField>
        <FormField label={t('projects.notes')} error={errors().notes}>
          <Textarea value={notes()} onInput={(event) => setNotes(event.currentTarget.value)} />
        </FormField>
        <Show when={props.withTags}>
          <FormField label={t('projects.tags')} hint={t('projects.tagsHint')}>
            <TagInput
              label={t('projects.tags')}
              value={tags()}
              onChange={setTags}
              suggestions={props.tagSuggestions}
              maxLength={TAG_MAX_LENGTH}
              removeLabel={(tag) => t('projects.removeTagNamed', { name: tag })}
            />
          </FormField>
        </Show>
        <Show when={failure()}>{(message) => <Alert variant="danger">{message()}</Alert>}</Show>
      </form>
    </Dialog>
  )
}
