import { createMemoryHistory, MemoryRouter, Route } from '@solidjs/router'
import { fireEvent, render, screen, waitFor } from '@solidjs/testing-library'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  DETECTION_FAILED,
  type Capabilities,
  type SlicerConfigDto,
  type SlicerInstallDto,
} from '../api/generated'
import { ApiError } from '../core/api/error'
import type { DesktopClient } from '../core/desktop'
import en from '../core/i18n/en.json'
import { setLanguage } from '../core/i18n'
import { capabilities } from '../core/stores'
import SlicersPage from './slicers'

/**
 * The slicers installed on this machine, and which install of each product the app launches. A port
 * of the Angular `DesktopSlicersPage` spec, case for case, against the same `SlicerConfigDto`s.
 *
 * The two Curas are the two installs the developer's own machine really has, from the detection
 * run: they are the whole reason this page exists in the shape it does (one `SlicerId`, two
 * working installs, and no honest way for the app to pick between them).
 */

const CURA_512: SlicerInstallDto = {
  id: 'registry:HKLM\\WOW6432Node:UltiMaker Cura 5.12.0-5.12.0',
  slicerId: 'cura',
  label: 'UltiMaker Cura 5.12.0',
  version: '5.12.0',
  path: 'C:\\Program Files\\UltiMaker Cura 5.12.0\\UltiMaker-Cura.exe',
  origin: 'registry',
  state: 'ok',
}

const CURA_513: SlicerInstallDto = {
  id: 'registry:HKLM\\WOW6432Node:UltiMaker Cura 5.13.0-5.13.0',
  slicerId: 'cura',
  label: 'UltiMaker Cura 5.13.0',
  version: '5.13.0',
  path: 'C:\\Program Files\\UltiMaker Cura 5.13.0\\UltiMaker-Cura.exe',
  origin: 'registry',
  state: 'ok',
}

const PRUSA: SlicerInstallDto = {
  id: 'registry:HKLM:PrusaSlicer_is1',
  slicerId: 'prusaslicer',
  // The registry DisplayName really is bare, unlike Cura's.
  label: 'PrusaSlicer',
  version: '2.9.6',
  path: 'C:\\Program Files\\Prusa3D\\PrusaSlicer\\prusa-slicer.exe',
  origin: 'registry',
  state: 'ok',
}

/**
 * The row that keeps the version assertions honest: both Cura labels carry their version *inside*
 * the registry DisplayName, and the MSIX path carries it inside a directory name, so neither can
 * tell a page that renders the version from one that does not. Bambu Studio's label is bare and its
 * path is version-free (the odd `02.08.02.61` spelling is the real one).
 */
const BAMBU: SlicerInstallDto = {
  id: 'registry:HKLM:Bambu Studio',
  slicerId: 'bambu',
  label: 'Bambu Studio',
  version: '02.08.02.61',
  path: 'C:\\Program Files\\Bambu Studio\\bambu-studio.exe',
  origin: 'registry',
  state: 'ok',
}

/** The MSIX row: a package family for an id, and a path that embeds a version. */
const ORCA: SlicerInstallDto = {
  id: 'msix:OrcaSlicer.OrcaSlicer_3qd7h69xpne0g',
  slicerId: 'orca',
  label: 'OrcaSlicer',
  version: '2.4.3.0',
  path: 'C:\\Program Files\\WindowsApps\\OrcaSlicer.OrcaSlicer_2.4.3.0_x64__3qd7h69xpne0g\\orca-slicer.exe',
  origin: 'msix',
  state: 'ok',
}

/** What `addManual` records: the user named the file, and nothing read a version out of it. */
const BY_HAND: SlicerInstallDto = {
  id: 'manual:6f0d1f6e-6f6f-4a2f-9a1a-0f5b2c8d4e11',
  slicerId: 'bambu',
  label: 'Bambu Studio (added by hand)',
  version: null,
  path: 'D:\\portable\\BambuStudio\\bambu-studio.exe',
  origin: 'manual',
  state: 'ok',
}

const NOTHING_FOUND: SlicerConfigDto = {
  installs: [],
  bindings: {},
  defaultSlicerId: null,
  detectionSupported: true,
}

