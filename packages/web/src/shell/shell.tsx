import { useLocation, useNavigate, type RouteSectionProps } from '@solidjs/router'
import {
  createEffect,
  createResource,
  createSignal,
  For,
  on,
  onCleanup,
  onMount,
  Show,
} from 'solid-js'
import { VIEWS_MAX } from '../api/generated'
import { desktop, isDesktop } from '../core/desktop'
import { capabilities } from '../core/stores'
import { errorMessage } from '../core/i18n/errors'
import { t } from '../core/i18n'
import { isFullBleed, navEntries, navLabel } from '../core/nav'
import { notify } from '../core/notify'
import { signOut } from '../core/session'
import { settings } from '../core/stores'
import { applyTheme } from '../core/theme'
import {
  AppShell,
  Brand,
  Drawer,
  IconButton,
  NavItem,
  NavList,
  Sidebar,
  ToastRegion,
  MenuIcon,
  X,
  FolderOpen,
  Globe,
  Layers,
  MenuTrigger,
  Pencil,
  Plus,
  Settings as SettingsIcon,
  TitleBarButton,
  WindowBar,
  WindowBarBrand,
  type MenuEntry,
} from '../ui'
import { EditViewsDialog, SaveViewDialog, ViewsNav } from './views-nav'

/**
 * The app shell (subsystem G): sidebar from `md` up, a drawer below it, the notification surface,
 * the theme control, and the persisted collapsed state. It is the root layout of every route,
 * the login page included; with no navigation entries it draws no chrome at all.
 */
