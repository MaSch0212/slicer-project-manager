import { useLocation, useNavigate } from '@solidjs/router'
import { createEffect, createSignal, For, on, Show } from 'solid-js'
import { VIEW_NAME_MAX, VIEWS_MAX, type ProjectViewDto } from '../api/generated'
import { t } from '../core/i18n'
import { settings } from '../core/stores'
import {
  allProjectsFiltered,
  current,
  forgetPicked,
  openAllProjects,
  openView,
  saveViews as save,
  setEditingViews,
  setSaveViewOpen,
} from '../core/view-actions'
import { pickView } from '../core/view-selection'
import {
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
  Layers,
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
 * The saved views in the sidebar (subsystem H): the sort order, the layout, the archive switch
 * and the tag filter, under a name you picked.
 *
 * Choosing one writes those settings and the projects page follows them. The row marked as
 * current is the one picked (see `currentView`); a change made on the page since marks it as
 * modified rather than taking the mark away.
 */
export function ViewsNav(props: { collapsed?: boolean }) {
  const navigate = useNavigate()
  const location = useLocation()
  const views = () => settings.settings().views
  // A view is where you are only while the list is on screen: on another page, such as Find
  // models, that page's entry is the one marked, and only it.
  const onList = () => location.pathname.startsWith('/projects')
  const isCurrent = (id: string) => onList() && current()?.view.id === id

  function toList(): void {
    // Only from elsewhere: on the list already, a project open beside it stays open.
    if (!onList()) navigate('/projects')
  }

  function apply(view: ProjectViewDto): void {
    toList()
    openView(view)
  }

  const rowMenu = (view: ProjectViewDto) => ({
    label: t('views.menu', { name: view.name }),
    items: [
      {
        label: t('views.update'),
        icon: RefreshCw,
        onSelect: () => void save(reshapeView(views(), view.id, shapeOf(settings.settings()))),
      },
      {
        label: t('views.rename'),
        icon: Pencil,
        onSelect: () => setEditingViews({ focus: view.id }),
      },
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
        onSelect: () => {
          forgetPicked(view.id)
          void save(removeView(views(), view.id))
        },
      },
      { type: 'separator' as const },
      { label: t('views.edit'), icon: Pencil, onSelect: () => setEditingViews({ focus: null }) },
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
              onClick={() => setSaveViewOpen(true)}
            />
          </Show>
        }
      >
        {t('views.title')}
      </NavHeading>
      <NavList>
        <NavViewItem
          label={t('views.allProjects')}
          icon={Layers}
          active={onList() && current() === null}
          modified={onList() && current() === null && allProjectsFiltered()}
          modifiedLabel={t('views.modified')}
          collapsed={props.collapsed}
          onClick={() => {
            toList()
            openAllProjects()
          }}
        />
        <For each={views()}>
          {(view) => (
            <NavViewItem
              label={view.name}
              icon={viewIcon(view.icon)}
              active={isCurrent(view.id)}
              modified={isCurrent(view.id) && current()?.modified === true}
              modifiedLabel={t('views.modified')}
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
    const id = newViewId(views)
    setSaving(true)
    const ok = await save([...views, viewFrom(id, name(), icon(), shapeOf(settings.settings()))])
    setSaving(false)
    if (!ok) return
    // The list is now in the view just made, even when an older one has the same filters.
    pickView(id)
    props.onOpenChange(false)
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
                  onClick={() => {
                    forgetPicked(view.id)
                    void save(removeView(views(), view.id))
                  }}
                />
              </li>
            )}
          </For>
        </ul>
      </Show>
    </Dialog>
  )
}
