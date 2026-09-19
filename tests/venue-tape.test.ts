/**
 * The tape chart's day clipping (client, 19 Sep 2026).
 *
 * Pinned here because of a shipped defect: the endpoint serves a whole MONTH of occupancy so
 * the month grid can count it, and `spansFor` clipped every window it was handed to the day
 * being drawn — without first asking whether the window touched that day. Every booking in the
 * month was therefore painted on every date, and a hall with nothing booked read as taken while
 * the date above it said "All 16 free".
 *
 * No database: the defect was entirely in the clipping, so it is checked in a second here.
 */
import { describe, expect, it } from 'vitest'
import { freeWindows, spansFor } from '@/components/venue-tape-chart'

const w = (starts: string, ends: string) => ({ venueId: 'v1', starts, ends })

describe('spansFor', () => {
  it('ignores a window from another day in the same month', () => {
    expect(spansFor('2026-12-05', [w('2026-12-19T19:00', '2026-12-19T23:00')])).toEqual([])
  })

  it('clips a window to the day it is drawn on', () => {
    expect(spansFor('2026-12-05', [w('2026-12-05T12:00', '2026-12-05T18:00')])).toEqual([
      { from: 720, to: 1080, fromPrev: false, intoNext: false },
    ])
  })

  it('shows a window crossing midnight on both days it touches', () => {
    const overnight = [w('2026-09-20T23:00', '2026-09-21T17:00')]
    expect(spansFor('2026-09-20', overnight)).toEqual([
      { from: 1380, to: 1440, fromPrev: false, intoNext: true },
    ])
    expect(spansFor('2026-09-21', overnight)).toEqual([
      { from: 0, to: 1020, fromPrev: true, intoNext: false },
    ])
  })

  it('does not paint the next day for a window ending at midnight', () => {
    const toMidnight = [w('2026-12-05T19:00', '2026-12-06T00:00')]
    expect(spansFor('2026-12-05', toMidnight)).toHaveLength(1)
    expect(spansFor('2026-12-06', toMidnight)).toEqual([])
  })

  it('merges windows sharing a hall — the live counter beside its own function', () => {
    // BR-C1 as amended 13 Sep 2026: a `shares_venue` tier may overlap its own booking.
    const spans = spansFor('2026-12-05', [
      w('2026-12-05T09:00', '2026-12-05T23:00'),
      w('2026-12-05T19:00', '2026-12-05T23:00'),
    ])
    expect(spans).toEqual([{ from: 540, to: 1380, fromPrev: false, intoNext: false }])
  })
})

describe('freeWindows', () => {
  it('is the whole day when nothing is booked', () => {
    expect(freeWindows([])).toEqual([{ from: 0, to: 1440 }])
  })

  it('is the gaps around the booked windows', () => {
    const spans = spansFor('2026-12-05', [
      w('2026-12-05T12:00', '2026-12-05T17:00'),
      w('2026-12-05T19:00', '2026-12-05T23:00'),
    ])
    expect(freeWindows(spans)).toEqual([
      { from: 0, to: 720 },
      { from: 1020, to: 1140 },
      { from: 1380, to: 1440 },
    ])
  })

  it('is empty when a booking runs the whole day', () => {
    expect(freeWindows(spansFor('2026-09-21', [w('2026-09-20T23:00', '2026-09-22T09:00')]))).toEqual([])
  })
})
