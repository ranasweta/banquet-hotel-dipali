/**
 * The one place 24-hour clock strings ('HH:MM' or 'HH:MM:SS', as stored) become the
 * 12-hour AM/PM text the app shows everywhere (client, 22 Jul 2026). Entry (TimePicker12)
 * and every display read the same maths, so they can never drift.
 */

/** '18:00' → '6 PM', '18:30' → '6:30 PM', '00:30' → '12:30 AM', '12:00' → '12 PM'. */
export function formatTime(hms: string): string {
  const [hStr, mStr] = (hms ?? '').split(':')
  let h = Number(hStr)
  const m = Number(mStr)
  if (Number.isNaN(h) || Number.isNaN(m)) return hms
  const ampm = h >= 12 ? 'PM' : 'AM'
  h = h % 12 || 12
  return m === 0 ? `${h} ${ampm}` : `${h}:${String(m).padStart(2, '0')} ${ampm}`
}

/** A window whose end ≤ start runs past midnight (schema BR-C1); flag it with +1. */
export function formatTimeRange(start: string, end: string): string {
  const overnight = end <= start
  return `${formatTime(start)} – ${formatTime(end)}${overnight ? ' +1' : ''}`
}

/**
 * Today as 'YYYY-MM-DD' in the hotel's timezone (IST). The single source for bounding a
 * "received on" date: money can't be recorded as received in the future (tester, 23 Jul 2026).
 * Fixing the zone to IST keeps the client `max` and the server check in agreement regardless
 * of where the browser is, and avoids the UTC off-by-one in the early-morning IST window.
 */
export function todayISO(timeZone = 'Asia/Kolkata'): string {
  return new Date().toLocaleDateString('en-CA', { timeZone })
}
