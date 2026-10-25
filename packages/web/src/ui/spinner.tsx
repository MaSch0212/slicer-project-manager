import { cx } from './cx'

export type SpinnerSize = 'sm' | 'md' | 'lg'

const sizes: Record<SpinnerSize, string> = {
  sm: 'size-4',
  md: 'size-5',
  lg: 'size-8',
}

/**
 * An indeterminate spinner in the current text colour. Give it a `label` to announce it as a
 * status; without one it is decoration (inside a loading button, whose own state says it).
 */
export function Spinner(props: { size?: SpinnerSize; label?: string; class?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="3"
      stroke-linecap="round"
      class={cx('animate-spin', sizes[props.size ?? 'md'], props.class)}
      role={props.label ? 'status' : undefined}
      aria-label={props.label}
      aria-hidden={props.label ? undefined : 'true'}
    >
      <circle cx="12" cy="12" r="9" stroke-opacity="0.25" />
      <path d="M21 12a9 9 0 0 0-9-9" />
    </svg>
  )
}