export function Shell(props: RouteSectionProps) {
  const navigate = useNavigate()
  const location = useLocation()
  const [drawerOpen, setDrawerOpen] = createSignal(false)
  const [maximized, setMaximized] = createSignal(false)
  const [savingView, setSavingView] = createSignal(false)
  // Null when the editor is shut; otherwise which view's name to select, if any.
  const [editingViews, setEditingViews] = createSignal<{ focus: string | null } | null>(null)

  /**
   * The window's own bar, in the desktop app only. The maximised state is asked for after every
   * resize rather than listened for: there is no event channel to the page (the capability grants
   * commands and nothing else), and nothing but a resize can change the answer.
   */
  onMount(() => {
    if (!isDesktop()) return
    const read = () => {
      void desktop.window
        .state()
        .then((state) => setMaximized(state.isMaximized))
        .catch(() => {})
    }
    read()
    window.addEventListener('resize', read)
    onCleanup(() => window.removeEventListener('resize', read))
  })

  /**
   * What the View menu used to hold. It only fires while the focus is in this webview: a key
   * pressed inside the model browser's child view belongs to that view, which can call nothing.
   */
  onMount(() => {
    if (!isDesktop()) return
    const onKeyDown = (event: KeyboardEvent) => {
      if (!event.ctrlKey || event.altKey || event.metaKey) return
      const key = event.key.toLowerCase()
      if (key === 'r' && !event.shiftKey) {
        event.preventDefault()
        window.location.reload()
      } else if (key === 'i' && event.shiftKey) {
        event.preventDefault()
        void desktop.window.toggleDevtools().catch(() => {})
      }
    }
    window.addEventListener('keydown', onKeyDown)
    onCleanup(() => window.removeEventListener('keydown', onKeyDown))
  })

  /**
   * The model sites, for the plus button. Loaded once and only where there is a browser to open
   * them in; a shell that cannot browse has no list and no button.
   */
  const [sites] = createResource(
    () => capabilities.capabilities().canBrowseModelSites && isDesktop(),
    async (can) => (can ? await desktop.browse.sites().catch(() => []) : []),
  )

  /**
   * Everything the app can do, in one place, the way a desktop application's own menu used to
   * be. It duplicates what the pages offer rather than replacing it: the point of a menu on the
   * title is that you do not have to know which page a thing lives on.
   */
  const appMenu = (): MenuEntry[] => [
    {
      label: t('projects.newProject'),
      icon: Plus,
      onSelect: () => navigate('/projects?new=1'),
    },
    { type: 'separator' },
    {
      label: t('views.save'),
      icon: Layers,
      disabled: settings.settings().views.length >= VIEWS_MAX,
      onSelect: () => setSavingView(true),
    },
    {
      label: t('views.edit'),
      icon: Pencil,
      onSelect: () => setEditingViews({ focus: null }),
    },
    { type: 'separator' },
    {
      label: t('settings.chooseLibrary'),
      icon: FolderOpen,
      onSelect: () => void desktop.chooseLibrary().catch(() => {}),
    },
    { type: 'separator' },
    {
      label: t('settings.title'),
      icon: SettingsIcon,
      onSelect: () => navigate('/settings'),
    },
    {
      label: t('window.exit'),
      icon: X,
      onSelect: () => void desktop.window.close().catch(() => {}),
    },
  ]

  /** The start sites, each opening a tab of the model browser on it. */
  const sitesMenu = (): MenuEntry[] =>
    (sites() ?? []).map((site) => ({
      label: site.displayName,
      icon: Globe,
      onSelect: () => {
        navigate('/browse')
        void desktop.browse.openTab(site.homeUrl).catch(() => {})
      },
    }))

  const windowBar = () => (
    <WindowBar
      isMaximized={maximized()}
      brand={
        <MenuTrigger label={t('app.menu')} items={appMenu()}>
          {({ trigger, expanded }) => (
            <WindowBarBrand
              name={t('app.title')}
              label={t('app.menu')}
              expanded={expanded}
              trigger={trigger}
            />
          )}
        </MenuTrigger>
      }
      tools={
        <Show when={(sites() ?? []).length > 0}>
          <MenuTrigger label={t('browse.openSite')} items={sitesMenu()}>
            {({ trigger, expanded }) => (
              <TitleBarButton
                icon={Plus}
                label={t('browse.openSite')}
                expanded={expanded}
                trigger={trigger}
              />
            )}
          </MenuTrigger>
        </Show>
      }
      trailing={
        <TitleBarButton
          icon={SettingsIcon}
          label={t('settings.title')}
          current={location.pathname === '/settings'}
          onClick={() => navigate('/settings')}
        />
      }
      labels={{
        minimize: t('window.minimize'),
        maximize: t('window.maximize'),
        restore: t('window.restore'),
        close: t('window.close'),
      }}
      onDragStart={() => void desktop.window.startDrag().catch(() => {})}
      onToggleMaximize={() =>
        void desktop.window
          .toggleMaximize()
          .then((state) => setMaximized(state.isMaximized))
          .catch(() => {})
      }
      onMinimize={() => void desktop.window.minimize().catch(() => {})}
      onClose={() => void desktop.window.close().catch(() => {})}
    />
  )

  const collapsed = () => settings.settings().navCollapsed
  // The connect page is a question, not a place in the app: no library exists yet for the
  // navigation to lead into.
  const hasNav = () => navEntries().length > 0 && location.pathname !== '/desktop/connect'

  // The setting is the truth once it has loaded; until then index.tsx has applied the cached one.
  createEffect(() => {
    if (settings.loaded()) applyTheme(settings.settings().theme)
  })
  // A navigation that lands closes the drawer.
  createEffect(
    on(
      () => location.pathname,
      () => setDrawerOpen(false),
      { defer: true },
    ),
  )

  async function onSignOut() {
    try {
      await signOut()
    } catch (error) {
      notify.error(errorMessage(error))
    }
    navigate('/login')
  }

  const entries = (isCollapsed: boolean) => (
    <div class="flex flex-col gap-4">
      <NavList>
        <For each={navEntries()}>
          {(entry) => (
            <NavItem
              label={navLabel(entry)}
              icon={entry.icon}
              href={entry.route ?? undefined}
              onClick={entry.route === null ? () => void onSignOut() : undefined}
              collapsed={isCollapsed}
            />
          )}
        </For>
      </NavList>
      <ViewsNav
        collapsed={isCollapsed}
        onSave={() => setSavingView(true)}
        onEdit={(focus) => setEditingViews({ focus })}
      />
    </div>
  )

  return (
    <>
      <AppShell
        topBar={isDesktop() ? windowBar() : undefined}
        fullBleed={isFullBleed(location.pathname)}
        sidebar={
          <Show when={hasNav()}>
            <Sidebar
              label={t('nav.label')}
              collapsed={collapsed()}
              // In the desktop app the window bar above carries the mark and the name already.
              brand={
                isDesktop() ? undefined : (
                  <Brand name={t('app.title')} href="/projects" collapsed={collapsed()} />
                )
              }
            >
              {entries(collapsed())}
            </Sidebar>
          </Show>
        }
        title={t('app.title')}
        menuButton={
          <Show when={hasNav()}>
            <IconButton
              icon={MenuIcon}
              label={t('nav.open')}
              aria-expanded={drawerOpen()}
              onClick={() => setDrawerOpen(true)}
            />
          </Show>
        }
      >
        {props.children}
      </AppShell>
      <Show when={hasNav()}>
        <Drawer
          open={drawerOpen()}
          onOpenChange={setDrawerOpen}
          title={t('app.title')}
          closeLabel={t('common.close')}
        >
          <nav aria-label={t('nav.label')}>{entries(false)}</nav>
        </Drawer>
      </Show>
      <SaveViewDialog open={savingView()} onOpenChange={setSavingView} />
      <EditViewsDialog
        open={editingViews() !== null}
        focus={editingViews()?.focus ?? null}
        onOpenChange={(open) => {
          if (!open) setEditingViews(null)
        }}
      />
      <ToastRegion label={t('common.notifications')} />
    </>
  )
}
