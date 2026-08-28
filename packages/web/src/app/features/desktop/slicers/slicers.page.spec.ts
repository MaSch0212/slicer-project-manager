import { TestBed } from '@angular/core/testing'
import { describe, expect, it, vi } from 'vitest'
import type { SlicerConfigDto, SlicerInstallDto } from '@spm/contract/dtos.ts'
import { AppError, DETECTION_FAILED } from '@spm/contract/errors.ts'
import { TranslateService } from '../../../core/i18n/translate.service'
import { provideJigForTests } from '../../../../testing/jig'
import { SHELL_CLIENT } from '../shell-client.token'
import { DesktopSlicersPage } from './slicers.page'

/**
 * The two installs this developer's machine really has, from task 2's own detection run — the
 * uninstall keys, the versions and the paths verbatim.
 *
 * They are the whole reason this page exists in the shape it does: one `SlicerId`, two working
 * installs, and no honest way for the app to pick between them.
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
  // The registry DisplayName really is bare, unlike Cura's — checked against a live detection run.
  label: 'PrusaSlicer',
  version: '2.9.6',
  path: 'C:\\Program Files\\Prusa3D\\PrusaSlicer\\prusa-slicer.exe',
  origin: 'registry',
  state: 'ok',
}

/**
 * The row that keeps the version assertions honest, and the reason it had to be this one.
 *
 * Both Cura labels carry their version *inside* the registry DisplayName, and the MSIX path below
 * carries it inside a directory name, so neither can tell a page that renders the version from one
 * that does not. Bambu Studio's label is bare and its path is version-free — checked against a
 * live detection run on this machine, which is also where the odd `02.08.02.61` spelling is from.
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

/** The MSIX row from the same run: a package family for an id, and a path that embeds a version. */
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

type Slicers = {
  get: ReturnType<typeof vi.fn>
  scan: ReturnType<typeof vi.fn>
  addManual: ReturnType<typeof vi.fn>
  remove: ReturnType<typeof vi.fn>
  bind: ReturnType<typeof vi.fn>
  setDefault: ReturnType<typeof vi.fn>
  resetConfig: ReturnType<typeof vi.fn>
}

type Setup = {
  fixture: ReturnType<typeof TestBed.createComponent<DesktopSlicersPage>>
  slicers: Slicers
  page: DesktopSlicersPage
  translate: TranslateService
}

/**
 * A fake bridge on `SHELL_CLIENT`, which is the seam the token exists for: no preload, no
 * Electron, and the page is the same object the shell renders.
 */
async function setup(
  config: SlicerConfigDto = TWO_CURAS,
  overrides: Partial<Slicers> = {},
): Promise<Setup> {
  const slicers: Slicers = {
    get: vi.fn().mockResolvedValue(config),
    scan: vi.fn().mockResolvedValue(config),
    addManual: vi.fn().mockResolvedValue(config),
    remove: vi.fn().mockResolvedValue(config),
    bind: vi.fn().mockResolvedValue(config),
    setDefault: vi.fn().mockResolvedValue(config),
    resetConfig: vi.fn().mockResolvedValue(config),
    ...overrides,
  }
  TestBed.configureTestingModule({
    providers: [...provideJigForTests(), { provide: SHELL_CLIENT, useValue: { slicers } }],
  })
  const translate = TestBed.inject(TranslateService)
  // Before createComponent, as every page spec here does: TestBed auto-detects changes and the
  // template reads t.translations() unguarded.
  await translate.ready
  const fixture = TestBed.createComponent(DesktopSlicersPage)
  // The first `slicers.get()` is fired from the constructor; `ready` is what makes it awaitable
  // rather than a microtask count.
  await fixture.componentInstance.ready
  fixture.detectChanges()
  return { fixture, slicers, page: fixture.componentInstance, translate }
}

function host(fixture: Setup['fixture']): HTMLElement {
  fixture.detectChanges()
  return fixture.nativeElement as HTMLElement
}

