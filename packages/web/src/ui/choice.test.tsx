import { fireEvent, render, screen } from '@solidjs/testing-library'
import { createSignal } from 'solid-js'
import { describe, expect, it, vi } from 'vitest'
import { ChoiceList } from './choice'

const OPTIONS = [
  { value: 'a', label: 'Install A', detail: '1.0', code: 'C:\\a\\a.exe' },
  { value: 'b', label: 'Install B', detail: '2.0', code: 'C:\\b\\b.exe', badge: <b>Gone</b> },
]

const radios = () => screen.getAllByRole('radio') as HTMLInputElement[]

describe('ChoiceList', () => {
  it('is a named radio group with a row per option and nothing chosen for the user', () => {
    render(() => (
      <ChoiceList label="Which install" value={null} options={OPTIONS} onChange={() => {}} />
    ))

    expect(screen.getByRole('radiogroup', { name: 'Which install' })).toBeTruthy()
    expect(radios().map((radio) => radio.checked)).toEqual([false, false])
    // Each row says everything that tells it apart, and its badge and action sit beside it.
    expect(screen.getByText('C:\\b\\b.exe')).toBeTruthy()
    expect(screen.getByText('2.0')).toBeTruthy()
    expect(screen.getByText('Gone')).toBeTruthy()
  })

  it('asks for the option that was clicked', () => {
    const onChange = vi.fn()
    render(() => <ChoiceList label="x" value="a" options={OPTIONS} onChange={onChange} />)

    fireEvent.click(radios()[1]!)

    expect(onChange).toHaveBeenCalledWith('b')
  })

  it('goes back to the value when the request is refused', () => {
    render(() => <ChoiceList label="x" value="a" options={OPTIONS} onChange={() => {}} />)

    fireEvent.click(radios()[1]!)

    // A control showing a state the app does not have would be a lie.
    expect(radios().map((radio) => radio.checked)).toEqual([true, false])
  })

  it('stays on the new option when the request is granted', () => {
    const [value, setValue] = createSignal<string | null>('a')
    render(() => <ChoiceList label="x" value={value()} options={OPTIONS} onChange={setValue} />)

    fireEvent.click(radios()[1]!)

    expect(value()).toBe('b')
    expect(radios().map((radio) => radio.checked)).toEqual([false, true])
  })

  it('cannot be changed while disabled', () => {
    render(() => <ChoiceList label="x" value="a" options={OPTIONS} onChange={() => {}} disabled />)

    expect(radios().every((radio) => radio.disabled)).toBe(true)
  })

  it('keeps an action of a row out of the choice', () => {
    const onChange = vi.fn()
    const remove = vi.fn()
    render(() => (
      <ChoiceList
        label="x"
        value="a"
        onChange={onChange}
        options={[{ value: 'a', label: 'A', action: <button onClick={remove}>Remove A</button> }]}
      />
    ))

    fireEvent.click(screen.getByRole('button', { name: 'Remove A' }))

    expect(remove).toHaveBeenCalledOnce()
    expect(onChange).not.toHaveBeenCalled()
  })
})
