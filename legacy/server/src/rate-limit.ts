import { AppError } from '@spm/contract/errors.ts'

export type RateLimitRule = { limit: number; windowMs: number }

export type RateLimiter = {
  /**
   * Records one attempt against `key` under `rule`. Throws a `TooManyRequests` `AppError`
   * (with `details.retryAfterSeconds`) once the count in the current window exceeds the
   * limit; otherwise returns normally.
   */
  check(key: string, rule: RateLimitRule): void
  /**
   * Number of keys currently tracked. Test-facing only — production code has no reason to
   * read this; it exists so the size-bound test can assert eviction actually happens
   * without depending on wall-clock timing.
   */
  size(): number
}

type Bucket = {
  windowStart: number
  windowMs: number
  count: number
}

/**
 * Hard ceiling on tracked keys, independent of the sweep. An attacker rotating source
 * addresses faster than one per window can keep the map from ever emptying via sweeping
 * alone (every bucket is still "live" by definition — it was just created), so pruning
 * alone cannot bound memory against that pattern; only an absolute cap can. Tens of
 * thousands is comfortably above realistic legitimate traffic for a self-hosted, small-team
 * server, and each bucket is three numbers, so the cap costs low single-digit megabytes at
 * worst. Exported (along with `EVICTION_BATCH`) so the size-bound test can assert against
 * the real numbers instead of duplicating them as magic constants that could drift out of
 * sync.
 */
export const MAX_TRACKED_KEYS = 20_000

/**
 * Eviction only fires once the map has grown this far past the cap, and then trims all the
 * way back down to the cap in one pass — a hysteresis band, not a strict "never exceed the
 * cap by one." This is load-bearing, not cosmetic: trimming exactly one entry on every
 * single insert once at the cap (the first version of this fix) means the map does one
 * `delete` and one `set` on nearly every call forever. Measured directly against a bare
 * `Map` with no rate-limiting logic at all, that steady one-in-one-out churn degrades
 * non-linearly as the backing table accumulates tombstoned slots between compactions —
 * ~0.00024 ms/op at 20k operations rising to ~0.0058 ms/op at 80k, a >20x blowup from churn
 * alone, reproducing the same shape of regression this fix exists to close. Batching the
 * deletes into a periodic bulk pass (checked empirically up to 160k operations) keeps cost
 * flat because most calls do nothing but a size comparison; only 1 in `EVICTION_BATCH`
 * calls pays for a bounded, single pass.
 */
export const EVICTION_BATCH = 2_000

/**
 * A fixed-window, per-key request counter used to throttle the auth routes.
 *
 * Pruning strategy: two independent mechanisms, one for CPU, one for memory.
 *
 * 1. Time-amortized sweep. `check()` never starts a timer; instead it tracks the clock
 *    reading of the last sweep and only walks the map (deleting every bucket whose window
 *    has already ended) once a full `rule.windowMs` has passed since that sweep. This keeps
 *    per-request cost O(1) amortized instead of paying for an O(map size) scan on every
 *    call once the map crosses some threshold — the earlier, broken version of this file
 *    gated the sweep on size rather than time, which meant a flood of never-repeated keys
 *    (each one live, none prunable) kept the map above the gate and therefore paid for a
 *    full scan on every single subsequent request: O(n) work per request, O(n^2) total for
 *    n requests. A time gate sidesteps this because it doesn't care how big the map is,
 *    only how long it's been since the last look.
 *
 * 2. A hard cap (`MAX_TRACKED_KEYS`), checked after every new key is inserted. The sweep
 *    alone cannot bound memory against an attacker who mints a fresh key faster than the
 *    window expires — every one of those buckets is legitimately "live" (not yet prunable)
 *    at the moment it's created, so no amount of sweeping removes it early. See
 *    `EVICTION_BATCH` and `evictOverflow` below for why the actual trimming is batched
 *    rather than trimming exactly one entry per insert (batching is load-bearing, not an
 *    optimization: the naive one-at-a-time version reintroduces the same non-linear
 *    slowdown this fix exists to close, just from `Map` churn instead of from `sweep`).
 *
 * No timers, no `setInterval` — everything above runs synchronously inside `check()`, so an
 * idle limiter has zero pending work and `deno test`'s op sanitizer sees nothing to trip on.
 */
export function makeRateLimiter(now: () => number = Date.now): RateLimiter {
  const buckets = new Map<string, Bucket>()
  let lastSweepAt = -Infinity

  function sweep(currentTime: number, intervalMs: number): void {
    if (currentTime - lastSweepAt < intervalMs) return
    lastSweepAt = currentTime
    for (const [key, bucket] of buckets) {
      if (currentTime - bucket.windowStart >= bucket.windowMs) buckets.delete(key)
    }
  }

  function evictOverflow(): void {
    // Cheap on the common path: this comparison is the only cost paid by the ~
    // (EVICTION_BATCH - 1) out of every EVICTION_BATCH calls that don't trigger a trim.
    if (buckets.size <= MAX_TRACKED_KEYS + EVICTION_BATCH) return
    // Map iterates in insertion order, so the oldest-inserted (and, thanks to the
    // delete-then-set on rollover below, longest-untouched) keys come first. Evicting a
    // bucket that turns out to still be live hands that one key a fresh budget early — a
    // deliberate trade-off: under sustained attack this control degrades to "a few
    // attackers occasionally get extra attempts" rather than "the single-threaded server
    // stalls scanning its own state for everyone," which is the better failure mode here.
    let remaining = buckets.size - MAX_TRACKED_KEYS
    for (const key of buckets.keys()) {
      if (remaining <= 0) break
      buckets.delete(key)
      remaining--
    }
  }

  return {
    check(key, rule) {
      const currentTime = now()
      sweep(currentTime, rule.windowMs)

      const existing = buckets.get(key)
      let bucket: Bucket
      if (!existing || currentTime - existing.windowStart >= existing.windowMs) {
        bucket = { windowStart: currentTime, windowMs: rule.windowMs, count: 0 }
        // Delete-then-set (rather than a plain set over the existing key) moves this key
        // to the back of the Map's iteration order, so `evictOverflow` treats a freshly
        // rolled-over window as recently touched rather than as old as its first-ever hit.
        buckets.delete(key)
        buckets.set(key, bucket)
        evictOverflow()
      } else {
        bucket = existing
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
    size: () => buckets.size,
  }
}
