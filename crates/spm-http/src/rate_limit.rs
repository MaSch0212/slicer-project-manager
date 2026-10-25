//! A fixed-window, per-key request counter that throttles the auth routes.
//!
//! **Keyed on the TCP peer address only.** The caller builds the key from the socket's peer
//! address and never from `X-Forwarded-For`: that header is set by the client, so trusting it
//! would let anyone mint an unlimited supply of fresh budgets by sending a different value per
//! request. A deployment behind a reverse proxy rate-limits on the proxy, which sees the real peer.
//!
//! Pruning has two independent mechanisms, one for CPU and one for memory:
//!
//! 1. A time-amortised sweep: `check` walks the map only once a full window has passed since the
//!    last walk, so per-request cost stays O(1) amortised however large the map is.
//! 2. A hard cap, [`MAX_TRACKED_KEYS`]. The sweep alone cannot bound memory against an attacker
//!    who mints keys faster than windows expire (every bucket is legitimately live when created),
//!    so only an absolute cap can. Eviction fires once the map is [`EVICTION_BATCH`] past the cap
//!    and trims back to the cap in one pass: a hysteresis band, so the common call pays one
//!    comparison and only one call in `EVICTION_BATCH` pays for a bounded pass.
//!
//! No timers: everything runs synchronously inside `check`, so an idle limiter has no pending
//! work.

use std::collections::{BTreeMap, HashMap};
use std::sync::{Mutex, PoisonError};

use serde_json::{Map, Value};
use spm_core::{AppError, AppErrorCode};

/// A budget: at most `limit` attempts per `window_ms`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct RateLimitRule {
    pub limit: u32,
    pub window_ms: i64,
}

/// Hard ceiling on tracked keys. Tens of thousands is far above realistic traffic for a
/// self-hosted, small-team server, and a bucket is a few numbers, so the cap costs low single-digit
/// megabytes at worst.
pub const MAX_TRACKED_KEYS: usize = 20_000;

/// How far past [`MAX_TRACKED_KEYS`] the map may grow before one pass trims it back.
pub const EVICTION_BATCH: usize = 2_000;

struct Bucket {
    window_start: i64,
    window_ms: i64,
    count: u32,
    /// Position in the insertion order; a rolled-over window takes a fresh one, so eviction
    /// treats it as recently touched rather than as old as its first-ever hit.
    seq: u64,
}

struct State {
    buckets: HashMap<String, Bucket>,
    order: BTreeMap<u64, String>,
    next_seq: u64,
    last_sweep_at: Option<i64>,
}

pub struct RateLimiter {
    state: Mutex<State>,
}

impl Default for RateLimiter {
    fn default() -> Self {
        RateLimiter::new()
    }
}

impl RateLimiter {
    pub fn new() -> RateLimiter {
        RateLimiter {
            state: Mutex::new(State {
                buckets: HashMap::new(),
                order: BTreeMap::new(),
                next_seq: 0,
                last_sweep_at: None,
            }),
        }
    }

    /// Records one attempt against `key` under `rule` at time `now` (epoch ms). Fails with a
    /// `TooManyRequests` carrying `details.retryAfterSeconds` once the count in the current window
    /// exceeds the limit.
    pub fn check(&self, key: &str, rule: RateLimitRule, now: i64) -> Result<(), AppError> {
        let mut state = self.state.lock().unwrap_or_else(PoisonError::into_inner);
        state.sweep(now, rule.window_ms);

        let live = state
            .buckets
            .get(key)
            .is_some_and(|bucket| now - bucket.window_start < bucket.window_ms);
        if !live {
            state.remove(key);
            let seq = state.next_seq;
            state.next_seq += 1;
            state.order.insert(seq, key.to_owned());
            state.buckets.insert(
                key.to_owned(),
                Bucket {
                    window_start: now,
                    window_ms: rule.window_ms,
                    count: 0,
                    seq,
                },
            );
            state.evict_overflow();
        }

        let bucket = state
            .buckets
            .get_mut(key)
            .expect("the bucket was just inserted or is live");
        bucket.count += 1;
        if bucket.count > rule.limit {
            let window_end = bucket.window_start + bucket.window_ms;
            let retry_after_seconds = ((window_end - now).max(0) + 999) / 1000;
            let mut details = Map::new();
            details.insert("retryAfterSeconds".into(), Value::from(retry_after_seconds));
            return Err(AppError::new(
                AppErrorCode::TooManyRequests,
                "too many requests, slow down",
            )
            .with_details(details));
        }
        Ok(())
    }

