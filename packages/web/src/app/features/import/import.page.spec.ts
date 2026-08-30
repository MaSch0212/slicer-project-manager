import { TestBed } from '@angular/core/testing'
import { provideRouter } from '@angular/router'
import { describe, expect, it, vi } from 'vitest'
import { API_CLIENT } from '../../core/api/api-client.token'
import { TranslateService } from '../../core/i18n/translate.service'
import en from '../../core/i18n/locales/en.json'
import { ImportPage } from './import.page'
import { provideJigForTests } from '../../../testing/jig'

/**
 * Everything the import actually does moved to `ImportPanel` (spec G 6.2) and is covered by
 * `import.panel.spec.ts`. What is left here is the route's own contract: `/import` still
 * resolves, and what it resolves to is a landmark with a heading around that panel.
 */

async function setup(): Promise<ReturnType<typeof TestBed.createComponent<ImportPage>>> {
  TestBed.configureTestingModule({
    providers: [
      ...provideJigForTests(),
      provideRouter([{ path: 'projects', children: [] }]),
      { provide: API_CLIENT, useValue: { importer: { curaManagerZip: vi.fn() } } },
    ],
  })
  await TestBed.inject(TranslateService).ready
  const fixture = TestBed.createComponent(ImportPage)
  fixture.detectChanges()
  return fixture
}

describe('ImportPage', () => {
  it('is one landmark with a heading around the import panel', async () => {
    const fixture = await setup()
    const host = fixture.nativeElement as HTMLElement

    // Exactly one: the settings card renders the same panel inside the `<main>` that page
    // already owns, so a `<main>` inside the panel would put two on that page.
    expect(host.querySelectorAll('main')).toHaveLength(1)
    expect(host.querySelector('main > .spm-stack > h1')?.textContent?.trim()).toBe(
      en.import.heading,
    )
    expect(host.querySelector('main spm-import-panel')).not.toBeNull()
  })

  it('renders the panel itself, not just its element', async () => {
    const fixture = await setup()
    // The drop zone is the panel's own content: an element with nothing inside it would mean
    // the component was never imported, which a tag-name assertion alone cannot tell apart.
    expect((fixture.nativeElement as HTMLElement).textContent).toContain(en.import.intro)
  })
})
