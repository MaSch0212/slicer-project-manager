import { render, screen } from '@solidjs/testing-library'
import { expect, test } from 'vitest'
import { HomePage } from './home-page'

test('renders the heading', () => {
  render(() => <HomePage />)
  expect(screen.getByRole('heading', { name: 'Slicer Project Manager' })).toBeTruthy()
})
