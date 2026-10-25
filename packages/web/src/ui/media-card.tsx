import { A } from '@solidjs/router'
import { Show, type JSX } from 'solid-js'
import { Dynamic } from 'solid-js/web'
import { cx } from './cx'
import { ImageOff, type IconComponent } from './icons'

export type MediaCardLayout = 'grid' | 'list'

/**
 * The picture slot of a `MediaCard`: the image when there is one, otherwise a quiet placeholder
 * (an icon and a few words saying why there is no picture yet). Square, so a grid lines up.
 */
export function Thumb(props: {
  src?: string
  alt?: string
  placeholder?: JSX.Element
  placeholderIcon?: IconComponent
  class?: string
}) {
  return (
    <div
      class={cx(
        'flex aspect-square items-center justify-center overflow-hidden bg-surface-2',
        props.class,
      )}
    >
      <Show
        when={props.src}
        fallback={
          <div class="flex flex-col items-center gap-1 px-2 text-center text-xs text-fg-muted">
            <Dynamic
              component={props.placeholderIcon ?? ImageOff}
              class="size-5"
              aria-hidden="true"
            />
            <Show when={props.placeholder}>
              <span>{props.placeholder}</span>
            </Show>
          </div>
        }
      >
        <img
          src={props.src}
          alt={props.alt ?? ''}
          loading="lazy"
          width="256"
          height="256"
          class="size-full object-contain"
        />
      </Show>
    </div>
  )
}

/**
 * One item of a library: a project, or a file inside one. A picture, a title, a line of meta, a
 * row of badges or tags and, on the right or underneath, actions.
 *
 * With `href` the whole card is one link (the title carries it and stretches over the card, so the
 * card has a single link in the accessibility tree and a large target for a thumb); the actions
 * sit above that stretched area and stay independently clickable. Without `href` the card is not a
 * link at all. `layout` is the grid tile or the list row: the same content, arranged either way.
 */
export function MediaCard(props: {
  layout?: MediaCardLayout
  href?: string
  title: string
  as?: 'h2' | 'h3'
  image?: string
  imageAlt?: string
  placeholder?: JSX.Element
  placeholderIcon?: IconComponent
  meta?: JSX.Element
  badges?: JSX.Element
  actions?: JSX.Element
  class?: string
}) {
  const list = () => props.layout === 'list'
  return (
    <div
      class={cx(
        'relative flex h-full rounded-card border border-border bg-surface text-fg shadow-card transition-colors hover:border-border-input',
        list() ? 'flex-row items-center gap-3 p-2' : 'flex-col overflow-hidden',
        props.class,
      )}
    >
      <Thumb
        src={props.image}
        alt={props.imageAlt ?? ''}
        placeholder={props.placeholder}
        placeholderIcon={props.placeholderIcon}
        class={cx(list() ? 'size-16 shrink-0 rounded-control' : 'w-full border-b border-border')}
      />
      <div class={cx('flex min-w-0 flex-col gap-1.5', list() ? 'flex-1 py-0.5' : 'p-3')}>
        <Dynamic
          component={props.as ?? 'h2'}
          class="truncate text-sm font-semibold tracking-tight text-fg"
          title={props.title}
        >
          <Show when={props.href} fallback={props.title}>
            <A
              href={props.href!}
              class="rounded-xs outline-offset-4 after:absolute after:inset-0 after:content-['']"
            >
              {props.title}
            </A>
          </Show>
        </Dynamic>
        <Show when={props.meta}>
          <div class="text-xs text-fg-muted">{props.meta}</div>
        </Show>
        <Show when={props.badges}>
          <div class="flex flex-wrap items-center gap-1">{props.badges}</div>
        </Show>
      </div>
      <Show when={props.actions}>
        <div
          class={cx(
            'relative z-10 flex items-center gap-1',
            list() ? 'shrink-0 pr-1' : 'justify-end px-2 pb-2',
          )}
        >
          {props.actions}
        </div>
      </Show>
    </div>
  )
}