/** Every install row, found the way a screen reader finds it. */
function radios(fixture: Setup['fixture']): HTMLElement[] {
  return [...host(fixture).querySelectorAll('[role="radio"]')] as HTMLElement[]
}

function radioText(fixture: Setup['fixture']): string[] {
  return radios(fixture).map((radio) => radio.textContent?.replace(/\s+/g, ' ').trim() ?? '')
}

function checkedState(fixture: Setup['fixture']): (string | null)[] {
  return radios(fixture).map((radio) => radio.getAttribute('aria-checked'))
}

function pageText(fixture: Setup['fixture']): string {
  return host(fixture).textContent?.replace(/\s+/g, ' ') ?? ''
}

function alertText(fixture: Setup['fixture']): string | null {
  return host(fixture).querySelector('[role="alert"]')?.textContent?.replace(/\s+/g, ' ') ?? null
}

/** The "choose which one" sentence as it renders, filled in the way the template's pipe fills it. */
function chooseWhich(translate: TranslateService, count: number, name: string): string {
  return translate
    .translations()
    .slicers.chooseWhich.replace('{{ count }}', String(count))
    .replace('{{ name }}', name)
}

/** A control found by the label a user reads on it, not by a class or a position. */
function buttonNamed(fixture: Setup['fixture'], label: string): HTMLButtonElement | null {
  const buttons = [...host(fixture).querySelectorAll('button')] as HTMLButtonElement[]
  return (
    buttons.find(
      (button) =>
        button.textContent?.replace(/\s+/g, ' ').trim() === label ||
        button.getAttribute('aria-label') === label,
    ) ?? null
  )
}

