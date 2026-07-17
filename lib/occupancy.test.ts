import { describe, expect, it } from 'vitest'
import { crossesMidnight, nextDay, occupancyBounds, toMinutes } from './occupancy'

describe('crossesMidnight', () => {
  it('is false for a same-day window', () => {
    expect(crossesMidnight('10:00', '15:00')).toBe(false)
    expect(crossesMidnight('09:00', '23:59')).toBe(false)
  })
  it('is true when the end is at or before the start', () => {
    expect(crossesMidnight('20:00', '01:00')).toBe(true)
    expect(crossesMidnight('23:00', '00:30')).toBe(true)
    // Equal endpoints would be a zero-length same-day window; the DB CHECK forbids it,
    // but the roll-to-next-day interpretation is the safe one for the range maths.
    expect(crossesMidnight('12:00', '12:00')).toBe(true)
  })
})

describe('nextDay', () => {
  it('advances one calendar day, including across month ends', () => {
    expect(nextDay('2026-07-20')).toBe('2026-07-21')
    expect(nextDay('2026-07-31')).toBe('2026-08-01')
    expect(nextDay('2026-02-28')).toBe('2026-03-01') // 2026 is not a leap year
  })
})

describe('occupancyBounds', () => {
  it('keeps a same-day window on the same date', () => {
    expect(occupancyBounds('2026-07-20', '10:00', '15:00')).toEqual({
      lower: '2026-07-20 10:00',
      upper: '2026-07-20 15:00',
    })
  })
  it('rolls the end to the next day for a past-midnight window', () => {
    // Reception 20:00 → 01:00 occupies until 01:00 the following morning.
    expect(occupancyBounds('2026-07-21', '20:00', '01:00')).toEqual({
      lower: '2026-07-21 20:00',
      upper: '2026-07-22 01:00',
    })
  })
})

describe('toMinutes', () => {
  it('parses HH:MM and HH:MM:SS', () => {
    expect(toMinutes('00:00')).toBe(0)
    expect(toMinutes('10:30')).toBe(630)
    expect(toMinutes('23:59:59')).toBe(23 * 60 + 59)
  })
})
