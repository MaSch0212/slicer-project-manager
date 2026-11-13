import { useNavigate } from '@solidjs/router'
import { createEffect, createSignal, For, on, Show } from 'solid-js'
import { VIEW_NAME_MAX, VIEWS_MAX, type ProjectViewDto } from '../api/generated'
import { t } from '../core/i18n'
import { errorMessage } from '../core/i18n/errors'
import { notify } from '../core/notify'
import { settings } from '../core/stores'
import {
  activeView,
  DEFAULT_VIEW_ICON,
  duplicateView,
  editView,
  moveView,
  newViewId,
  removeView,
  reshapeView,
  shapeOf,
  VIEW_ICONS,
  viewFrom,
} from '../core/views'
import {
  Button,
  ChevronDown,
  ChevronUp,
  Copy,
  Dialog,
  FormField,
  IconButton,
  Input,
  Menu,
  NavHeading,
  NavList,
  NavViewItem,
  Pencil,
  Plus,
  RefreshCw,
  Text,
  Trash2,
  ViewIconPicker,
  viewIcon,
} from '../ui'

/** The name each icon answers to, for controls that have only the picture to show. */
function iconLabel(icon: string): string {
  return t(`views.icon_${icon}` as 'views.icon_layers')
}

/**
 * Writes the whole list of views. Every change — a new one, a rename, a reorder, a deletion — is
 * "here is the list now": one rule, one call, and no way for two of them to disagree about what
 * the list holds.
 */
async function save(next: readonly ProjectViewDto[]): Promise<boolean> {
  try {
    await settings.patch({ views: [...next] })
    return true
  } catch (error) {
    notify.error(errorMessage(error))
    return false
  }
}

/**
 * The saved views in the sidebar (subsystem H): the sort order, the layout, the archive switch
 * and the tag filter, under a name you picked.
 *
 * Choosing one writes those settings and the projects page follows them. That is also why the row
 * marked as current is *derived* from the settings rather than remembered: change a filter on the
 * page and the mark simply goes out, because there is no stored "current view" to go stale.
 */
export function ViewsNav(props: {
  collapsed?: boolean
  /** Opens the dialog that keeps what the list is showing as a new view. */
  onSave: () => void
  /** Opens the editor, with one view's name selected when it was reached by "Rename". */
  onEdit: (focus: string | null) => void
}) {
  const navigate = useNavigate()
  const views = () => settings.settings().views
  const current = () => activeView(views(), shapeOf(settings.settings()))

  function apply(view: ProjectViewDto): void {
    navigate('/projects')
    void settings
      .patch({
        viewMode: view.viewMode,
        sort: view.sort,
        dir: view.dir,
        includeArchived: view.includeArchived,
        filterTags: [...view.tags],
      })
      .catch((error: unknown) => notify.error(errorMessage(error)))
  }

  const rowMenu = (view: ProjectViewDto) => ({
    label: t('views.menu', { name: view.name }),
    items: [
      {
        label: t('views.update'),
        icon: RefreshCw,
        onSelect: () => void save(reshapeView(views(), view.id, shapeOf(settings.settings()))),
      },
      { label: t('views.rename'), icon: Pencil, onSelect: () => props.onEdit(view.id) },
      {
        label: t('views.duplicate'),
        icon: Copy,
        disabled: views().length >= VIEWS_MAX,
        onSelect: () =>
          void save(duplicateView(views(), view.id, t('views.copyOf', { name: view.name }))),
      },
      {
        label: t('views.delete'),
        icon: Trash2,
        danger: true,
        onSelect: () => void save(removeView(views(), view.id)),
      },
      { type: 'separator' as const },
      { label: t('views.edit'), icon: Pencil, onSelect: () => props.onEdit(null) },
    ],
  })

  return (
    <div class="flex flex-col gap-0.5">
      <NavHeading
        collapsed={props.collapsed}
        action={
          <Show when={!props.collapsed}>
            <IconButton
              icon={Plus}
              size="sm"
              label={t('views.save')}
              disabled={views().length >= VIEWS_MAX}
              onClick={() => props.onSave()}
            />
          </Show>
        }
      >
        {t('views.title')}
      </NavHeading>
      <NavList>
        <For each={views()}>
          {(view) => (
            <NavViewItem
              label={view.name}
              icon={viewIcon(view.icon)}
              active={current()?.id === view.id}
              collapsed={props.collapsed}
              onClick={() => apply(view)}
              menu={rowMenu(view)}
            />
          )}
        </For>
      </NavList>
      <Show when={views().length === 0 && !props.collapsed}>
        <div class="px-2.5 py-1">
          <Text variant="small">{t('views.empty')}</Text>
        </div>
      </Show>
    </div>
  )
}

