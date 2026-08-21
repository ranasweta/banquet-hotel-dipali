/**
 * Pure time-window maths for the venue clash model (BR-C1). No database, no server-only
 * boundary, so it is unit-testable and usable from plain scripts (e.g. the demo seed).
 *
 * A booking occupies the half-open range [date+start, end], where end rolls to the next
 * day when end_time is at or before start_time (a window running past midnight).
 */

export function toMinutes(t: string): number {
  const [h, m] = t.split(':').map(Number)
  return h * 60 + m
}

/** end <= start means the window runs into the next day (e.g. 20:00 → 01:00). */
export function crossesMidnight(startTime: string, endTime: string): boolean {
  return toMinutes(endTime) <= toMinutes(startTime)
}

export function nextDay(date: string): string {
  const [y, m, d] = date.split('-').map(Number)
  return new Date(Date.UTC(y, m - 1, d + 1)).toISOString().slice(0, 10)
}

export function prevDay(date: string): string {
  const [y, m, d] = date.split('-').map(Number)
  return new Date(Date.UTC(y, m - 1, d - 1)).toISOString().slice(0, 10)
}

/**
 * The [lower, upper) timestamp bounds a sub-event occupies, as 'YYYY-MM-DD HH:MM[:SS]'
 * strings. This is the single source of the occupancy maths: the read-side availability
 * check and the confirm-time insert (M3) must both build the stored range from here, or
 * the check and the write guard could disagree.
 */
export function occupancyBounds(
  date: string,
  startTime: string,
  endTime: string,
): { lower: string; upper: string } {
  const lower = `${date} ${startTime}`
  const upper = crossesMidnight(startTime, endTime)
    ? `${nextDay(date)} ${endTime}`
    : `${date} ${endTime}`
  return { lower, upper }
}

/**
 * The same bounds split into date and time parts. SQL must compose the timestamp as
 * `date::date + time::time` (never a combined 'date time' string param): postgres.js
 * shifts a combined-string param by the connection timezone, but a date + time pair
 * carries no timezone and is never converted. Both the write (confirm/demo) and the read
 * (availability) build the range this way so they can never disagree.
 */
export function occupancyParts(
  date: string,
  startTime: string,
  endTime: string,
): { lowerDate: string; lowerTime: string; upperDate: string; upperTime: string } {
  return {
    lowerDate: date,
    lowerTime: startTime,
    upperDate: crossesMidnight(startTime, endTime) ? nextDay(date) : date,
    upperTime: endTime,
  }
}
