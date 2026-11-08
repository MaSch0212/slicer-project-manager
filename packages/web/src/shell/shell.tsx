import { useLocation, useNavigate, type RouteSectionProps } from '@solidjs/router'
import { createEffect, createSignal, For, on, onCleanup, onMount, Show } from 'solid-js'
import type { Theme } from '../api/generated'
import { desktop, isDesktop } from '../core/desktop'
import { errorMessage } from '../core/i18n/errors'
import { t, type TranslationKey } from '../core/i18n'
import { navEntries, navLabel } from '../core/nav'
import { notify } from '../core/notify'
import { signOut } from '../core/session'
import { settings } from '../core/stores'
import { applyTheme } from '../core/theme'
import {
  AppShell,
  Brand,
  Drawer,
  IconButton,
  Menu,
  Monitor,
  Moon,
  NavItem,
  NavList,
  PanelLeftClose,
  PanelLeftOpen,
  Sidebar,
  Sun,
  ToastRegion,
  MenuIcon,
  WindowBar,
  type IconComponent,
} from '../ui'

const THEMES: readonly { value: Theme; labelKey: TranslationKey; icon: IconComponent }[] = [
  { value: 'system', labelKey: 'settings.themeSystem', icon: Monitor },
  { value: 'light', labelKey: 'settings.themeLight', icon: Sun },
  { value: 'dark', labelKey: 'settings.themeDark', icon: Moon },
]

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

  const windowBar = () => (
    <WindowBar
      title={t('app.title')}
      isMaximized={maximized()}
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

  async function patchSettings(patch: Parameters<typeof settings.patch>[0]) {
    try {
      await settings.patch(patch)
    } catch (error) {
      // The store has already put the old value back; say why.
      notify.error(errorMessage(error))
    }
  }

  async function onSignOut() {
    try {
      await signOut()
    } catch (error) {
      notify.error(errorMessage(error))
    }
    navigate('/login')
  }

  const themeMenu = () => {
    const current = THEMES.find((theme) => theme.value === settings.settings().theme) ?? THEMES[0]!
    return (
      <Menu
        iconOnly
        icon={current.icon}
        label={t('settings.theme')}
        placement="bottom-start"
        items={THEMES.map((theme) => ({
          label: t(theme.labelKey),
          icon: theme.icon,
          checked: theme.value === current.value,
          onSelect: () => void patchSettings({ theme: theme.value }),
        }))}
      />
    )
  }

  const entries = (isCollapsed: boolean) => (
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
  )

  return (
    <>
      <AppShell
        topBar={isDesktop() ? windowBar() : undefined}
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
              footer={
                <>
                  {themeMenu()}
                  <IconButton
                    icon={collapsed() ? PanelLeftOpen : PanelLeftClose}
                    // One name in both states; aria-expanded says which it is.
                    label={t('nav.toggle')}
                    aria-expanded={!collapsed()}
                    onClick={() => void patchSettings({ navCollapsed: !collapsed() })}
                  />
                </>
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
          <div class="mt-auto">{themeMenu()}</div>
        </Drawer>
      </Show>
      <ToastRegion label={t('common.notifications')} />
    </>
  )
}
