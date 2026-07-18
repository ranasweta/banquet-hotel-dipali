import { beforeEach, describe, expect, it } from 'vitest'
import { rateLimit, _resetRateLimit } from './rate-limit'

describe('rateLimit', () => {
  beforeEach(() => _resetRateLimit())

  it('allows up to the limit, then blocks with a retry-after', () => {
    for (let i = 0; i < 3; i++) expect(rateLimit('k', 3, 1000).allowed).toBe(true)
    const blocked = rateLimit('k', 3, 1000)
    expect(blocked.allowed).toBe(false)
    expect(blocked.retryAfterSec).toBeGreaterThan(0)
  })

  it('resets after the window elapses', () => {
    const t0 = 1_000_000
    for (let i = 0; i < 3; i++) rateLimit('k', 3, 1000, t0)
    expect(rateLimit('k', 3, 1000, t0).allowed).toBe(false)
    expect(rateLimit('k', 3, 1000, t0 + 1001).allowed).toBe(true) // fresh window
  })

  it('keys independently', () => {
    expect(rateLimit('a', 1, 1000).allowed).toBe(true)
    expect(rateLimit('a', 1, 1000).allowed).toBe(false)
    expect(rateLimit('b', 1, 1000).allowed).toBe(true) // different key unaffected
  })
})
