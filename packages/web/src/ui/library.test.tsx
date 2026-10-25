import { createMemoryHistory, MemoryRouter, Route } from '@solidjs/router'
import { fireEvent, render, screen } from '@solidjs/testing-library'
import { createSignal } from 'solid-js'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  Archive,
  ArchiveX,
  ArrowUpDown,
  DropZone,
  IconLinkButton,
  Layers,
  LinkButton,
  MediaCard,
  Progress,
  ScrollSentinel,
  SegmentedControl,
  Select,
  Stage,
  StatList,
  Thumb,
  ToggleIconButton,
} from '.'

/** Components that link need a router around them. */
function inRouter(ui: () => unknown) {
  const history = createMemoryHistory()
  history.set({ value: '/' })
  return render(() => (
    <MemoryRouter history={history}>
      <Route path="*" component={ui as never} />
    </MemoryRouter>
  ))
}

describe('Thumb', () => {
  it('shows the image when there is one, decoratively', () => {
    const { container } = render(() => <Thumb src="/t.png" />)
    const img = container.querySelector('img')!
    expect(img.getAttribute('src')).toBe('/t.png')
    expect(img.getAttribute('alt')).toBe('')
    expect(img.getAttribute('loading')).toBe('lazy')
  })

  it('says why there is no picture when there is none', () => {
    const { container } = render(() => <Thumb placeholder="Preview pending" />)
    expect(container.querySelector('img')).toBeNull()
    expect(screen.getByText('Preview pending')).toBeTruthy()
  })
})

describe('MediaCard', () => {
  it('is one link: the title carries it, so the card has a single link', async () => {
    inRouter(() => <MediaCard href="/projects/p1" title="Benchy" meta="3 files" />)
    const links = await screen.findAllByRole('link')
    expect(links).toHaveLength(1)
    expect(links[0]!.getAttribute('href')).toBe('/projects/p1')
    expect(links[0]!.textContent).toBe('Benchy')
    expect(screen.getByRole('heading', { name: 'Benchy' })).toBeTruthy()
  })

  it('is no link at all without an href, and the heading level is chosen', () => {
    render(() => <MediaCard title="part.stl" as="h3" />)
    expect(screen.queryByRole('link')).toBeNull()
    expect(screen.getByRole('heading', { level: 3, name: 'part.stl' })).toBeTruthy()
  })

  it('keeps actions out of the link and clickable', () => {
    const onClick = vi.fn()
    inRouter(() => (
      <MediaCard href="/p" title="x" actions={<button onClick={onClick}>Rename</button>} />
    ))
    const link = screen.getByRole('link')
    fireEvent.click(screen.getByRole('button', { name: 'Rename' }))
    expect(onClick).toHaveBeenCalledOnce()
    expect(link.contains(screen.getByRole('button', { name: 'Rename' }))).toBe(false)
  })

  it('arranges the same content as a tile or as a row', () => {
    const { container, unmount } = render(() => <MediaCard title="x" layout="list" />)
    expect(container.firstElementChild!.className).toContain('flex-row')
    unmount()
    const grid = render(() => <MediaCard title="x" layout="grid" />)
    expect(grid.container.firstElementChild!.className).toContain('flex-col')
  })

  it('offers the title as a tooltip, for a name that gets cut off', () => {
    render(() => <MediaCard title="A very long name" />)
    expect(screen.getByRole('heading').getAttribute('title')).toBe('A very long name')
  })

  it('shows badges and meta', () => {
    render(() => <MediaCard title="x" meta="2 files" badges={<span>Archived</span>} />)
    expect(screen.getByText('2 files')).toBeTruthy()
    expect(screen.getByText('Archived')).toBeTruthy()
  })
})

