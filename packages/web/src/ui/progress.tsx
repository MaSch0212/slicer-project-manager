import { cx } from './cx'

/**
 * A progress bar. `value` is 0 to 1; leave it out for an indeterminate bar (the size is not known
 * yet). `label` is the accessible name and is required: a bar with no name says nothing.
 */
export function Progress(props: { value?: number; label: string; class?: string }) {
  const percent = () =>
    props.value === undefined ? undefined : Math.round(Math.min(Math.max(props.value, 0), 1) * 100)
  return (
    <div
      role="progressbar"
      aria-label={props.label}
      aria-valuemin="0"
      aria-valuemax="100"
      aria-valuenow={percent()}
      class={cx('h-1.5 w-full overflow-hidden rounded-full bg-surface-3', props.class)}
    >
      <div
        class={cx(
          'h-full rounded-full bg-accent-solid transition-[width]',
          percent() === undefined && 'w-1/3 animate-shimmer',
        )}
        style={percent() === undefined ? undefined : { width: `${percent()}%` }}
      />
    </div>
  )
}