    /// Number of keys currently tracked. Test-facing: it lets the size-bound test assert that
    /// eviction happens without depending on wall-clock timing.
    pub fn size(&self) -> usize {
        self.state
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .buckets
            .len()
    }
}

impl State {
    fn remove(&mut self, key: &str) {
        if let Some(bucket) = self.buckets.remove(key) {
            self.order.remove(&bucket.seq);
        }
    }

    fn sweep(&mut self, now: i64, interval_ms: i64) {
        if self
            .last_sweep_at
            .is_some_and(|last| now - last < interval_ms)
        {
            return;
        }
        self.last_sweep_at = Some(now);
        let expired: Vec<String> = self
            .buckets
            .iter()
            .filter(|(_, bucket)| now - bucket.window_start >= bucket.window_ms)
            .map(|(key, _)| key.clone())
            .collect();
        for key in expired {
            self.remove(&key);
        }
    }

    fn evict_overflow(&mut self) {
        if self.buckets.len() <= MAX_TRACKED_KEYS + EVICTION_BATCH {
            return;
        }
        // Oldest insertion first. Evicting a bucket that is still live hands that one key a fresh
        // budget early: under sustained attack the control degrades to "a few attackers
        // occasionally get extra attempts" rather than "the server stalls scanning its own state".
        let mut remaining = self.buckets.len() - MAX_TRACKED_KEYS;
        while remaining > 0 {
            let Some((_, key)) = self.order.pop_first() else {
                break;
            };
            self.buckets.remove(&key);
            remaining -= 1;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const RULE: RateLimitRule = RateLimitRule {
        limit: 10,
        window_ms: 60_000,
    };

    #[test]
    fn the_eleventh_attempt_in_a_window_is_refused_with_a_retry_after() {
        let limiter = RateLimiter::new();
        for _ in 0..10 {
            limiter.check("a|POST /x", RULE, 0).unwrap();
        }
        let error = limiter.check("a|POST /x", RULE, 1_000).unwrap_err();
        assert_eq!(error.code, AppErrorCode::TooManyRequests);
        let retry = error.details.as_ref().unwrap()["retryAfterSeconds"]
            .as_i64()
            .unwrap();
        assert_eq!(retry, 59);
    }

    #[test]
    fn keys_do_not_share_a_budget() {
        let limiter = RateLimiter::new();
        for _ in 0..11 {
            let _ = limiter.check("a", RULE, 0);
        }
        assert!(limiter.check("a", RULE, 0).is_err());
        assert!(limiter.check("b", RULE, 0).is_ok());
    }

    #[test]
    fn the_window_expires() {
        let limiter = RateLimiter::new();
        for _ in 0..11 {
            let _ = limiter.check("a", RULE, 0);
        }
        assert!(limiter.check("a", RULE, 59_999).is_err());
        assert!(limiter.check("a", RULE, 60_000).is_ok());
    }

    #[test]
    fn the_tracked_key_count_stays_bounded_under_a_flood_of_distinct_keys() {
        let limiter = RateLimiter::new();
        // Roughly three times the cap, all inside one window, so nothing is prunable by the sweep:
        // an attacker rotating source addresses.
        let n = (MAX_TRACKED_KEYS + EVICTION_BATCH) * 3;
        for i in 0..n {
            let now = i as i64;
            let _ = limiter.check(&format!("10.0.0.{i}|POST /api/auth/login"), RULE, now);
        }
        assert!(
            limiter.size() <= MAX_TRACKED_KEYS + EVICTION_BATCH,
            "expected size() <= {}, got {}",
            MAX_TRACKED_KEYS + EVICTION_BATCH,
            limiter.size()
        );
        // And the bound is a real trim, not an accident of the test: the map did get big.
        assert!(limiter.size() > MAX_TRACKED_KEYS);
    }

    #[test]
    fn the_sweep_drops_buckets_whose_window_has_ended() {
        let limiter = RateLimiter::new();
        for i in 0..100 {
            limiter.check(&format!("k{i}"), RULE, 0).unwrap();
        }
        assert_eq!(limiter.size(), 100);
        limiter.check("late", RULE, 120_000).unwrap();
        assert_eq!(limiter.size(), 1);
    }
}