describe('DesktopSlicersPage', () => {
  describe('two installs of one product', () => {
    // Spec 3.1's measured case. Asserted on the rendered text of the rows, not on a control
    // existing: a `<select>` with no options in it would satisfy "there is a chooser" and prove
    // nothing about whether the user can tell the two Curas apart.
    it('renders both, each carrying its own version and path, with nothing chosen', async () => {
      const { fixture } = await setup(TWO_CURAS)

      const rows = radioText(fixture)
      expect(rows).toHaveLength(2)
      expect(rows[0]).toContain('5.12.0')
      expect(rows[0]).toContain('C:\\Program Files\\UltiMaker Cura 5.12.0\\UltiMaker-Cura.exe')
      expect(rows[1]).toContain('5.13.0')
      expect(rows[1]).toContain('C:\\Program Files\\UltiMaker Cura 5.13.0\\UltiMaker-Cura.exe')
      // The version is what tells them apart; the two must not render the same string.
      expect(rows[0]).not.toEqual(rows[1])

      // The whole point: no default is shown for a product the shell left unbound.
      expect(checkedState(fixture)).toEqual(['false', 'false'])
    })

    it('says so in words rather than leaving an unexplained pair of unchosen rows', async () => {
      const { fixture, translate } = await setup(TWO_CURAS)

      expect(pageText(fixture)).toContain(chooseWhich(translate, 2, 'UltiMaker Cura'))
    })

    /*
     * The positive half of the pair above, with the same fixture and one binding added. Without
     * it, a page that rendered `aria-checked="false"` on every row unconditionally would pass the
     * "nothing chosen" assertion while being incapable of ever showing a choice.
     */
    it('shows the install a binding names as the chosen one, and stops asking', async () => {
      const { fixture, translate } = await setup({ ...TWO_CURAS, bindings: { cura: CURA_513.id } })

      expect(checkedState(fixture)).toEqual(['false', 'true'])
      // A page that asked forever would be as wrong as one that never asked.
      expect(pageText(fixture)).not.toContain(chooseWhich(translate, 2, 'UltiMaker Cura'))
    })

    it('binds the install the user picks and re-renders what came back', async () => {
      const bound = { ...TWO_CURAS, bindings: { cura: CURA_512.id } }
      const { fixture, page, slicers } = await setup(TWO_CURAS, {
        bind: vi.fn().mockResolvedValue(bound),
      })

      await page.onBind('cura', CURA_512.id)

      expect(slicers.bind).toHaveBeenCalledWith('cura', CURA_512.id)
      expect(checkedState(fixture)).toEqual(['true', 'false'])
    })

    it('does not spend a round trip re-binding what is already bound', async () => {
      const { page, slicers } = await setup({ ...TWO_CURAS, bindings: { cura: CURA_513.id } })

      await page.onBind('cura', CURA_513.id)

      expect(slicers.bind).not.toHaveBeenCalled()
    })
  })

  describe('nothing detected', () => {
    // Spec 9.2 calls this the path most likely to be wrong, because the detection spike could
    // not exercise it at all: the page must still be usable, not an empty frame.
    it('still lists every product with a way to add one by hand', async () => {
      const { fixture, translate } = await setup(NOTHING_FOUND)
      const strings = translate.translations().slicers

      const text = pageText(fixture)
      for (const name of [
        'UltiMaker Cura',
        'PrusaSlicer',
        'Anycubic Slicer Next',
        'Bambu Studio',
        'OrcaSlicer',
      ]) {
        expect(text).toContain(name)
      }
      expect(radios(fixture)).toHaveLength(0)
      expect(text).toContain(strings.notInstalled)
      expect(buttonNamed(fixture, strings.addManual)).not.toBeNull()
      expect(text).toContain(strings.defaultNone)
    })

    it('asks the shell for an executable when a product is added by hand', async () => {
      const added: SlicerConfigDto = {
        ...NOTHING_FOUND,
        installs: [PRUSA],
        bindings: { prusaslicer: PRUSA.id },
      }
      const { fixture, page, slicers } = await setup(NOTHING_FOUND, {
        addManual: vi.fn().mockResolvedValue(added),
      })

      await page.onAddManual('prusaslicer')

      expect(slicers.addManual).toHaveBeenCalledWith('prusaslicer')
      expect(radioText(fixture)[0]).toContain('2.9.6')
      expect(checkedState(fixture)).toEqual(['true'])
    })

    // `null` is the user closing the native picker. It is what `library.pick` does too, and it
    // is not a failure: nothing changed and nothing needs saying.
    it('changes nothing and says nothing when the picker is cancelled', async () => {
      const { fixture, page } = await setup(NOTHING_FOUND, {
        addManual: vi.fn().mockResolvedValue(null),
      })

      await page.onAddManual('cura')

      expect(radios(fixture)).toHaveLength(0)
      expect(alertText(fixture)).toBeNull()
      expect(page.config()).toEqual(NOTHING_FOUND)
    })
  })

  describe('a platform detection cannot run on', () => {
    it('hides the rescan control and says detection is Windows-only', async () => {
      const { fixture, translate } = await setup({ ...NOTHING_FOUND, detectionSupported: false })
      const strings = translate.translations().slicers

      expect(buttonNamed(fixture, strings.rescan)).toBeNull()
      expect(pageText(fixture)).toContain(strings.windowsOnly)
      // Manual entry is the mechanism that does work there, so it must still be offered.
      expect(buttonNamed(fixture, strings.addManual)).not.toBeNull()
    })

    // The positive half: an assertion satisfied by a page that never renders a rescan control is
    // not an assertion about `detectionSupported`.
    it('offers the rescan control, and no such message, where detection does run', async () => {
      const { fixture, translate } = await setup(NOTHING_FOUND)
      const strings = translate.translations().slicers

      expect(buttonNamed(fixture, strings.rescan)).not.toBeNull()
      expect(pageText(fixture)).not.toContain(strings.windowsOnly)
    })

    it('scans when the control is used, and replaces the whole configuration', async () => {
      const { fixture, slicers } = await setup(NOTHING_FOUND, {
        scan: vi.fn().mockResolvedValue(TWO_CURAS),
      })

      buttonNamed(fixture, TestBed.inject(TranslateService).translations().slicers.rescan)?.click()
      await Promise.resolve()

      expect(slicers.scan).toHaveBeenCalled()
      expect(radioText(fixture)).toHaveLength(2)
    })
  })

  describe('what each error code says', () => {
    async function failScan(error: unknown): Promise<Setup> {
      const created = await setup(NOTHING_FOUND, { scan: vi.fn().mockRejectedValue(error) })
      await created.page.onRescan()
      return created
    }

    it('offers the reset that is the only way out of a configuration it cannot write', async () => {
      const { fixture, translate } = await failScan(
        new AppError('Conflict', 'slicers.json was written by a newer version of this app'),
      )
      const strings = translate.translations().slicers

      expect(alertText(fixture)).toContain(strings.errorConflict)
      expect(buttonNamed(fixture, strings.reset)).not.toBeNull()
    })

    it('resets on the user word alone, and clears the message once it lands', async () => {
      const { fixture, slicers, translate } = await failScan(new AppError('Conflict', 'newer'))
      slicers.resetConfig.mockResolvedValue(NOTHING_FOUND)

      buttonNamed(fixture, translate.translations().slicers.reset)?.click()
      await Promise.resolve()

      expect(slicers.resetConfig).toHaveBeenCalled()
      expect(alertText(fixture)).toBeNull()
    })

    /*
     * `NotFound` means two different things on this page, and which one it is depends on the call
     * rather than on anything in the error. Measured against the real shell: picking a path that
     * is not there comes back `NotFound`, and the page first said "that install is not listed any
     * more, look for installed slicers again" — advice that cannot help, about a list the file was
     * never in.
     */
    it('says the picked file is gone, not that a list is stale, when adding by hand', async () => {
      const created = await setup(NOTHING_FOUND, {
        addManual: vi.fn().mockRejectedValue(new AppError('NotFound', 'that file is not there')),
      })
      await created.page.onAddManual('cura')
      const strings = created.translate.translations().slicers

      expect(alertText(created.fixture)).toContain(strings.errorPickedGone)
      expect(alertText(created.fixture)).not.toContain(strings.errorNotFound)
    })

    it('names a vanished install rather than offering to throw the file away', async () => {
      const { fixture, translate } = await failScan(new AppError('NotFound', 'no such install'))
      const strings = translate.translations().slicers

      expect(alertText(fixture)).toContain(strings.errorNotFound)
      // The reset is for one code and one code only; every other failure leaves the file alone.
      expect(buttonNamed(fixture, strings.reset)).toBeNull()
    })

    it('says an install belongs to another product for a Validation refusal', async () => {
      const { fixture, translate } = await failScan(new AppError('Validation', 'wrong product'))

      expect(alertText(fixture)).toContain(translate.translations().slicers.errorValidation)
    })

    it('says slicers are a desktop matter when the transport refuses outright', async () => {
      const { fixture, translate } = await failScan(new AppError('Forbidden', 'browser'))

      expect(alertText(fixture)).toContain(translate.translations().slicers.errorForbidden)
    })

    /*
     * The reachable one: a PowerShell that timed out, a missing `powershell.exe`, an overflowed
     * buffer. Only `details.reason` tells it from any other `Internal`, which is why the next
     * test drives the same code without the reason.
     */
    it('tells a detection that could not run from any other Internal failure', async () => {
      const { fixture, translate } = await failScan(
        new AppError('Internal', 'could not look for slicers installed on this machine', {
          reason: DETECTION_FAILED,
          cause: 'Error: spawn powershell.exe ENOENT',
        }),
      )
      const strings = translate.translations().slicers

      expect(alertText(fixture)).toContain(strings.errorDetection)
      expect(alertText(fixture)).not.toContain(strings.errorConflict)
    })

    it('falls back to the generic message for an Internal with no reason', async () => {
      const { fixture, translate } = await failScan(new AppError('Internal', 'anything else'))

      expect(alertText(fixture)).toContain(translate.translations().errors.generic)
      expect(alertText(fixture)).not.toContain(translate.translations().slicers.errorDetection)
    })

    it('does not show the shell own English sentence in place of a translated one', async () => {
      const { fixture } = await failScan(
        new AppError('Internal', 'could not look for slicers installed on this machine', {
          reason: DETECTION_FAILED,
        }),
      )

      expect(alertText(fixture)).not.toContain('could not look for slicers')
    })

    /** A page whose very first `slicers.get()` rejects, which `setup` cannot build. */
    async function failLoad(error: unknown): Promise<Setup> {
      const slicers: Slicers = {
        get: vi.fn().mockRejectedValue(error),
        scan: vi.fn(),
        addManual: vi.fn(),
        remove: vi.fn(),
        bind: vi.fn(),
        setDefault: vi.fn(),
        resetConfig: vi.fn(),
      }
      TestBed.configureTestingModule({
        providers: [...provideJigForTests(), { provide: SHELL_CLIENT, useValue: { slicers } }],
      })
      const translate = TestBed.inject(TranslateService)
      await translate.ready
      const fixture = TestBed.createComponent(DesktopSlicersPage)
      await fixture.componentInstance.ready
      return { fixture, slicers, page: fixture.componentInstance, translate }
    }

    it('says the configuration could not be read when the first load fails', async () => {
      const { fixture, translate } = await failLoad(new Error('bridge gone'))

      expect(alertText(fixture)).toContain(translate.translations().slicers.errorLoad)
    })

    /*
     * The two tests below are the pair the per-call overrides need, and one of them was written
     * because a mutation went green without it: replacing the "which code is being overridden"
     * check with "use whichever override was passed" changed nothing any test could see. An
     * override that swallowed every code would turn a diagnosis into a shrug.
     */
    it('does not let the load override swallow a code that says more', async () => {
      const { fixture, translate } = await failLoad(new AppError('Forbidden', 'browser'))
      const strings = translate.translations().slicers

      expect(alertText(fixture)).toContain(strings.errorForbidden)
      expect(alertText(fixture)).not.toContain(strings.errorLoad)
    })

    it('does not let the add-by-hand override swallow a Conflict', async () => {
      const created = await setup(NOTHING_FOUND, {
        addManual: vi.fn().mockRejectedValue(new AppError('Conflict', 'newer')),
      })
      await created.page.onAddManual('cura')
      const strings = created.translate.translations().slicers

      expect(alertText(created.fixture)).toContain(strings.errorConflict)
      expect(alertText(created.fixture)).not.toContain(strings.errorPickedGone)
      // And the way out is still offered, which is the practical consequence.
      expect(buttonNamed(created.fixture, strings.reset)).not.toBeNull()
    })
  })

  describe('the default slicer', () => {
    it('is offered once a product has a binding, and not before', async () => {
      const unbound = await setup(TWO_CURAS)
      const strings = unbound.translate.translations().slicers
      expect(pageText(unbound.fixture)).toContain(strings.defaultNone)

      TestBed.resetTestingModule()
      const bound = await setup({ ...TWO_CURAS, bindings: { cura: CURA_512.id } })
      expect(pageText(bound.fixture)).not.toContain(strings.defaultNone)
      expect(pageText(bound.fixture)).toContain(strings.defaultPlaceholder)
    })

    it('records the choice, and does not repeat one already stored', async () => {
      const { page, slicers } = await setup({
        ...TWO_CURAS,
        bindings: { cura: CURA_512.id },
        defaultSlicerId: 'cura',
      })

      await page.onSetDefault('cura')
      expect(slicers.setDefault).not.toHaveBeenCalled()

      await page.onSetDefault('prusaslicer')
      expect(slicers.setDefault).toHaveBeenCalledWith('prusaslicer')
    })
  })

  describe('removing an install', () => {
    it('asks the shell and re-renders what is left', async () => {
      const left: SlicerConfigDto = { ...TWO_CURAS, installs: [CURA_513] }
      const { fixture, slicers, translate } = await setup(TWO_CURAS, {
        remove: vi.fn().mockResolvedValue(left),
      })

      buttonNamed(fixture, `${translate.translations().slicers.remove} ${CURA_512.label}`)?.click()
      await Promise.resolve()

      expect(slicers.remove).toHaveBeenCalledWith(CURA_512.id)
      expect(radioText(fixture)).toHaveLength(1)
      expect(radioText(fixture)[0]).toContain('5.13.0')
    })
  })

  describe('what one install row says', () => {
    // Neither the Cura rows nor the MSIX one can carry this: the first put the version in the
    // label, the second puts it in the path, and a page rendering only those would satisfy both.
    it('carries the version where neither the label nor the path does', async () => {
      const { fixture } = await setup({ ...NOTHING_FOUND, installs: [BAMBU] })

      expect(radioText(fixture)[0]).toContain('Bambu Studio')
      expect(radioText(fixture)[0]).toContain('02.08.02.61')
    })

    // The path is what tells two installs of one product apart at a glance, so it renders whole:
    // the WindowsApps directory an MSIX install lives in is the longest one the app will meet.
    it('renders an MSIX path in full, version-stamped directory and all', async () => {
      const { fixture } = await setup({ ...NOTHING_FOUND, installs: [ORCA] })

      expect(radioText(fixture)[0]).toContain(ORCA.path)
    })

    it('says the version is unknown rather than rendering a blank where there is none', async () => {
      const { fixture, translate } = await setup({ ...NOTHING_FOUND, installs: [BY_HAND] })

      expect(radioText(fixture)[0]).toContain(translate.translations().slicers.unknownVersion)
      expect(radioText(fixture)[0]).toContain('D:\\portable\\BambuStudio\\bambu-studio.exe')
    })
  })

  describe('an install whose executable has gone', () => {
    it('is still listed, and marked rather than dropped', async () => {
      const { fixture, translate } = await setup({
        ...TWO_CURAS,
        installs: [CURA_512, { ...CURA_513, state: 'missing' }],
      })

      expect(radioText(fixture)).toHaveLength(2)
      expect(pageText(fixture)).toContain(translate.translations().slicers.installMissing)
    })

    // The pair: with nothing missing, the marker must be absent, or its presence says nothing.
    it('and the marker is absent when both are there', async () => {
      const { fixture, translate } = await setup(TWO_CURAS)

      expect(pageText(fixture)).not.toContain(translate.translations().slicers.installMissing)
    })
  })

  describe('one call at a time', () => {
    /*
     * The `busy` gate, which is what makes a `Conflict` on this page unambiguous. The shell
     * refuses a second `addManual` for a different product with `Conflict` — the same code an
     * unwritable slicers.json uses, and with no details to tell them apart — so the page must not
     * be able to make that call at all.
     */
    it('refuses to start a second call while one is in flight', async () => {
      let release: (value: SlicerConfigDto) => void = () => {}
      const pending = new Promise<SlicerConfigDto>((resolve) => {
        release = resolve
      })
      const { page, slicers } = await setup(NOTHING_FOUND, {
        addManual: vi.fn().mockReturnValue(pending),
      })

      const first = page.onAddManual('cura')
      const second = page.onAddManual('prusaslicer')
      release(NOTHING_FOUND)
      await Promise.all([first, second])

      expect(slicers.addManual).toHaveBeenCalledTimes(1)
      expect(slicers.addManual).toHaveBeenCalledWith('cura')
    })
  })
})
