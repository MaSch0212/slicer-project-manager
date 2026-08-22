import { TestBed } from '@angular/core/testing'
import { provideRouter } from '@angular/router'
import { provideJigControls, withAutoColorScheme } from '@awdlab/jig/api/ng'
import { nova } from '@awdlab/jig-themes/nova'
import { App } from './app'

describe('App', () => {
  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [App],
      // Mirrors app.config.ts: App injects ColorSchemeService directly, which needs
      // COLOR_SCHEME_STORAGE provided (only withAutoColorScheme() supplies it).
      providers: [
        provideRouter([]),
        ...provideJigControls({ theme: { preset: nova } }, withAutoColorScheme()),
      ],
    }).compileComponents()
  })

  it('should create the app', () => {
    const fixture = TestBed.createComponent(App)
    expect(fixture.componentInstance).toBeTruthy()
  })
})
