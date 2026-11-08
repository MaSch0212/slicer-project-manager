import { useLocation } from '@solidjs/router'
import { createMemo, For, onMount, type JSX } from 'solid-js'
import { isDesktop } from '../core/desktop'
import { t, type TranslationKey } from '../core/i18n'
import { createSectionSpy } from '../core/section-spy'
import { auth, capabilities } from '../core/stores'
import { Card, PageHeader, PageSection, SectionNav } from '../ui'
import { ImportPanel } from './import-panel'
import { AccountSection } from './settings-account'
import { AppearanceSection } from './settings-appearance'
import { LibraryLocation } from './settings-library'
import { SlicersSection } from './settings-slicers'

type Section = {
  id: string
  /** The short name, for the menu. */
  labelKey: TranslationKey
  /** The heading over the section itself, which may be longer than the menu entry. */
  titleKey: TranslationKey
  descriptionKey: TranslationKey
  /** Whether this shell has the thing the section configures at all. */
  available: () => boolean
  render: () => JSX.Element
}

/**
 * THE SETTINGS SECTIONS. One place that says what settings exist, in what order, and who has
 * them. The menu is built from the same list, so a section and its menu entry cannot drift apart.
 *
 * `available` is a capability question, never "which shell is this", with one exception: Library
 * also appears for any desktop shell, because a connected desktop app cannot pick a folder
 * (`canPickLocalFolder` is false in remote mode) and still needs the way back to another library.
 */
const SECTIONS: readonly Section[] = [
  {
    id: 'appearance',
    labelKey: 'settings.appearanceTitle',
    titleKey: 'settings.appearanceTitle',
    descriptionKey: 'settings.appearanceLead',
    available: () => true,
    render: () => <AppearanceSection />,
  },
  {
    id: 'library',
    labelKey: 'settings.sectionLibrary',
    titleKey: 'settings.libraryTitle',
    descriptionKey: 'settings.libraryLead',
    available: () => capabilities.capabilities().canPickLocalFolder || isDesktop(),
    render: () => <LibraryLocation />,
  },
  {
    id: 'account',
    labelKey: 'settings.accountTitle',
    titleKey: 'settings.accountTitle',
    descriptionKey: 'settings.accountLead',
    available: () => capabilities.capabilities().requiresAuth && auth.isAuthenticated(),
    render: () => <AccountSection />,
  },
  {
    id: 'slicers',
    labelKey: 'settings.slicers',
    titleKey: 'settings.slicers',
    descriptionKey: 'slicers.lead',
    available: () => capabilities.capabilities().canConfigureSlicers,
    render: () => <SlicersSection />,
  },
  {
    id: 'import',
    labelKey: 'settings.sectionImport',
    titleKey: 'settings.importTitle',
    descriptionKey: 'settings.importLead',
    available: () => true,
    render: () => (
      <Card padding="lg">
        <ImportPanel />
      </Card>
    ),
  },
]

/**
 * Settings: one page you scroll, with a menu of its sections beside it.
 *
 * **The menu scrolls, it does not navigate.** Every setting is on this one route, so there is no
 * history entry per section and no second page to load; `/settings#slicers` is the way to link
 * straight at one, and a fragment naming a section this shell does not have is ignored rather
 * than an error.
 */
export default function SettingsPage() {
  const location = useLocation()
  const visible = createMemo(() => SECTIONS.filter((section) => section.available()))
  const spy = createSectionSpy(() => visible().map((section) => section.id))

  onMount(() => {
    const wanted = location.hash.replace(/^#/, '')
    if (wanted === '') return
    // After the sections have mounted and registered themselves, and only for one this shell has.
    queueMicrotask(() => {
      if (visible().some((section) => section.id === wanted)) spy.scrollTo(wanted)
    })
  })

  return (
    <div class="flex flex-col gap-6">
      <PageHeader title={t('settings.title')} />
      <div class="flex flex-col gap-6 md:flex-row md:gap-10">
        <SectionNav
          label={t('settings.sections')}
          items={visible().map((section) => ({ id: section.id, label: t(section.labelKey) }))}
          active={spy.active()}
          onSelect={(id) => spy.scrollTo(id)}
        />
        <div class="flex min-w-0 flex-1 flex-col gap-10">
          <For each={visible()}>
            {(section) => (
              <PageSection
                id={section.id}
                ref={spy.observe(section.id)}
                title={t(section.titleKey)}
                description={t(section.descriptionKey)}
              >
                {section.render()}
              </PageSection>
            )}
          </For>
        </div>
      </div>
    </div>
  )
}