/** Two Curas, and the shell has deliberately left the product unbound. */
const TWO_CURAS: SlicerConfigDto = {
  installs: [CURA_512, CURA_513],
  bindings: {},
  defaultSlicerId: null,
  detectionSupported: true,
}

const CAPS: Capabilities = {
  requiresAuth: false,
  canManageUsers: false,
  canPickLocalFolder: true,
  canLaunchSlicer: true,
  canConfigureSlicers: true,
  canBrowseModelSites: false,
}

type Slicers = {
  get: ReturnType<typeof vi.fn>
  scan: ReturnType<typeof vi.fn>
  addManual: ReturnType<typeof vi.fn>
  remove: ReturnType<typeof vi.fn>
  bind: ReturnType<typeof vi.fn>
  setDefault: ReturnType<typeof vi.fn>
  resetConfig: ReturnType<typeof vi.fn>
  open: ReturnType<typeof vi.fn>
  // The page renders the unfinished-session card, which asks the same client for its list. An empty
  // answer is the ordinary case for these tests and keeps the card out of their way: a stub without
  // it would make every one of them show the card's own failure banner.
  sessions: ReturnType<typeof vi.fn>
  resolveSession: ReturnType<typeof vi.fn>
  discardSessions: ReturnType<typeof vi.fn>
}

function fakeSlicers(config: SlicerConfigDto, overrides: Partial<Slicers> = {}): Slicers {
  return {
    get: vi.fn().mockResolvedValue(config),
    scan: vi.fn().mockResolvedValue(config),
    addManual: vi.fn().mockResolvedValue(config),
    remove: vi.fn().mockResolvedValue(config),
    bind: vi.fn().mockResolvedValue(config),
    setDefault: vi.fn().mockResolvedValue(config),
    resetConfig: vi.fn().mockResolvedValue(config),
    open: vi.fn(),
    sessions: vi.fn().mockResolvedValue([]),
    resolveSession: vi.fn().mockResolvedValue(null),
    discardSessions: vi.fn().mockResolvedValue({ discarded: 0 }),
    ...overrides,
  }
}

async function setup(config: SlicerConfigDto = TWO_CURAS, overrides: Partial<Slicers> = {}) {
  const slicers = fakeSlicers(config, overrides)
  const client = { slicers } as unknown as DesktopClient
  const history = createMemoryHistory()
  history.set({ value: '/settings/slicers' })
  render(() => (
    <MemoryRouter history={history}>
      <Route path="/settings/slicers" component={() => <SlicersPage client={client} />} />
    </MemoryRouter>
  ))
  // The first load is what puts the products on the page.
  await screen.findByRole('heading', { name: 'UltiMaker Cura', level: 2 })
  return { slicers }
}

/** Every install row, found the way a screen reader finds it. */
const radios = () => screen.queryAllByRole('radio') as HTMLInputElement[]
const radioText = () => radios().map((radio) => radio.closest('label')?.textContent?.trim() ?? '')
const checkedState = () => radios().map((radio) => radio.checked)
const pageText = () => document.body.textContent ?? ''
const alertText = () => screen.queryAllByRole('alert').at(0)?.textContent ?? null
const buttonNamed = (name: string) =>
  screen.queryAllByRole('button').find((button) => {
    const text = (button.textContent ?? '').replace(/\s+/g, ' ').trim()
    return text === name || button.getAttribute('aria-label') === name
  }) ?? null

/** The "choose which one" sentence as it renders, filled in the way `t` fills it. */
const chooseWhich = (count: number, name: string) =>
  en.slicers.chooseWhich.replace('{{ count }}', String(count)).replace('{{ name }}', name)

beforeEach(async () => {
  vi.clearAllMocks()
  vi.spyOn(console, 'error').mockImplementation(() => {})
  await setLanguage('en')
  // The tab strip reads the capabilities; the page itself is reachable only where this says so.
  vi.spyOn(capabilities, 'capabilities').mockReturnValue(CAPS)
})