describe('DropZone', () => {
  const file = (name: string) => new File(['x'], name)

  it('reports the files chosen with the button', () => {
    const onFiles = vi.fn()
    const { container } = render(() => (
      <DropZone label="Drop here" buttonLabel="Choose" onFiles={onFiles} />
    ))
    const input = container.querySelector('input[type="file"]') as HTMLInputElement
    expect(input.multiple).toBe(true)
    fireEvent.change(input, { target: { files: [file('a.stl'), file('b.stl')] } })
    expect(onFiles).toHaveBeenCalledWith([
      expect.objectContaining({ name: 'a.stl' }),
      expect.objectContaining({ name: 'b.stl' }),
    ])
  })

  it('reports files dropped on it, and lights up while they are over it', () => {
    const onFiles = vi.fn()
    const { container } = render(() => (
      <DropZone label="Drop here" buttonLabel="Choose" onFiles={onFiles} />
    ))
    const zone = container.firstElementChild as HTMLElement
    const transfer = { types: ['Files'], files: [file('a.stl')] }
    fireEvent.dragOver(zone, { dataTransfer: transfer })
    expect(zone.className).toContain('border-accent')
    fireEvent.drop(zone, { dataTransfer: transfer })
    expect(onFiles).toHaveBeenCalledOnce()
    expect(zone.className).not.toContain('border-accent')
  })

  it('ignores a drag that carries no files, such as selected text', () => {
    const onFiles = vi.fn()
    const { container } = render(() => (
      <DropZone label="Drop here" buttonLabel="Choose" onFiles={onFiles} />
    ))
    const zone = container.firstElementChild as HTMLElement
    const transfer = { types: ['text/plain'], files: [] }
    fireEvent.dragOver(zone, { dataTransfer: transfer })
    fireEvent.drop(zone, { dataTransfer: transfer })
    expect(zone.className).not.toContain('border-accent')
    expect(onFiles).not.toHaveBeenCalled()
  })

  it('takes only the first file when it is not multiple', () => {
    const onFiles = vi.fn()
    const { container } = render(() => (
      <DropZone label="Drop" buttonLabel="Choose" multiple={false} onFiles={onFiles} />
    ))
    fireEvent.drop(container.firstElementChild!, {
      dataTransfer: { types: ['Files'], files: [file('a.zip'), file('b.zip')] },
    })
    expect(onFiles).toHaveBeenCalledWith([expect.objectContaining({ name: 'a.zip' })])
  })

  it('does nothing when disabled', () => {
    const onFiles = vi.fn()
    const { container } = render(() => (
      <DropZone label="Drop" buttonLabel="Choose" disabled onFiles={onFiles} />
    ))
    fireEvent.drop(container.firstElementChild!, {
      dataTransfer: { types: ['Files'], files: [file('a.stl')] },
    })
    expect(onFiles).not.toHaveBeenCalled()
    expect((screen.getByRole('button', { name: 'Choose' }) as HTMLButtonElement).disabled).toBe(
      true,
    )
  })
})

describe('Progress', () => {
  it('is a named progress bar with its value', () => {
    render(() => <Progress label="Uploading a.stl" value={0.426} />)
    const bar = screen.getByRole('progressbar', { name: 'Uploading a.stl' })
    expect(bar.getAttribute('aria-valuenow')).toBe('43')
    expect(bar.getAttribute('aria-valuemax')).toBe('100')
  })

  it('has no value while the size is unknown, and clamps one that overshoots', () => {
    const { unmount } = render(() => <Progress label="Waiting" />)
    expect(screen.getByRole('progressbar').hasAttribute('aria-valuenow')).toBe(false)
    unmount()
    render(() => <Progress label="Over" value={3} />)
    expect(screen.getByRole('progressbar').getAttribute('aria-valuenow')).toBe('100')
  })
})

describe('ScrollSentinel', () => {
  type Callback = (entries: { isIntersecting: boolean }[]) => void
  let callback: Callback = () => {}
  const observe = vi.fn()
  const unobserve = vi.fn()
  const disconnect = vi.fn()
  let options: IntersectionObserverInit | undefined

  beforeEach(() => {
    observe.mockClear()
    unobserve.mockClear()
    disconnect.mockClear()
    vi.stubGlobal(
      'IntersectionObserver',
      class {
        constructor(cb: Callback, init?: IntersectionObserverInit) {
          callback = cb
          options = init
        }
        observe = observe
        unobserve = unobserve
        disconnect = disconnect
      },
    )
  })
  afterEach(() => vi.unstubAllGlobals())

  it('reports when the marker comes into view, and starts early', () => {
    const onReach = vi.fn()
    render(() => <ScrollSentinel onReach={onReach} />)
    expect(observe).toHaveBeenCalledOnce()
    expect(options?.rootMargin).toContain('400px')
    callback([{ isIntersecting: false }])
    expect(onReach).not.toHaveBeenCalled()
    callback([{ isIntersecting: true }])
    expect(onReach).toHaveBeenCalledOnce()
  })

  it('stays quiet while disabled', () => {
    const onReach = vi.fn()
    render(() => <ScrollSentinel onReach={onReach} disabled />)
    callback([{ isIntersecting: true }])
    expect(onReach).not.toHaveBeenCalled()
  })

  // An observer only fires when visibility changes, so a short page that leaves the marker on
  // screen would never fire again without being re-observed.
  it('looks again when the list grows', () => {
    const [count, setCount] = createSignal(48)
    render(() => <ScrollSentinel onReach={() => {}} rearmKey={count()} />)
    const before = observe.mock.calls.length
    setCount(96)
    expect(unobserve).toHaveBeenCalled()
    expect(observe.mock.calls.length).toBe(before + 1)
  })

  it('lets go of the observer when it goes away, and copes with no IntersectionObserver', () => {
    const { unmount } = render(() => <ScrollSentinel onReach={() => {}} />)
    unmount()
    expect(disconnect).toHaveBeenCalled()
    vi.stubGlobal('IntersectionObserver', undefined)
    expect(() => render(() => <ScrollSentinel onReach={() => {}} />)).not.toThrow()
  })
})

