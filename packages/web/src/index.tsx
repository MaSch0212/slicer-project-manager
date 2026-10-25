/* @refresh reload */
import { Router } from '@solidjs/router'
import { render } from 'solid-js/web'
import './styles.css'
import { bootstrap } from './core/session'
import { applyTheme, cachedTheme } from './core/theme'
import { routes } from './routes'
import { Shell } from './shell/shell'
import { Spinner } from './ui'

// The cached theme first, synchronously: the server's setting arrives after the first paint, and
// a dark-mode user must not see a light frame in between.
applyTheme(cachedTheme())

const root = document.getElementById('root')!

// Capabilities, session and settings are known before the first real render, so a signed-in
// user never sees the login page or an English flash flicker past.
const dispose = render(
  () => (
    <div class="flex min-h-dvh items-center justify-center">
      <Spinner size="lg" />
    </div>
  ),
  root,
)
void bootstrap().then(() => {
  dispose()
  render(() => <Router root={Shell}>{routes}</Router>, root)
})
