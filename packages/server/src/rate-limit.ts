import { AppError } from '@spm/contract/errors.ts'

export type RateLimitRule = { limit: number; windowMs: number }

export type RateLimiter = {
  /**
   * Records one attempt against `key` under `rule`. Throws a `TooManyRequests` `AppError`
   * (with `details.retryAfterSeconds`) once the count in the current window exceeds the
   * limit; otherwise returns normally.
   */
  check(key: string, rule: RateLimitRule): void
}

type Bucket = {
  windowStart: number
  windowMs: number
  count: number
}

/**
 * Once the map holds more entries than this, a `check()` call pays for a full sweep that
 * drops every bucket whose window has already elapsed. Buckets for keys an attacker never
 * revisits (e.g. a fresh source IP per request) are never touched by a normal read, so
 * without this sweep they would sit in the map forever — a memory leak with a hostile
 * author driving it. The threshold just controls how often we pay for the O(n) scan; it
 * does not affect correctness.
 */
const SWEEP_THRESHOLD = 1000

/**
 * A fixed-window, per-key request counter used to throttle the auth routes.
 *
 * Pruning strategy: sweep-on-write above a size threshold. `check()` never starts a timer;
 * instead, once the map grows past `SWEEP_THRESHOLD` entries it walks the whole map once
 * and deletes every bucket whose window has already ended relative to the current call's
 * clock reading. This terminates (it's a single bounded pass over a finite map) and it
 * bounds memory even against an attacker who rotates their source address on every request
 * and so never re-reads (and never opportunistically expires) any one bucket themselves:
 * every bucket's window is at most `rule.windowMs` wide, so any bucket older than that is
 * guaranteed to be swept away the next time the map crosses the threshold. Steady-state
 * size therefore settles around "distinct keys seen in the last window", not "distinct
 * keys seen ever" — it cannot grow monotonically with total request count.
 */
export function makeRateLimiter(now: () => number = Date.now): RateLimiter {
  const buckets = new Map<string, Bucket>()

  function sweep(currentTime: number): void {
    if (buckets.size <= SWEEP_THRESHOLD) return
    for (const [key, bucket] of buckets) {
      if (currentTime - bucket.windowStart >= bucket.windowMs) buckets.delete(key)
    }
  }

  return {
    check(key, rule) {
      const currentTime = now()
      sweep(currentTime)

      let bucket = buckets.get(key)
      if (!bucket || currentTime - bucket.windowStart >= bucket.windowMs) {
        bucket = { windowStart: currentTime, windowMs: rule.windowMs, count: 0 }
        buckets.set(key, bucket)
      }

      bucket.count++
      if (bucket.count > rule.limit) {
        const windowEnd = bucket.windowStart + bucket.windowMs
        const retryAfterSeconds = Math.max(0, Math.ceil((windowEnd - currentTime) / 1000))
        throw new AppError('TooManyRequests', 'too many requests, slow down', {
          retryAfterSeconds,
        })
      }
    },
  }
}
