/* @refresh reload */
import { Route, Router } from '@solidjs/router'
import { render } from 'solid-js/web'
import './styles.css'
import { HomePage } from './home-page'

render(
  () => (
    <Router>
      <Route path="/" component={HomePage} />
    </Router>
  ),
  document.getElementById('root')!,
)