describe('SlicersPage', () => {
  // Spec G 6: this is the Slicers *tab* of the settings page, rendered into that page's frame. A
  // second `<main>` would be invalid and a second `<h1>` a second top-level heading; the settings
  // frame around it owns both.
  it('brings no landmark and no top-level heading of its own', async () => {
    await setup()

    expect(document.querySelectorAll('main')).toHaveLength(0)
    expect(document.querySelectorAll('h1')).toHaveLength(1)
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Settings')
    // Not vacuous by way of an empty page: the lead it does own is still there.
    expect(pageText()).toContain(en.slicers.lead)
  })

  describe('two installs of one product', () => {
    // Spec 3.1's measured case. Asserted on the rendered text of the rows, not on a control
    // existing: a list with no rows in it would satisfy "there is a chooser" and prove nothing
    // about whether the user can tell the two Curas apart.
    it('renders both, each carrying its own version and path, with nothing chosen', async () => {
      await setup(TWO_CURAS)

      const rows = radioText()
      expect(rows).toHaveLength(2)
      expect(rows[0]).toContain('5.12.0')
      expect(rows[0]).toContain('C:\\Program Files\\UltiMaker Cura 5.12.0\\UltiMaker-Cura.exe')
      expect(rows[1]).toContain('5.13.0')
      expect(rows[1]).toContain('C:\\Program Files\\UltiMaker Cura 5.13.0\\UltiMaker-Cura.exe')
      // The version is what tells them apart; the two must not render the same string.
      expect(rows[0]).not.toEqual(rows[1])

      // The whole point: no default is shown for a product the shell left unbound.
      expect(checkedState()).toEqual([false, false])
    })

    it('says so in words rather than leaving an unexplained pair of unchosen rows', async () => {
      await setup(TWO_CURAS)

      expect(pageText()).toContain(chooseWhich(2, 'UltiMaker Cura'))
    })

    // The positive half of the pair above, with the same fixture and one binding added. Without it,
    // a page that rendered every row unchecked unconditionally would pass the "nothing chosen"
    // assertion while being incapable of ever showing a choice.
    it('shows the install a binding names as the chosen one, and stops asking', async () => {
      await setup({ ...TWO_CURAS, bindings: { cura: CURA_513.id } })

      expect(checkedState()).toEqual([false, true])
      // A page that asked forever would be as wrong as one that never asked.
      expect(pageText()).not.toContain(chooseWhich(2, 'UltiMaker Cura'))
    })

    it('binds the install the user picks and re-renders what came back', async () => {
      const bound = { ...TWO_CURAS, bindings: { cura: CURA_512.id } }
      const { slicers } = await setup(TWO_CURAS, { bind: vi.fn().mockResolvedValue(bound) })

      fireEvent.click(radios()[0]!)

      await waitFor(() => expect(checkedState()).toEqual([true, false]))
      expect(slicers.bind).toHaveBeenCalledWith('cura', CURA_512.id)
    })

    // The control writes its own state the moment the user picks; the page owns the truth. On
    // failure the stored binding has not changed, and the radio must not sit there checked on the
    // install the shell had just refused, under a banner saying that install is gone.
    it('puts the radio back on the stored binding when the shell refuses the change', async () => {
      await setup(
        { ...TWO_CURAS, bindings: { cura: CURA_513.id } },
        { bind: vi.fn().mockRejectedValue(new ApiError('NotFound', 'no such install')) },
      )

      fireEvent.click(radios()[0]!)

      await waitFor(() => expect(alertText()).toContain(en.slicers.errorNotFound))
      expect(checkedState()).toEqual([false, true])
    })

    // The pair: a change that lands must *stay*, or "put it back" could be "never move".
    it('leaves the radio on the new install when the shell accepts the change', async () => {
      await setup(
        { ...TWO_CURAS, bindings: { cura: CURA_513.id } },
        { bind: vi.fn().mockResolvedValue({ ...TWO_CURAS, bindings: { cura: CURA_512.id } }) },
      )

      fireEvent.click(radios()[0]!)

      await waitFor(() => expect(checkedState()).toEqual([true, false]))
      expect(alertText()).toBeNull()
    })

    it('does not spend a round trip re-binding what is already bound', async () => {
      const { slicers } = await setup({ ...TWO_CURAS, bindings: { cura: CURA_513.id } })

      fireEvent.click(radios()[1]!)
      await Promise.resolve()

      expect(slicers.bind).not.toHaveBeenCalled()
    })
  })

  describe('nothing detected', () => {
    // Spec 9.2 calls this the path most likely to be wrong, because the detection spike could not
    // exercise it at all: the page must still be usable, not an empty frame.
    it('still lists every product with a way to add one by hand', async () => {
      await setup(NOTHING_FOUND)

      const text = pageText()
      for (const name of [
        'UltiMaker Cura',
        'PrusaSlicer',
        'Anycubic Slicer Next',
        'Bambu Studio',
        'OrcaSlicer',
      ]) {
        expect(text).toContain(name)
      }
      expect(radios()).toHaveLength(0)
      expect(text).toContain(en.slicers.notInstalled)
      expect(screen.getAllByRole('button', { name: en.slicers.addManual })).toHaveLength(5)
      expect(text).toContain(en.slicers.defaultNone)
    })

    it('asks the shell for an executable when a product is added by hand', async () => {
      const added: SlicerConfigDto = {
        ...NOTHING_FOUND,
        installs: [PRUSA],
        bindings: { prusaslicer: PRUSA.id },
      }
      const { slicers } = await setup(NOTHING_FOUND, {
        addManual: vi.fn().mockResolvedValue(added),
      })

      // The PrusaSlicer card's own button: the second of five, in the registry's order.
      fireEvent.click(screen.getAllByRole('button', { name: en.slicers.addManual })[1]!)

      await waitFor(() => expect(radios()).toHaveLength(1))
      expect(slicers.addManual).toHaveBeenCalledWith('prusaslicer')
      expect(radioText()[0]).toContain('2.9.6')
      expect(checkedState()).toEqual([true])
    })

    // `null` is the user closing the native dialog. It is what picking a folder does too, and it is
    // not a failure: nothing changed and nothing needs saying.
    it('changes nothing and says nothing when the dialog is cancelled', async () => {
      const { slicers } = await setup(NOTHING_FOUND, {
        addManual: vi.fn().mockResolvedValue(null),
      })

      fireEvent.click(screen.getAllByRole('button', { name: en.slicers.addManual })[0]!)
      await waitFor(() => expect(slicers.addManual).toHaveBeenCalledWith('cura'))

      expect(radios()).toHaveLength(0)
      expect(alertText()).toBeNull()
    })
  })

  it('offers a way back from a binding the app made by itself', async () => {
    const { slicers } = await setup({ ...TWO_CURAS, bindings: { cura: CURA_513.id } })

    fireEvent.click(buttonNamed(en.slicers.unbind)!)

    // `null`, and not `remove`: the install is still installed, so the next scan finds it and,
    // being the only one of its product once the second Cura is gone, binds it again.
    await waitFor(() => expect(slicers.bind).toHaveBeenCalledWith('cura', null))
  })

  it('renders no unbind control for a product that is not bound', async () => {
    // The pair. TWO_CURAS binds nothing, so a control that rendered anyway would be an unbind
    // button for a binding that does not exist, and the assertion above would pass regardless.
    await setup(TWO_CURAS)

    expect(buttonNamed(en.slicers.unbind)).toBeNull()
  })

  it('offers a way back from a default once there is one', async () => {
    const { slicers } = await setup({
      ...TWO_CURAS,
      bindings: { cura: CURA_513.id },
      defaultSlicerId: 'cura',
    })

    fireEvent.click(buttonNamed(en.slicers.clearDefault)!)

    // A default that could be set and never unset was a setting with no way back; the launch paths
    // handle its absence by refusing and naming the choice, which is the point of it.
    await waitFor(() => expect(slicers.setDefault).toHaveBeenCalledWith(null))
  })

  it('can still clear a default after the last binding is gone', async () => {
    // The control used to live inside the "there is something to choose" block, so unbinding the
    // last bound product took the select and the button together and left a default set with
    // nothing on screen to clear it. Recoverable (the launch path refuses by name), but a setting
    // whose effect the user can see and cannot reach.
    const { slicers } = await setup({ ...TWO_CURAS, bindings: {}, defaultSlicerId: 'cura' })

    expect(pageText()).toContain(en.slicers.defaultNone)
    fireEvent.click(buttonNamed(en.slicers.clearDefault)!)

    await waitFor(() => expect(slicers.setDefault).toHaveBeenCalledWith(null))
  })

  it('renders no clear-default control where there is no default', async () => {
    // The pair, and the reason the one above says anything: a control rendered unconditionally would
    // satisfy it while offering to clear a setting nobody has made.
    await setup({ ...TWO_CURAS, bindings: { cura: CURA_513.id } })

    expect(buttonNamed(en.slicers.clearDefault)).toBeNull()
  })

  describe('a platform detection cannot run on', () => {
    it('hides the rescan control and says detection is Windows-only', async () => {
      await setup({ ...NOTHING_FOUND, detectionSupported: false })

      expect(buttonNamed(en.slicers.rescan)).toBeNull()
      expect(pageText()).toContain(en.slicers.windowsOnly)
      // Manual entry is the mechanism that does work there, so it must still be offered.
      expect(buttonNamed(en.slicers.addManual)).not.toBeNull()
    })

    // The positive half: an assertion satisfied by a page that never renders a rescan control is
    // not an assertion about `detectionSupported`.
    it('offers the rescan control, and no such message, where detection does run', async () => {
      await setup(NOTHING_FOUND)

      expect(buttonNamed(en.slicers.rescan)).not.toBeNull()
      expect(pageText()).not.toContain(en.slicers.windowsOnly)
    })

    it('scans when the control is used, and replaces the whole configuration', async () => {
      const { slicers } = await setup(NOTHING_FOUND, {
        scan: vi.fn().mockResolvedValue(TWO_CURAS),
      })

      fireEvent.click(buttonNamed(en.slicers.rescan)!)

      await waitFor(() => expect(radios()).toHaveLength(2))
      expect(slicers.scan).toHaveBeenCalled()
    })
  })

  describe('what each error code says', () => {
    async function failScan(error: unknown) {
      const created = await setup(NOTHING_FOUND, { scan: vi.fn().mockRejectedValue(error) })
      fireEvent.click(buttonNamed(en.slicers.rescan)!)
      await screen.findByRole('alert')
      return created
    }

    it('offers the reset that is the only way out of a configuration it cannot write', async () => {
      await failScan(
        new ApiError('Conflict', 'slicers.json was written by a newer version of this app'),
      )

      expect(alertText()).toContain(en.slicers.errorConflict)
      expect(buttonNamed(en.slicers.reset)).not.toBeNull()
    })

    it('resets on the user word alone, and clears the message once it lands', async () => {
      const { slicers } = await failScan(new ApiError('Conflict', 'newer'))
      slicers.resetConfig.mockResolvedValue(NOTHING_FOUND)

      fireEvent.click(buttonNamed(en.slicers.reset)!)

      await waitFor(() => expect(alertText()).toBeNull())
      expect(slicers.resetConfig).toHaveBeenCalled()
    })

    // `NotFound` means two different things on this page, and which one it is depends on the call
    // rather than on anything in the error. Measured against the real shell: picking a path that is
    // not there comes back `NotFound`, and the page first said "that install is not listed any
    // more, search again": advice that cannot help, about a list the file was never in.
    it('says the picked file is gone, not that a list is stale, when adding by hand', async () => {
      await setup(NOTHING_FOUND, {
        addManual: vi.fn().mockRejectedValue(new ApiError('NotFound', 'that file is not there')),
      })
      fireEvent.click(screen.getAllByRole('button', { name: en.slicers.addManual })[0]!)
      await screen.findByRole('alert')

      expect(alertText()).toContain(en.slicers.errorPickedGone)
      expect(alertText()).not.toContain(en.slicers.errorNotFound)
    })

    it('names a vanished install rather than offering to throw the file away', async () => {
      await failScan(new ApiError('NotFound', 'no such install'))

      expect(alertText()).toContain(en.slicers.errorNotFound)
      // The reset is for one code and one code only; every other failure leaves the file alone.
      expect(buttonNamed(en.slicers.reset)).toBeNull()
    })

    it('says an install belongs to another product for a Validation refusal', async () => {
      await failScan(new ApiError('Validation', 'wrong product'))

      expect(alertText()).toContain(en.slicers.errorValidation)
    })

    it('says slicers are a desktop matter when the transport refuses outright', async () => {
      await failScan(new ApiError('Forbidden', 'browser'))

      expect(alertText()).toContain(en.slicers.errorForbidden)
    })

    // The reachable one: a PowerShell that timed out, a missing `powershell.exe`, an overflowed
    // buffer. Only `details.reason` tells it from any other `Internal`, which is why the next test
    // drives the same code without the reason.
    it('tells a detection that could not run from any other Internal failure', async () => {
      await failScan(
        new ApiError('Internal', 'could not look for slicers installed on this machine', {
          details: { reason: DETECTION_FAILED, cause: 'Error: spawn powershell.exe ENOENT' },
        }),
      )

      expect(alertText()).toContain(en.slicers.errorDetection)
      expect(alertText()).not.toContain(en.slicers.errorConflict)
    })

    it('falls back to the generic message for an Internal with no reason', async () => {
      await failScan(new ApiError('Internal', 'anything else'))

      expect(alertText()).toContain(en.errors.generic)
      expect(alertText()).not.toContain(en.slicers.errorDetection)
    })

    it('does not show the shell own English sentence in place of a translated one', async () => {
      await failScan(
        new ApiError('Internal', 'could not look for slicers installed on this machine', {
          details: { reason: DETECTION_FAILED },
        }),
      )

      expect(alertText()).not.toContain('could not look for slicers')
    })

    // A page whose very first `get()` rejects, which `setup` cannot build.
    async function failLoad(error: unknown) {
      const slicers = fakeSlicers(NOTHING_FOUND, { get: vi.fn().mockRejectedValue(error) })
      const client = { slicers } as unknown as DesktopClient
      const history = createMemoryHistory()
      history.set({ value: '/settings/slicers' })
      render(() => (
        <MemoryRouter history={history}>
          <Route path="/settings/slicers" component={() => <SlicersPage client={client} />} />
        </MemoryRouter>
      ))
      await screen.findByRole('alert')
    }

    it('says the settings could not be loaded when the first load fails', async () => {
      await failLoad(new Error('bridge gone'))

      expect(alertText()).toContain(en.slicers.errorLoad)
    })

    // The two tests below are the pair the per-call overrides need: an override that swallowed
    // every code would turn a diagnosis into a shrug.
    it('does not let the load override swallow a code that says more', async () => {
      await failLoad(new ApiError('Forbidden', 'browser'))

      expect(alertText()).toContain(en.slicers.errorForbidden)
      expect(alertText()).not.toContain(en.slicers.errorLoad)
    })

    // The override lives in the `notFound` slot; a page that answered "that file is not there any
    // more" to an unrelated internal failure would be inventing a diagnosis.
    it('does not answer an unclassifiable add-by-hand failure with the picked-file sentence', async () => {
      await setup(NOTHING_FOUND, { addManual: vi.fn().mockRejectedValue(new Error('boom')) })
      fireEvent.click(screen.getAllByRole('button', { name: en.slicers.addManual })[0]!)
      await screen.findByRole('alert')

      expect(alertText()).toContain(en.errors.generic)
      expect(alertText()).not.toContain(en.slicers.errorPickedGone)
    })

    it('does not let the add-by-hand override swallow a Conflict', async () => {
      await setup(NOTHING_FOUND, {
        addManual: vi.fn().mockRejectedValue(new ApiError('Conflict', 'newer')),
      })
      fireEvent.click(screen.getAllByRole('button', { name: en.slicers.addManual })[0]!)
      await screen.findByRole('alert')

      expect(alertText()).toContain(en.slicers.errorConflict)
      expect(alertText()).not.toContain(en.slicers.errorPickedGone)
      // And the way out is still offered, which is the practical consequence.
      expect(buttonNamed(en.slicers.reset)).not.toBeNull()
    })
  })

  describe('the default slicer', () => {
    it('is offered once a product has a binding, and not before', async () => {
      const unbound = await setup(TWO_CURAS)
      expect(pageText()).toContain(en.slicers.defaultNone)
      expect(unbound.slicers.get).toHaveBeenCalledTimes(1)
    })

    it('shows the select, with the bound products only, once one is bound', async () => {
      await setup({ ...TWO_CURAS, bindings: { cura: CURA_512.id } })

      expect(pageText()).not.toContain(en.slicers.defaultNone)
      const select = screen.getByLabelText(en.slicers.defaultTitle) as HTMLSelectElement
      expect(select.textContent).toContain(en.slicers.defaultPlaceholder)
      expect([...select.options].map((option) => option.textContent)).toEqual([
        en.slicers.defaultPlaceholder,
        'UltiMaker Cura',
      ])
    })

    const TWO_BOUND: SlicerConfigDto = {
      installs: [CURA_512, PRUSA],
      bindings: { cura: CURA_512.id, prusaslicer: PRUSA.id },
      defaultSlicerId: 'cura',
      detectionSupported: true,
    }
    const defaultSelect = () => screen.getByLabelText(en.slicers.defaultTitle) as HTMLSelectElement

    // The select owns its value exactly as the radio list does, and diverges the same way.
    it('puts the default back in the select when the shell refuses the change', async () => {
      await setup(TWO_BOUND, {
        setDefault: vi.fn().mockRejectedValue(new ApiError('Conflict', 'newer')),
      })
      expect(defaultSelect().value).toBe('cura')

      fireEvent.change(defaultSelect(), { target: { value: 'prusaslicer' } })

      await waitFor(() => expect(alertText()).toContain(en.slicers.errorConflict))
      expect(defaultSelect().value).toBe('cura')
    })

    it('leaves the new default in the select when the shell accepts it', async () => {
      await setup(TWO_BOUND, {
        setDefault: vi.fn().mockResolvedValue({ ...TWO_BOUND, defaultSlicerId: 'prusaslicer' }),
      })

      fireEvent.change(defaultSelect(), { target: { value: 'prusaslicer' } })

      await waitFor(() => expect(defaultSelect().value).toBe('prusaslicer'))
    })

    it('records the choice, and does not repeat one already stored', async () => {
      const { slicers } = await setup({
        ...TWO_BOUND,
        installs: [CURA_512, PRUSA],
        defaultSlicerId: 'cura',
      })

      fireEvent.change(defaultSelect(), { target: { value: 'cura' } })
      await Promise.resolve()
      expect(slicers.setDefault).not.toHaveBeenCalled()

      fireEvent.change(defaultSelect(), { target: { value: 'prusaslicer' } })
      await waitFor(() => expect(slicers.setDefault).toHaveBeenCalledWith('prusaslicer'))
    })
  })

  describe('removing an install', () => {
    it('asks the shell and re-renders what is left', async () => {
      const left: SlicerConfigDto = { ...TWO_CURAS, installs: [CURA_513] }
      const { slicers } = await setup(TWO_CURAS, { remove: vi.fn().mockResolvedValue(left) })

      fireEvent.click(buttonNamed(`${en.slicers.remove} ${CURA_512.label}`)!)

      await waitFor(() => expect(radios()).toHaveLength(1))
      expect(slicers.remove).toHaveBeenCalledWith(CURA_512.id)
      expect(radioText()[0]).toContain('5.13.0')
    })
  })

  describe('what one install row says', () => {
    // Neither the Cura rows nor the MSIX one can carry this: the first put the version in the label,
    // the second puts it in the path, and a page rendering only those would satisfy both.
    it('carries the version where neither the label nor the path does', async () => {
      await setup({ ...NOTHING_FOUND, installs: [BAMBU] })

      expect(radioText()[0]).toContain('Bambu Studio')
      expect(radioText()[0]).toContain('02.08.02.61')
    })

    // The path is what tells two installs of one product apart at a glance, so it renders whole: the
    // WindowsApps directory an MSIX install lives in is the longest one the app will meet.
    it('renders an MSIX path in full, version-stamped directory and all', async () => {
      await setup({ ...NOTHING_FOUND, installs: [ORCA] })

      expect(radioText()[0]).toContain(ORCA.path)
    })

    it('says the version is unknown rather than rendering a blank where there is none', async () => {
      await setup({ ...NOTHING_FOUND, installs: [BY_HAND] })

      expect(radioText()[0]).toContain(en.slicers.unknownVersion)
      expect(radioText()[0]).toContain('D:\\portable\\BambuStudio\\bambu-studio.exe')
    })
  })

  describe('an install whose executable has gone', () => {
    it('is still listed, and marked rather than dropped', async () => {
      await setup({ ...TWO_CURAS, installs: [CURA_512, { ...CURA_513, state: 'missing' }] })

      expect(radios()).toHaveLength(2)
      expect(pageText()).toContain(en.slicers.installMissing)
    })

    // The pair: with nothing missing, the marker must be absent, or its presence says nothing.
    it('and the marker is absent when both are there', async () => {
      await setup(TWO_CURAS)

      expect(pageText()).not.toContain(en.slicers.installMissing)
    })
  })

  describe('one call at a time', () => {
    // The `busy` gate, which is what makes a `Conflict` on this page unambiguous. The shell refuses
    // a second `addManual` for a different product with `Conflict` (the same code an unwritable
    // slicers.json uses, and with no details to tell them apart), so the page must not be able to
    // make that call at all: every control is disabled while one is in flight.
    it('refuses to start a second call while one is in flight', async () => {
      let release: (value: SlicerConfigDto) => void = () => {}
      const pending = new Promise<SlicerConfigDto>((resolve) => {
        release = resolve
      })
      const { slicers } = await setup(NOTHING_FOUND, {
        addManual: vi.fn().mockReturnValue(pending),
      })

      const [cura, prusa] = screen.getAllByRole('button', { name: en.slicers.addManual })
      fireEvent.click(cura!)
      await waitFor(() => expect((prusa as HTMLButtonElement).disabled).toBe(true))
      fireEvent.click(prusa!)
      release(NOTHING_FOUND)
      await waitFor(() => expect((prusa as HTMLButtonElement).disabled).toBe(false))

      expect(slicers.addManual).toHaveBeenCalledTimes(1)
      expect(slicers.addManual).toHaveBeenCalledWith('cura')
    })
  })
})

