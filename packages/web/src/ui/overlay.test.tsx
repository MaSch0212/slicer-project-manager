import { fireEvent, render, screen, waitFor } from '@solidjs/testing-library'
import { createSignal } from 'solid-js'
import { describe, expect, it } from 'vitest'
import { Dialog, Menu, overlayOpen } from '.'

/**
 * What the desktop model browser relies on: every layer the page raises over itself says so, and
 * stops saying so when it goes. A native view paints over the page, so a layer that did not claim
 * would open invisibly underneath it.
 */
describe('overlay claims', () => {
  it('a dialog claims while it is open and releases when it closes', async () => {
    const [open, setOpen] = createSignal(false)
    render(() => (
      <Dialog open={open()} onOpenChange={setOpen} title="A dialog">
        body
      </Dialog>
    ))
    expect(overlayOpen()).toBe(false)
    setOpen(true)
    await waitFor(() => expect(overlayOpen()).toBe(true))
    setOpen(false)
    await waitFor(() => expect(overlayOpen()).toBe(false))
  })

  it('a dialog that is removed while open releases its claim', async () => {
    const [shown, setShown] = createSignal(true)
    render(() => (
      <>
        {shown() && (
          <Dialog open onOpenChange={() => {}} title="Going away">
            body
          </Dialog>
        )}
      </>
    ))
    await waitFor(() => expect(overlayOpen()).toBe(true))
    setShown(false)
    await waitFor(() => expect(overlayOpen()).toBe(false))
  })

  it('a menu claims while it is open', async () => {
    render(() => <Menu label="Actions" items={[{ label: 'One', onSelect: () => {} }]} />)
    expect(overlayOpen()).toBe(false)
    fireEvent.keyDown(screen.getByRole('button', { name: 'Actions' }), { key: 'Enter' })
    fireEvent.click(screen.getByRole('button', { name: 'Actions' }))
    await waitFor(() => expect(overlayOpen()).toBe(true))
    fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' })
    await waitFor(() => expect(overlayOpen()).toBe(false))
  })
})
