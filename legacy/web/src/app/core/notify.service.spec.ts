import { TestBed } from '@angular/core/testing'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NotifyService } from './notify.service'

// `@awdlab/jig/snackbar` is a bare package specifier, not a relative one — unlike
// translate.service.spec.ts's dynamic import of './locales/de.json', Angular's vitest
// integration only refuses `vi.mock` on relative specifiers, so mocking this module directly is
// available here. `show` is declared through `vi.hoisted` because `vi.mock`'s factory runs
// before the rest of this file (Vitest hoists it to the top of the module), so a plain
// module-scope `const` referenced from inside the factory would not exist yet when it runs.
const { show } = vi.hoisted(() => ({ show: vi.fn() }))

vi.mock('@awdlab/jig/snackbar', () => ({
  injectSnackbarCreator: () => ({ show }),
}))

describe('NotifyService', () => {
  beforeEach(() => {
    show.mockClear()
    TestBed.configureTestingModule({})
  })

  it('shows a closable, non-assertive-by-name success snackbar', () => {
    const notify = TestBed.inject(NotifyService)
    notify.success('Saved')
    expect(show).toHaveBeenCalledExactlyOnceWith({ content: 'Saved', color: 'success' })
  })

  it('shows an info snackbar', () => {
    const notify = TestBed.inject(NotifyService)
    notify.info('Copied')
    expect(show).toHaveBeenCalledExactlyOnceWith({ content: 'Copied', color: 'info' })
  })

  // jig derives assertive/`role="alert"` announcement from `color: 'error'` on its own (see
  // awdlab-jig-snackbar.d.ts) — this test guards that NotifyService keeps sending that color
  // rather than, say, silently regressing to a generic one, since NotifyService itself sets no
  // `ariaLive` for the library to key off of anything else.
  it('shows a closable, error-colored snackbar', () => {
    const notify = TestBed.inject(NotifyService)
    notify.error('Could not save')
    expect(show).toHaveBeenCalledExactlyOnceWith({
      content: 'Could not save',
      color: 'error',
      closable: true,
    })
  })
})
