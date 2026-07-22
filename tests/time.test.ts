/**
 * Pure display maths for 12-hour AM/PM times (no database). Covers the edges that trip a
 * naïve h % 12: midnight (00 → 12 AM), noon (12 → 12 PM), and an overnight window.
 */
import { describe, expect, it } from 'vitest'
import { formatTime, formatTimeRange } from '@/lib/time'

describe('formatTime (12-hour AM/PM)', () => {
  it('handles midnight, noon and both sides of 12', () => {
    expect(formatTime('00:00')).toBe('12 AM')
    expect(formatTime('00:30')).toBe('12:30 AM')
    expect(formatTime('12:00')).toBe('12 PM')
    expect(formatTime('12:15')).toBe('12:15 PM')
    expect(formatTime('06:00')).toBe('6 AM')
    expect(formatTime('18:00')).toBe('6 PM')
    expect(formatTime('23:45')).toBe('11:45 PM')
    expect(formatTime('01:05')).toBe('1:05 AM')
  })

  it('reads seconds off an HH:MM:SS value and leaves junk untouched', () => {
    expect(formatTime('18:30:00')).toBe('6:30 PM')
    expect(formatTime('')).toBe('')
  })
})

describe('formatTimeRange', () => {
  it('shows a same-day window', () => {
    expect(formatTimeRange('18:00', '23:00')).toBe('6 PM – 11 PM')
  })

  it('flags an overnight PM → AM window with +1', () => {
    expect(formatTimeRange('20:00', '01:00')).toBe('8 PM – 1 AM +1')
  })
})