// Re-expressed from the Electron suite's `slicers.spec.ts` (which drove the real window): the same
// two user-visible flows, over the real page and a fake shell client.
describe('the Slicers tab, end to end', () => {
  it('has the tab strip above the slicers, with Slicers selected, and General one click away', async () => {
    const slicers = fakeSlicers(TWO_CURAS)
    const client = { slicers } as unknown as DesktopClient
    const history = createMemoryHistory()
    history.set({ value: '/settings/slicers' })
    render(() => (
      <MemoryRouter history={history}>
        <Route path="/settings" component={() => <p>general tab</p>} />
        <Route path="/settings/slicers" component={() => <SlicersPage client={client} />} />
      </MemoryRouter>
    ))
    await screen.findByRole('heading', { name: 'UltiMaker Cura', level: 2 })

    const tabs = screen.getAllByRole('tab')
    expect(tabs.map((tab) => tab.textContent)).toEqual(['General', 'Slicers'])
    expect(screen.getByRole('tab', { name: 'Slicers' }).getAttribute('aria-selected')).toBe('true')
    // The strip is above the rows: the first tab precedes the first product in the document.
    expect(
      tabs[0]!.compareDocumentPosition(screen.getByRole('heading', { name: 'UltiMaker Cura' })) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy()

    fireEvent.click(screen.getByRole('tab', { name: 'General' }))
    await screen.findByText('general tab')
    expect(history.get()).toBe('/settings')
  })

  it('stacks two installs of one product, chooses neither, and stops asking once one is chosen', async () => {
    const bound = { ...TWO_CURAS, bindings: { cura: CURA_513.id } }
    await setup(TWO_CURAS, { bind: vi.fn().mockResolvedValue(bound) })
    expect(radios()).toHaveLength(2)
    expect(checkedState()).toEqual([false, false])
    expect(pageText()).toContain(chooseWhich(2, 'UltiMaker Cura'))

    fireEvent.click(radios()[1]!)

    await waitFor(() => expect(checkedState()).toEqual([false, true]))
    expect(pageText()).not.toContain(chooseWhich(2, 'UltiMaker Cura'))
  })
})
