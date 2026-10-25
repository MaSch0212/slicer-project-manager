import { fireEvent, render, screen, waitFor } from '@solidjs/testing-library'
import { createSignal } from 'solid-js'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { notify } from '../core/notify'
import {
  Button,
  Checkbox,
  Dialog,
  FormField,
  IconButton,
  Input,
  MultiSelect,
  Plus,
  Select,
  Switch,
  Tag,
  TagInput,
  ToastRegion,
  dismissAllToasts,
} from '.'

describe('Button', () => {
  it('is a type=button by default, so it never submits a form by accident', () => {
    render(() => <Button>Go</Button>)
    expect(screen.getByRole('button', { name: 'Go' }).getAttribute('type')).toBe('button')
  })

  it('fires its handler', () => {
    const onClick = vi.fn()
    render(() => <Button onClick={onClick}>Go</Button>)
    fireEvent.click(screen.getByRole('button'))
    expect(onClick).toHaveBeenCalledOnce()
  })

  it('does not fire when disabled', () => {
    const onClick = vi.fn()
    render(() => (
      <Button disabled onClick={onClick}>
        Go
      </Button>
    ))
    const button = screen.getByRole('button') as HTMLButtonElement
    expect(button.disabled).toBe(true)
    fireEvent.click(button)
    expect(onClick).not.toHaveBeenCalled()
  })

  it('while loading is disabled, busy, shows a spinner and never fires', () => {
    const onClick = vi.fn()
    const { container } = render(() => (
      <Button loading icon={Plus} onClick={onClick}>
        Save
      </Button>
    ))
    const button = screen.getByRole('button', { name: 'Save' }) as HTMLButtonElement
    expect(button.disabled).toBe(true)
    expect(button.getAttribute('aria-busy')).toBe('true')
    expect(container.querySelector('svg.animate-spin')).not.toBeNull()
    fireEvent.click(button)
    expect(onClick).not.toHaveBeenCalled()
  })

  it('renders its icon when not loading', () => {
    const { container } = render(() => <Button icon={Plus}>Add</Button>)
    expect(container.querySelector('svg.lucide-plus')).not.toBeNull()
    expect(container.querySelector('svg.animate-spin')).toBeNull()
  })
})

