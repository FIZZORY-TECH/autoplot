//! src-tauri/src/providers/rate_limit.rs — Per-provider token-bucket limiter.
//!
//! Every REST call from a provider adapter MUST pass through `acquire()` on the
//! relevant bucket before hitting the network. Buckets are refilled
//! continuously (token math, not a wall-clock tick) so short bursts up to
//! `capacity` are allowed, but the long-run rate cannot exceed `refill_per_sec`.
//!
//! Per-provider config (P4-15):
//!   - Binance:  1200 req/min  ≈ 20/s burst, 20/s sustained
//!   - Coinbase: 10 req/s public
//!   - Kraken:   1 req/s public
//!
//! The buckets are wrapped in `tokio::sync::Mutex` inside `RateLimiters`; the
//! mutex is contended only on `acquire()` and held only while we compute
//! tokens / sleep, so it does not pin one provider's progress to another.

use std::time::{Duration, Instant};
use tokio::sync::Mutex;
use tokio::time::sleep;

/// A continuous-refill token bucket.
///
/// Use `acquire()` from an async context immediately before any rate-limited
/// network call. `acquire()` returns once a token has been deducted; if no
/// token is available it sleeps for the precise amount of time required for
/// the next token to materialise.
#[derive(Debug)]
pub struct TokenBucket {
    /// Maximum tokens the bucket can hold (burst capacity).
    capacity: u32,
    /// Current tokens (fractional — refilled smoothly between calls).
    tokens: f64,
    /// Continuous refill rate, in tokens per second.
    refill_per_sec: f64,
    /// Last refill anchor — used to compute elapsed deltas.
    last: Instant,
}

impl TokenBucket {
    /// Construct a bucket with `capacity` burst tokens and `refill_per_sec`
    /// sustained throughput. Starts full so the first burst doesn't block.
    pub fn new(capacity: u32, refill_per_sec: f64) -> Self {
        debug_assert!(capacity > 0, "capacity must be positive");
        debug_assert!(refill_per_sec > 0.0, "refill_per_sec must be positive");
        Self {
            capacity,
            tokens: capacity as f64,
            refill_per_sec,
            last: Instant::now(),
        }
    }

    /// Binance public REST: 1200 req/min ≈ 20 req/s with 20-token burst.
    pub fn binance() -> Self {
        Self::new(20, 20.0)
    }

    /// Coinbase public REST: 10 req/s.
    pub fn coinbase() -> Self {
        Self::new(10, 10.0)
    }

    /// Kraken public REST: 1 req/s.
    pub fn kraken() -> Self {
        Self::new(1, 1.0)
    }

    /// Alpaca free tier: 200 req/min ≈ 3.33 req/s, burst 10.
    pub fn alpaca() -> Self {
        Self::new(10, 3.3)
    }

    /// Refill `tokens` according to wall-clock elapsed since `last`.
    /// Saturates at `capacity`.
    fn refill(&mut self) {
        let now = Instant::now();
        let elapsed = now.duration_since(self.last).as_secs_f64();
        if elapsed > 0.0 {
            let added = elapsed * self.refill_per_sec;
            self.tokens = (self.tokens + added).min(self.capacity as f64);
            self.last = now;
        }
    }

    /// Block (asynchronously) until a token is available, then consume one.
    ///
    /// If the bucket has at least 1 token, returns immediately. Otherwise,
    /// sleeps for the exact time needed for the next token to refill, then
    /// consumes it. Either way, exactly one token is deducted before return.
    pub async fn acquire(&mut self) {
        self.refill();
        if self.tokens >= 1.0 {
            self.tokens -= 1.0;
            return;
        }
        // Need exactly `1 - tokens` more tokens; at `refill_per_sec` tokens/s:
        let needed = 1.0 - self.tokens;
        let wait_secs = needed / self.refill_per_sec;
        // Add a 1ms safety margin so a small floating-point underflow doesn't
        // make us re-loop and sleep again.
        sleep(Duration::from_secs_f64(wait_secs) + Duration::from_millis(1)).await;
        self.refill();
        // After the precise sleep we should have ≥ 1 token; clamp defensively.
        if self.tokens >= 1.0 {
            self.tokens -= 1.0;
        } else {
            // Pathological scheduler-jitter case — just zero out and continue.
            self.tokens = 0.0;
        }
    }
}

