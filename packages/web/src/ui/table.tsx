import { splitProps, type ComponentProps } from 'solid-js'
import { cx } from './cx'

/** A table in a bordered, horizontally scrolling frame: on a phone the table scrolls, not the page. */
export function Table(props: ComponentProps<'table'>) {
  const [local, rest] = splitProps(props, ['class'])
  return (
    <div class="overflow-x-auto rounded-card border border-border bg-surface shadow-card">
      <table {...rest} class={cx('w-full border-collapse text-left text-sm', local.class)} />
    </div>
  )
}

export function Thead(props: ComponentProps<'thead'>) {
  const [local, rest] = splitProps(props, ['class'])
  return <thead {...rest} class={cx('bg-surface-2', local.class)} />
}

export function Tbody(props: ComponentProps<'tbody'>) {
  const [local, rest] = splitProps(props, ['class'])
  return <tbody {...rest} class={cx('divide-y divide-border', local.class)} />
}

export function Tr(props: ComponentProps<'tr'>) {
  const [local, rest] = splitProps(props, ['class'])
  return <tr {...rest} class={cx('transition-colors hover:bg-surface-2', local.class)} />
}

export function Th(props: ComponentProps<'th'>) {
  const [local, rest] = splitProps(props, ['class'])
  return (
    <th
      scope="col"
      {...rest}
      class={cx(
        'border-b border-border px-4 py-2.5 text-xs font-medium tracking-wide whitespace-nowrap text-fg-muted uppercase',
        local.class,
      )}
    />
  )
}

export function Td(props: ComponentProps<'td'>) {
  const [local, rest] = splitProps(props, ['class'])
  return <td {...rest} class={cx('px-4 py-3 align-middle text-fg', local.class)} />
}