describe('IconButton', () => {
  it('is named by its label, with or without a tooltip', () => {
    render(() => (
      <>
        <IconButton icon={Plus} label="Add" />
        <IconButton icon={Plus} label="Add quietly" tooltip={false} />
      </>
    ))
    expect(screen.getByRole('button', { name: 'Add' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Add quietly' })).toBeTruthy()
  })
})

describe('FormField', () => {
  it('wires the label, hint and error to the control inside it', () => {
    render(() => (
      <FormField label="Name" hint="A hint" error="Required" required>
        <Input />
      </FormField>
    ))
    const input = screen.getByLabelText(/Name/)
    expect(input.getAttribute('aria-invalid')).toBe('true')
    const described = input.getAttribute('aria-describedby')!.split(' ')
    expect(described).toHaveLength(2)
    expect(screen.getByRole('alert').textContent).toBe('Required')
    expect(document.getElementById(described[0]!)!.textContent).toBe('A hint')
    expect((input as HTMLInputElement).required).toBe(true)
  })

  it('is valid, and undescribed, with neither hint nor error', () => {
    render(() => (
      <FormField label="Name">
        <Input />
      </FormField>
    ))
    const input = screen.getByLabelText('Name')
    expect(input.hasAttribute('aria-invalid')).toBe(false)
    expect(input.hasAttribute('aria-describedby')).toBe(false)
  })
})

describe('Select', () => {
  it('shows the chosen option and reports a change', () => {
    const onChange = vi.fn()
    render(() => (
      <Select
        value="b"
        onChange={onChange}
        options={[
          { value: 'a', label: 'Alpha' },
          { value: 'b', label: 'Beta' },
        ]}
      />
    ))
    const select = screen.getByRole('combobox') as HTMLSelectElement
    expect(select.value).toBe('b')
    fireEvent.change(select, { target: { value: 'a' } })
    expect(onChange).toHaveBeenCalledWith('a')
  })
})

describe('Checkbox and Switch', () => {
  it('toggle and report', () => {
    const onCheck = vi.fn()
    const onSwitch = vi.fn()
    render(() => (
      <>
        <Checkbox label="Archived" onChange={onCheck} />
        <Switch label="Collapse" onChange={onSwitch} />
      </>
    ))
    fireEvent.click(screen.getByRole('checkbox', { name: 'Archived' }))
    fireEvent.click(screen.getByRole('switch', { name: 'Collapse' }))
    expect(onCheck).toHaveBeenCalledWith(true)
    expect(onSwitch).toHaveBeenCalledWith(true)
  })
})

describe('Tag', () => {
  it('removes through a named button', () => {
    const onRemove = vi.fn()
    render(() => (
      <Tag onRemove={onRemove} removeLabel="Remove gadgets">
        gadgets
      </Tag>
    ))
    fireEvent.click(screen.getByRole('button', { name: 'Remove gadgets' }))
    expect(onRemove).toHaveBeenCalledOnce()
  })
})

describe('MultiSelect', () => {
  const options = ['A', 'B', 'C'].map((value) => ({ value, label: `Tag ${value}` }))

  it('shows no count badge while nothing is chosen', () => {
    render(() => <MultiSelect label="Tags" options={options} value={[]} onChange={() => {}} />)
    const trigger = screen.getByRole('button', { name: 'Tags' })
    expect(trigger.textContent).toBe('Tags')
  })

  it('shows the number chosen as a count badge, and follows it', () => {
    const [value, setValue] = createSignal(['A', 'B'])
    render(() => <MultiSelect label="Tags" options={options} value={value()} onChange={setValue} />)
    const trigger = screen.getByRole('button', { name: 'Tags' })
    expect(trigger.textContent).toBe('Tags2')
    setValue(['A', 'B', 'C'])
    expect(trigger.textContent).toBe('Tags3')
    setValue([])
    expect(trigger.textContent).toBe('Tags')
  })
})

describe('TagInput', () => {
  function setup() {
    const [value, setValue] = createSignal<string[]>(['one'])
    const view = render(() => (
      <TagInput
        label="Tags"
        value={value()}
        onChange={setValue}
        maxLength={5}
        suggestions={['two']}
      />
    ))
    return { value, input: screen.getByRole('textbox', { name: 'Tags' }) as HTMLInputElement, view }
  }

  it('adds on Enter, trimmed, and ignores a duplicate in any case', () => {
    const { value, input } = setup()
    fireEvent.input(input, { target: { value: '  new ' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(value()).toEqual(['one', 'new'])
    fireEvent.input(input, { target: { value: 'ONE' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(value()).toEqual(['one', 'new'])
  })

  it('adds on comma and refuses a name over the length limit', () => {
    const { value, input } = setup()
    fireEvent.input(input, { target: { value: 'ab,' } })
    expect(value()).toEqual(['one', 'ab'])
    fireEvent.input(input, { target: { value: 'toolong' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(value()).toEqual(['one', 'ab'])
  })

  it('removes the last tag on Backspace in an empty box', () => {
    const { value, input } = setup()
    fireEvent.keyDown(input, { key: 'Backspace' })
    expect(value()).toEqual([])
  })

  it('offers suggestions on focus and adds one by pressing it', () => {
    const { value, input } = setup()
    fireEvent.focus(input)
    fireEvent.mouseDown(screen.getByRole('option', { name: 'two' }))
    expect(value()).toEqual(['one', 'two'])
  })
})

describe('Dialog', () => {
  function Harness(props: { onClose?: (open: boolean) => void }) {
    const [open, setOpen] = createSignal(false)
    return (
      <>
        <button onClick={() => setOpen(true)}>Open</button>
        <Dialog
          open={open()}
          onOpenChange={(next) => {
            setOpen(next)
            props.onClose?.(next)
          }}
          title="Edit"
          description="Change it"
          closeLabel="Close dialog"
          footer={<Button>Save</Button>}
        >
          <Input aria-label="Name" />
        </Dialog>
      </>
    )
  }

  it('is a labelled modal dialog, closed until opened', async () => {
    render(() => <Harness />)
    expect(screen.queryByRole('dialog')).toBeNull()
    fireEvent.click(screen.getByText('Open'))
    const dialog = await screen.findByRole('dialog', { name: 'Edit' })
    expect(dialog.getAttribute('aria-describedby')).toBeTruthy()
  })

  it('moves focus inside on open', async () => {
    render(() => <Harness />)
    const opener = screen.getByText('Open')
    opener.focus()
    fireEvent.click(opener)
    const dialog = await screen.findByRole('dialog')
    await waitFor(() => expect(dialog.contains(document.activeElement)).toBe(true))
  })

  it('traps focus: Tab from the last control wraps to the first, and Shift+Tab stays inside', async () => {
    render(() => <Harness />)
    fireEvent.click(screen.getByText('Open'))
    const dialog = await screen.findByRole('dialog')
    // The first and last tabbable controls in reading order: the close button and Save.
    const first = screen.getByRole('button', { name: 'Close dialog' })
    const last = screen.getByRole('button', { name: 'Save' })
    last.focus()
    fireEvent.keyDown(last, { key: 'Tab' })
    await waitFor(() => expect(document.activeElement).toBe(first))
    // Shift+Tab off the first control must not leave the dialog either.
    fireEvent.keyDown(first, { key: 'Tab', shiftKey: true })
    await waitFor(() => expect(dialog.contains(document.activeElement)).toBe(true))
    // Never out to the page behind it.
    expect(dialog.contains(document.activeElement)).toBe(true)
  })

  it('closes on Escape and on its close button, naming the button as asked', async () => {
    const onClose = vi.fn()
    render(() => <Harness onClose={onClose} />)
    fireEvent.click(screen.getByText('Open'))
    const dialog = await screen.findByRole('dialog')
    fireEvent.keyDown(dialog, { key: 'Escape' })
    await waitFor(() => expect(onClose).toHaveBeenCalledWith(false))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())

    fireEvent.click(screen.getByText('Open'))
    fireEvent.click(await screen.findByRole('button', { name: 'Close dialog' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  })
})

describe('Toast and notify', () => {
  // The toaster is global; a toast from one test must not be on screen in the next.
  beforeEach(() => dismissAllToasts())

  it('shows each kind, announcing errors assertively and letting only errors be closed', async () => {
    render(() => <ToastRegion label="Notifications" />)
    notify.success('Saved it')
    notify.error('Broke it')
    expect(await screen.findByText('Saved it')).toBeTruthy()
    expect(await screen.findByText('Broke it')).toBeTruthy()
    const error = screen.getByText('Broke it').closest('[role]')!
    expect(error.getAttribute('role')).toBe('alert')
    expect(screen.getByText('Saved it').closest('[role]')!.getAttribute('role')).toBe('status')
    // One close button, on the error.
    expect(screen.getAllByRole('button', { name: 'Close' })).toHaveLength(1)
  })

  it('dismisses an error when its close button is pressed', async () => {
    render(() => <ToastRegion />)
    notify.error('Dismiss me')
    await screen.findByText('Dismiss me')
    fireEvent.click(screen.getByRole('button', { name: 'Close' }))
    await waitFor(() => expect(screen.queryByText('Dismiss me')).toBeNull())
  })
})
