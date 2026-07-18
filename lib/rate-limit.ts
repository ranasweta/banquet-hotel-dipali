import 'server-only'

/**
 * A small in-memory fixed-window rate limiter (M10 hardening, NFR-2-adjacent). Keyed by an
 * arbitrary string (e.g. IP + mobile) it caps attempts per window — enough to blunt
 * credential stuffing on the login route. In a multi-instance deployment this would move to
 * Redis; the interface stays the same. State is process-local and self-pruning.
 */

type Bucket = { count: number; resetAt: number }
const buckets = new Map<string, Bucket>()

export type RateResult = { allowed: boolean; remaining: number; retryAfterSec: number }

export function rateLimit(key: string, limit: number, windowMs: number, now: number = Date.now()): RateResult {
  // Opportunistic prune so the map can't grow unbounded.
  if (buckets.size > 5000) {
    for (const [k, b] of buckets) if (b.resetAt <= now) buckets.delete(k)
  }
  const b = buckets.get(key)
  if (!b || b.resetAt <= now) {
    buckets.set(key, { count: 1, resetAt: now + windowMs })
    return { allowed: true, remaining: limit - 1, retryAfterSec: 0 }
  }
  if (b.count >= limit) {
    return { allowed: false, remaining: 0, retryAfterSec: Math.ceil((b.resetAt - now) / 1000) }
  }
  b.count += 1
  return { allowed: true, remaining: limit - b.count, retryAfterSec: 0 }
}

/** Test-only: clear all buckets. */
export function _resetRateLimit(): void {
  buckets.clear()
}