/// Bundle of per-provider limiters held in Tauri-managed app state.
///
/// `Mutex` is `tokio::sync::Mutex` because `acquire()` may `.await` while
/// holding the lock (during the refill sleep). A `std::sync::Mutex` would
/// pin the entire async runtime task to that thread.
pub struct RateLimiters {
    pub binance: Mutex<TokenBucket>,
    pub coinbase: Mutex<TokenBucket>,
    pub kraken: Mutex<TokenBucket>,
    /// Alpaca free tier: 200 req/min ≈ 3.33/s, burst 10.
    pub alpaca: Mutex<TokenBucket>,
}

impl RateLimiters {
    /// Construct the production set with each provider's documented limit.
    pub fn new() -> Self {
        Self {
            binance: Mutex::new(TokenBucket::binance()),
            coinbase: Mutex::new(TokenBucket::coinbase()),
            kraken: Mutex::new(TokenBucket::kraken()),
            alpaca: Mutex::new(TokenBucket::alpaca()),
        }
    }

    /// Look up a bucket by provider id. Returns `None` for unknown ids so the
    /// caller can surface a typed error.
    pub fn for_provider(&self, provider: &str) -> Option<&Mutex<TokenBucket>> {
        match provider {
            "binance" => Some(&self.binance),
            "coinbase" => Some(&self.coinbase),
            "kraken" => Some(&self.kraken),
            "alpaca" => Some(&self.alpaca),
            _ => None,
        }
    }
}

impl Default for RateLimiters {
    fn default() -> Self {
        Self::new()
    }
}

// ---------------------------------------------------------------------------
// Unit tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Instant;

    /// Burst of `capacity` should be ~immediate; subsequent acquires should
    /// pace at `refill_per_sec`. We test 10 acquires against a 10/s bucket and
    /// expect roughly 1 second of total elapsed time. The threshold is wide
    /// (0.8s–1.5s) to absorb CI scheduler jitter.
    #[tokio::test]
    async fn coinbase_pace_holds_at_10_per_sec() {
        let mut b = TokenBucket::coinbase();
        let start = Instant::now();
        // First 10 are burst (capacity = 10), so they're free.
        for _ in 0..10 {
            b.acquire().await;
        }
        // Next 10 are paced at 10/s — should take ~1 second total.
        for _ in 0..10 {
            b.acquire().await;
        }
        let elapsed = start.elapsed();
        assert!(
            elapsed >= Duration::from_millis(800),
            "expected at least 800ms for 20 acquires (10 burst + 10 paced @10/s); got {:?}",
            elapsed
        );
        assert!(
            elapsed <= Duration::from_millis(1500),
            "expected at most 1500ms for 20 acquires (10 burst + 10 paced @10/s); got {:?}",
            elapsed
        );
    }

    /// Smaller bucket — Kraken is 1/s. 3 acquires after the initial burst
    /// should take ~3s; 3 + 1 acquires (4 total: 1 burst + 3 paced) too.
    #[tokio::test]
    async fn kraken_paces_at_1_per_sec() {
        let mut b = TokenBucket::kraken();
        let start = Instant::now();
        // 1 burst + 2 paced = ~2 seconds
        b.acquire().await; // immediate
        b.acquire().await; // ~+1s
        b.acquire().await; // ~+1s
        let elapsed = start.elapsed();
        assert!(
            elapsed >= Duration::from_millis(1700),
            "expected at least 1700ms for 3 acquires (1 burst + 2 paced @1/s); got {:?}",
            elapsed
        );
        assert!(
            elapsed <= Duration::from_millis(2500),
            "expected at most 2500ms; got {:?}",
            elapsed
        );
    }

    /// First `capacity` acquires must be fast (the burst).
    #[tokio::test]
    async fn burst_is_fast() {
        let mut b = TokenBucket::binance(); // capacity 20
        let start = Instant::now();
        for _ in 0..20 {
            b.acquire().await;
        }
        let elapsed = start.elapsed();
        assert!(
            elapsed < Duration::from_millis(200),
            "20 burst acquires should be near-immediate; got {:?}",
            elapsed
        );
    }

    /// `for_provider` returns `Some` for known providers and `None` otherwise.
    #[test]
    fn rate_limiters_lookup() {
        let limiters = RateLimiters::new();
        assert!(limiters.for_provider("binance").is_some());
        assert!(limiters.for_provider("coinbase").is_some());
        assert!(limiters.for_provider("kraken").is_some());
        assert!(limiters.for_provider("alpaca").is_some());
        assert!(limiters.for_provider("unknown").is_none());
    }
}
