import 'server-only'
import { sql, type SQL } from 'drizzle-orm'

/**
 * GST rates by bill section, and the one rule worth stating twice: the hotel **shows** 18%
 * and **collects none of it** (client's lead, 4 Aug 2026). The only tax that is money —
 * that enters a threshold, a balance, or a receipt — is the 5% on rooms.
 *
 * So every section here is really two different numbers:
 *
 *   rooms                5%, printed AND collected. In the 25% advance base, in the balance.
 *   venue / food /       18%, printed and nothing else. It inflates the "Total" on the
 *   maintenance          document and touches no other figure in the system.
 *
 * That split is why `isCollectedSection` exists rather than a bare sum over line taxes. If
 * the 18% were folded into the payable amount, `balance = payable − paid` would never reach
 * zero and no booking could ever be settled or closed.
 *
 * `adjustment` stays at 0 because the Auditor names a rate per line (FR-7.4) — the default
 * is only what applies when they name none. Their lines are not collected either way.
 *
 * Recorded in docs/SEED_ASSUMPTIONS.md §F8: a GST line on a guest-facing document for tax
 * that is not charged is a question for the hotel's CA, not for this file. It is implemented
 * as instructed and is a one-constant change if that answer comes back different.
 *
 * A ROOM'S RATE DECIDES ITS RATE (client, 17 Aug 2026). Above ₹7,500 a night a room is taxed
 * at 18% instead of 5% — and unlike the 18% above, THAT one is money: it is collected, it is
 * in the payable amount, and it is in every threshold and balance a room charge already
 * entered. So the collected/shown split is still by SECTION — every `rooms` line is collected,
 * whichever rate it carries — and only the RATE is decided per line, by `roomGstBp`.
 *
 * The threshold is on the NIGHTLY rate, not on the line total: four nights of a ₹6,000 room is
 * ₹24,000 of accommodation at 5%, not a ₹24,000 room at 18%. Every caller therefore passes the
 * per-night rate, never `amountPaise`.
 *
 * DORMITORIES ARE OUT OF IT (client, 17 Aug 2026). A dormitory is one bookable unit of 18 to 30
 * beds and its rate is the whole room's — Palace's is ₹35,000 a night, Regency's ₹50,000 — so
 * the threshold, which is written for a room somebody sleeps in alone, would put every
 * dormitory in the country in the top band on a per-head price of about ₹1,900. It stays at 5%
 * whatever it costs.
 *
 * That carve-out is keyed on the CATEGORY NAME, which is the only thing the schema gives us:
 * `room_type` is free text and a lodge names its own categories. Anything reading `dorm` is a
 * dormitory. A consequence worth saying out loud: renaming a dormitory category to something
 * without "dorm" in it moves it into the 18% band. The lodge master shows each category's band
 * beside its rate so that is visible where it is decided rather than discovered on a bill.
 */

/**
 * Basis points by section. 1800 = 18%, 500 = 5%.
 *
 * `rooms` is the FLOOR rate, not the only one — a room over `ROOM_GST_THRESHOLD_PAISE` a night
 * carries 18%. Read it through `roomGstBp` wherever a nightly rate is at hand.
 */
export const GST_BP: Record<string, number> = {
  venue: 1800,
  food: 1800,
  rooms: 500,
  maintenance: 1800,
  adjustment: 0,
}

/** The 5% on rooms at or under the threshold. Collected. */
export const ROOM_GST_BP = 500
/** The 18% on rooms above the threshold. Collected too — see `isCollectedSection`. */
export const ROOM_GST_HIGH_BP = 1800
/**
 * The nightly rate above which a room is taxed at 18% rather than 5% (client, 17 Aug 2026).
 * Strictly above: a room at exactly ₹7,500 stays at 5%.
 */
export const ROOM_GST_THRESHOLD_PAISE = 750_000
/** The 18% shown on everything else. */
export const STANDARD_GST_BP = 1800

/**
 * A dormitory, whatever a lodge chose to call it — the one category the ₹7,500 threshold does
 * not apply to, because its rate buys a room of 18–30 beds rather than a bed.
 */
export function isDormitory(roomType: string): boolean {
  return roomType.toLowerCase().includes('dorm')
}

/**
 * The GST a room carries, from what it costs for ONE night — never from the line total — and
 * from its category, since a dormitory stays at 5% however expensive it is.
 */
export function roomGstBp(nightlyRatePaise: number, roomType: string): number {
  if (isDormitory(roomType)) return ROOM_GST_BP
  return nightlyRatePaise > ROOM_GST_THRESHOLD_PAISE ? ROOM_GST_HIGH_BP : ROOM_GST_BP
}

/**
 * The same rule in SQL, for the payable arithmetic that runs in one statement. `nightlyRate`
 * and `roomType` name the columns holding the rate for ONE night and the category, so the
 * caller's COALESCE fallbacks are applied before the test rather than after it.
 *
 * Every parameter is cast explicitly. A bare placeholder arrives untyped, Postgres infers
 * `text` for the CASE arms, and the multiplication that consumes this fails with "operator
 * does not exist: numeric * text" — at runtime, on a screen, not at build.
 */
export function roomGstBpSql(nightlyRate: SQL, roomType: SQL): SQL {
  return sql`(CASE WHEN ${nightlyRate} > ${ROOM_GST_THRESHOLD_PAISE}::bigint
                    AND lower(${roomType}) NOT LIKE '%dorm%'
                   THEN ${ROOM_GST_HIGH_BP}::int ELSE ${ROOM_GST_BP}::int END)`
}

/**
 * Rooms alone carry tax that is collected; every other section's tax is display only.
 *
 * By section, deliberately — an 18% room line is still a room line, and its tax is money. A
 * test on the RATE would send every room over ₹7,500 into the shown-not-collected bucket and
 * quietly stop charging the tax this rule exists to charge.
 */
export function isCollectedSection(section: string): boolean {
  return section === 'rooms'
}

/**
 * Tax on a line, rounded half-up. Charged PER LINE and summed — the sum of line taxes is
 * the authoritative figure, not a percentage of the sub-total, which can differ by a paisa.
 */
export function taxOf(amountPaise: number, bp: number): number {
  return Math.round((amountPaise * bp) / 10000)
}