/** Names what the project list is showing now, and keeps it. */
export function SaveViewDialog(props: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const [name, setName] = createSignal('')
  const [icon, setIcon] = createSignal<string>(DEFAULT_VIEW_ICON)
  const [saving, setSaving] = createSignal(false)

  // A dialog that opens still holding the last answer is one you have to clear before using.
  createEffect(
    on(
      () => props.open,
      (open) => {
        if (!open) return
        setName('')
        setIcon(DEFAULT_VIEW_ICON)
      },
    ),
  )

  async function confirm(): Promise<void> {
    if (name().trim() === '' || saving()) return
    const views = settings.settings().views
    setSaving(true)
    const ok = await save([
      ...views,
      viewFrom(newViewId(views), name(), icon(), shapeOf(settings.settings())),
    ])
    setSaving(false)
    if (ok) props.onOpenChange(false)
  }

  return (
    <Dialog
      open={props.open}
      onOpenChange={props.onOpenChange}
      title={t('views.saveTitle')}
      description={t('views.saveLead')}
      size="sm"
      closeLabel={t('common.close')}
      footer={
        <>
          <Button variant="secondary" onClick={() => props.onOpenChange(false)}>
            {t('common.cancel')}
          </Button>
          <Button loading={saving()} disabled={name().trim() === ''} onClick={() => void confirm()}>
            {t('views.saveAction')}
          </Button>
        </>
      }
    >
      <div class="flex flex-col gap-4">
        <FormField label={t('views.name')} required>
          <Input
            value={name()}
            maxLength={VIEW_NAME_MAX}
            onInput={(event) => setName(event.currentTarget.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') void confirm()
            }}
          />
        </FormField>
        <FormField label={t('views.icon')}>
          <ViewIconPicker
            label={t('views.icon')}
            icons={VIEW_ICONS}
            nameOf={iconLabel}
            value={icon()}
            onChange={setIcon}
          />
        </FormField>
      </div>
    </Dialog>
  )
}

/**
 * The editor: rename, re-icon, reorder and delete, in one place.
 *
 * A dialog, rather than the sidebar turning into a form the way the app this follows does it: at
 * 240 pixels wide a row cannot hold a name field and four controls without each of them becoming
 * a guess. Here they are the size they should be, and the keyboard reaches them in order.
 */
export function EditViewsDialog(props: {
  open: boolean
  /** The view whose name to select on opening, when the editor was reached by "Rename". */
  focus: string | null
  onOpenChange: (open: boolean) => void
}) {
  const views = () => settings.settings().views
  const fields = new Map<string, HTMLInputElement>()

  createEffect(
    on(
      () => props.open,
      (open) => {
        if (!open) return
        const wanted = props.focus ?? views()[0]?.id
        queueMicrotask(() => {
          const field = wanted ? fields.get(wanted) : undefined
          field?.focus()
          field?.select()
        })
      },
    ),
  )

  /** Saves a name when the field is left or Enter is pressed. An empty one is simply not a name. */
  function rename(view: ProjectViewDto, value: string): void {
    const name = value.trim()
    if (name === '' || name === view.name) {
      const field = fields.get(view.id)
      if (field) field.value = view.name
      return
    }
    void save(editView(views(), view.id, { name }))
  }

  const iconItems = (view: ProjectViewDto) =>
    VIEW_ICONS.map((name) => ({
      label: iconLabel(name),
      icon: viewIcon(name),
      checked: name === view.icon,
      onSelect: () => void save(editView(views(), view.id, { icon: name })),
    }))

  return (
    <Dialog
      open={props.open}
      onOpenChange={props.onOpenChange}
      title={t('views.editTitle')}
      description={t('views.editLead')}
      closeLabel={t('common.close')}
      footer={<Button onClick={() => props.onOpenChange(false)}>{t('views.done')}</Button>}
    >
      <Show when={views().length > 0} fallback={<Text variant="muted">{t('views.empty')}</Text>}>
        <ul class="m-0 flex list-none flex-col gap-2 p-0">
          <For each={views()}>
            {(view, index) => (
              <li class="flex items-center gap-1.5">
                <Menu
                  iconOnly
                  icon={viewIcon(view.icon)}
                  variant="secondary"
                  placement="bottom-start"
                  label={t('views.iconOf', { name: view.name })}
                  items={iconItems(view)}
                />
                <Input
                  ref={(element: HTMLInputElement) => fields.set(view.id, element)}
                  value={view.name}
                  maxLength={VIEW_NAME_MAX}
                  aria-label={t('views.nameOf', { name: view.name })}
                  class="flex-1"
                  onBlur={(event) => rename(view, event.currentTarget.value)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') {
                      event.preventDefault()
                      rename(view, event.currentTarget.value)
                    } else if (event.key === 'Escape') {
                      event.preventDefault()
                      event.stopPropagation()
                      event.currentTarget.value = view.name
                    }
                  }}
                />
                <IconButton
                  icon={ChevronUp}
                  size="sm"
                  label={t('views.moveUp', { name: view.name })}
                  disabled={index() === 0}
                  onClick={() => void save(moveView(views(), view.id, 'up'))}
                />
                <IconButton
                  icon={ChevronDown}
                  size="sm"
                  label={t('views.moveDown', { name: view.name })}
                  disabled={index() === views().length - 1}
                  onClick={() => void save(moveView(views(), view.id, 'down'))}
                />
                <IconButton
                  icon={Trash2}
                  size="sm"
                  label={t('views.deleteOf', { name: view.name })}
                  onClick={() => void save(removeView(views(), view.id))}
                />
              </li>
            )}
          </For>
        </ul>
      </Show>
    </Dialog>
  )
}
