import { splitProps, type ComponentProps } from 'solid-js'
import { cx } from './cx'

export type CardPadding = 'none' | 'md' | 'lg'

const paddings: Record<CardPadding, string> = {
  none: '',
  md: 'p-4',
  lg: 'p-6',
}

/** The one surface: 1px border, card radius, a hairline of shadow. */
export function Card(
  props: ComponentProps<'div'> & {
    padding?: CardPadding
    /** Lifts the border on hover, for a card that is itself a link target. */
    interactive?: boolean
  },
) {
  const [local, rest] = splitProps(props, ['padding', 'interactive', 'class'])
  return (
    <div
      {...rest}
      class={cx(
        'rounded-card border border-border bg-surface text-fg shadow-card',
        paddings[local.padding ?? 'md'],
        local.interactive && 'transition-colors hover:border-border-input',
        local.class,
      )}
    />
  )
}