describe('ToggleIconButton', () => {
  it('is one control with one name, and aria-pressed says which state it is in', () => {
    const [pressed, setPressed] = createSignal(false)
    render(() => (
      <ToggleIconButton
        label="Show archived"
        pressed={pressed()}
        onPressedChange={setPressed}
        iconOn={Archive}
        iconOff={ArchiveX}
      />
    ))
    const button = screen.getByRole('button', { name: 'Show archived' })
    expect(button.getAttribute('aria-pressed')).toBe('false')
    fireEvent.click(button)
    expect(pressed()).toBe(true)
    // Same name after the press: it does not flip into "Hide archived".
    const after = screen.getByRole('button', { name: 'Show archived' })
    expect(after.getAttribute('aria-pressed')).toBe('true')
    fireEvent.click(after)
    expect(pressed()).toBe(false)
  })

  it('swaps the icon with the state', () => {
    const [pressed, setPressed] = createSignal(false)
    const { container } = render(() => (
      <ToggleIconButton
        label="Show archived"
        pressed={pressed()}
        onPressedChange={setPressed}
        iconOn={Archive}
        iconOff={ArchiveX}
      />
    ))
    const before = container.querySelector('svg')!.innerHTML
    setPressed(true)
    expect(container.querySelector('svg')!.innerHTML).not.toBe(before)
  })
})

describe('IconLinkButton and LinkButton', () => {
  it('is a router link with an accessible name', async () => {
    inRouter(() => <IconLinkButton href="/projects/p/view/f" icon={Layers} label="View in 3D" />)
    const link = await screen.findByRole('link', { name: 'View in 3D' })
    expect(link.getAttribute('href')).toBe('/projects/p/view/f')
  })

  it('is a plain, downloading anchor when external', () => {
    render(() => (
      <IconLinkButton
        href="/api/files/f/raw"
        icon={Layers}
        label="Download"
        external
        download="benchy.stl"
      />
    ))
    const link = screen.getByRole('link', { name: 'Download' })
    expect(link.getAttribute('download')).toBe('benchy.stl')
    expect(link.getAttribute('href')).toBe('/api/files/f/raw')
  })

  it('makes an external text link look like a button', () => {
    render(() => (
      <LinkButton href="/raw" external download="a.stl" icon={Layers}>
        Download
      </LinkButton>
    ))
    const link = screen.getByRole('link', { name: 'Download' })
    expect(link.getAttribute('download')).toBe('a.stl')
    expect(link.className).toContain('rounded-control')
  })
})

describe('Select with a leading icon', () => {
  it('draws the icon inside the control and makes room for it', () => {
    const { container } = render(() => (
      <Select
        aria-label="Sort by"
        leading={ArrowUpDown}
        value="a"
        onChange={() => {}}
        options={[{ value: 'a', label: 'Alpha' }]}
      />
    ))
    expect(container.querySelectorAll('svg').length).toBe(2)
    expect(screen.getByRole('combobox', { name: 'Sort by' }).className).toContain('pl-9')
  })
})

describe('SegmentedControl, icons only', () => {
  it('keeps the labels as names but hides them visually', () => {
    const onChange = vi.fn()
    render(() => (
      <SegmentedControl
        iconOnly
        label="Project view"
        value="grid"
        onChange={onChange}
        options={[
          { value: 'grid', label: 'Grid', icon: Layers },
          { value: 'list', label: 'List', icon: Layers },
        ]}
      />
    ))
    expect(screen.getByText('Grid').className).toContain('sr-only')
    fireEvent.click(screen.getByRole('radio', { name: 'List' }))
    expect(onChange).toHaveBeenCalledWith('list')
  })
})

describe('StatList and Stage', () => {
  it('lists labelled facts', () => {
    render(() => (
      <StatList
        items={[
          { label: 'Projects created', value: 3 },
          { label: 'Files added', value: 12 },
        ]}
      />
    ))
    expect(screen.getByText('Projects created').tagName).toBe('DT')
    expect(screen.getByText('12').tagName).toBe('DD')
  })

  it('hands its element to the viewer, and is a focusable named image only when asked', () => {
    let element: HTMLElement | undefined
    const { unmount } = render(() => (
      <Stage ref={(el) => (element = el)} focusable label="3D view of the model" />
    ))
    expect(element).toBeTruthy()
    expect(screen.getByRole('img', { name: '3D view of the model' }).getAttribute('tabindex')).toBe(
      '0',
    )
    unmount()
    render(() => <Stage label="3D view of the model" />)
    expect(screen.queryByRole('img')).toBeNull()
  })

  it('shows an overlay on top, and passes keys on', () => {
    const onKeyDown = vi.fn()
    render(() => (
      <Stage focusable label="view" overlay={<p>Loading the model</p>} onKeyDown={onKeyDown} />
    ))
    expect(screen.getByText('Loading the model')).toBeTruthy()
    fireEvent.keyDown(screen.getByRole('img'), { key: 'ArrowLeft' })
    expect(onKeyDown).toHaveBeenCalledOnce()
  })
})
