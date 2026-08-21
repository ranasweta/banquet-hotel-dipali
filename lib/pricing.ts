import 'server-only'
import { and, desc, eq, lte, sql, type SQL } from 'drizzle-orm'
import { db, schema } from '@/db/drizzle'
import { crossesMidnight, prevDay, toMinutes } from '@/lib/occupancy'
import { roomGstBp, taxOf } from '@/lib/tax'

/** A db handle or a transaction handle — pricing reads must run inside the confirm tx. */
type Exec = Pick<typeof db, 'select' | 'execute'>
const exec = (e?: Exec): Exec => e ?? db

/**
 * Proposal pricing. A venue's charge comes from its rate card for the event type,
 * effective on the sub-event's date. A venue+event-type with NO rate card is a gate, not
 * a zero (BR-R1): confirmation is blocked until an Authority-approved manual rate exists.
 *
 * At M3 the proposal total is the sum of venue charges across sub-events. Food (M4) and
 * rooms (M5) refine it later; menus are not a booking gate (FR-3.2).
 */

export type SubEventForPricing = {
  id: string
  name: string
  eventDate: string
  /** Both needed to place the function in a venue-day — see `venueDayOf`, which reads the end. */
  startTime: string
  endTime: string
  venueId: string | null
  bundleId: string | null
}

/** The rate card rate for a venue/bundle + event type effective on `date`, or null (gate). */
export async function venueRatePaise(
  target: { venueId: string | null; bundleId: string | null },
  eventType: string,
  date: string,
  e?: Exec,
): Promise<number | null> {
  const targetMatch = target.bundleId
    ? eq(schema.venueRateCards.bundleId, target.bundleId)
    : eq(schema.venueRateCards.venueId, target.venueId!)

  const [row] = await exec(e)
    .select({ rate: schema.venueRateCards.ratePaise })
    .from(schema.venueRateCards)
    .where(
      and(
        targetMatch,
        eq(schema.venueRateCards.eventType, eventType),
        lte(schema.venueRateCards.effectiveFrom, date),
      ),
    )
    .orderBy(desc(schema.venueRateCards.effectiveFrom))
    .limit(1)

  return row?.rate ?? null
}

export type ProposalPricing = {
  totalPaise: number
  /**
   * subEventId -> the venue charge carried BY THAT sub-event. Zero for a function whose
   * venue-day is already paid for by an earlier one (see `coveredBy`).
   */
  rates: Map<string, number>
  missing: { subEventId: string; name: string }[] // sub-events with no rate card (BR-R1)
  /** subEventId -> the sub-event whose day-hire covers it. Same venue, same date. */
  coveredBy: Map<string, string>
}

/**
 * The hour a venue-day turns over: check-out 07:59, check-in 08:00, with no gap between them
 * (client, 12 Aug 2026; hours and rule confirmed 21 Aug).
 */
export const VENUE_DAY_CHANGEOVER = '08:00'

/**
 * The venue-day a function's charge belongs to.
 *
 * CHECKOUT DECIDES IT (client, 21 Aug 2026): "if checkout of event exceeds 8 AM then it will be
 * charged, that's it — hence a 7 to 10 AM event will be charged, and then any event from 10 AM
 * will not be charged if it's charged once."
 *
 * So a function that ENDS at or before 08:00 is the tail of the night before and costs nothing
 * extra; a function that ends after 08:00 has run into a new let and that let is charged, once,
 * however many functions follow it that day.
 *
 * It reads off the END time, not the start, and that is the whole rule — no special case for a
 * booking that opens early. A 6 AM–7 AM breakfast after a wedding is free because it is out by
 * 7; a 7 AM–10 AM engagement breakfast is charged because it is still in the hall at 10, and it
 * then carries the day for the lunch and the sangeet behind it.
 *
 * Keying on the START time, which this did first, got both of those wrong in opposite
 * directions: it made a 6 AM–10 AM breakfast free, and it pushed a 7 AM day-opener onto the
 * previous day where nothing was booked, splitting one hall-day into two hires.
 *
 * A function running PAST MIDNIGHT is charged on the day it started — 8 PM to 6 AM is one
 * function and one let, not the tail of the day before. `crossesMidnight` is what tells the two
 * apart: an 8 PM–6 AM function ends before it starts, a 6 AM–7 AM one does not.
 *
 * THE BOARD IS NOT AFFECTED. A function still draws on its own date and the occupancy range is
 * untouched, so BR-C1 refuses the same clashes it always did. Only the charge moves.
 */
function venueDayOf(sub: SubEventForPricing): string {
  if (crossesMidnight(sub.startTime, sub.endTime)) return sub.eventDate
  // Compared as MINUTES, never as strings: the database hands back '08:00:00', which sorts
  // after the literal '08:00' and would have left a checkout exactly on the hour paying for a
  // second let.
  return toMinutes(sub.endTime) <= toMinutes(VENUE_DAY_CHANGEOVER) ? prevDay(sub.eventDate) : sub.eventDate
}

/**
 * The same rule in SQL, for the three readers that group in one statement — lib/invoice.ts,
 * lib/proposal.ts and lib/payment-schedule.ts. Written once here because those three plus
 * `priceProposal` must agree on which functions share a let, and a fix in one is worth nothing
 * if another still charges the morning twice.
 */
export function venueDaySql(alias: string): SQL {
  // A LITERAL time, not a bound parameter: two callers use this expression in both DISTINCT ON
  // and ORDER BY, and Postgres requires those to match structurally. A parameter renders as $1
  // in one and $2 in the other, which it rejects. The constant is ours, not user input.
  //
  // `end_time > start_time` is "does not run past midnight" — an 8 PM to 6 AM function is
  // charged on the day it started, not treated as the tail of the day before.
  return sql.raw(`(${alias}.event_date - (CASE
    WHEN ${alias}.end_time > ${alias}.start_time
     AND ${alias}.end_time <= TIME '${VENUE_DAY_CHANGEOVER}'
    THEN 1 ELSE 0 END))`)
}

function venueDayKey(sub: SubEventForPricing): string {
  return `${sub.bundleId ?? sub.venueId ?? 'none'}|${venueDayOf(sub)}`
}

/**
 * Prices an event's venue hire. `missing` lists any sub-event that has no rate — the confirm
 * transaction refuses while `missing` is non-empty.
 *
 * **THE HALL IS CHARGED ONCE A DAY, NOT ONCE A FUNCTION** (client, 12 Aug 2026, after staff
 * hit it in the field). Three functions in the same hall on one day billed the hire three
 * times: the guest hired the room for the day and was charged for it thrice. The overlap rule
 * is untouched — the windows still may not collide (BR-C1) — but a booking that clears it
 * costs what one day costs.
 *
 * The EARLIEST function of a venue-day carries the charge, and the rest are `coveredBy` it.
 * That is a display decision as much as an arithmetic one: the money is the same whichever
 * function holds it, but a bill has to put the line somewhere a reader can find it, and "the
 * day's hire is quoted on the first function" is a rule staff can say out loud.
 */
export async function priceProposal(
  eventType: string,
  subs: SubEventForPricing[],
  e?: Exec,
): Promise<ProposalPricing> {
  const rates = new Map<string, number>()
  const missing: { subEventId: string; name: string }[] = []
  const coveredBy = new Map<string, string>()
  /** venue-day -> the sub-event already charged for it. */
  const charged = new Map<string, string>()
  let totalPaise = 0

  // `loadSubEventsForPricing` orders by (date, start time), so the first member of a group
  // reached here is the day's first function. The TOTAL does not depend on that order — one
  // rate per venue-day either way — only which function is shown carrying it.
  for (const sub of subs) {
    const key = venueDayKey(sub)
    const holder = charged.get(key)
    if (holder) {
      rates.set(sub.id, 0)
      coveredBy.set(sub.id, holder)
      continue
    }

    const rate = await venueRatePaise(
      { venueId: sub.venueId, bundleId: sub.bundleId },
      eventType,
      sub.eventDate,
      e,
    )
    if (rate == null) {
      // No carrier is recorded, so a later function on the same venue-day is reported missing
      // too. Both are true and confirm is gated either way (BR-R1).
      missing.push({ subEventId: sub.id, name: sub.name })
    } else {
      charged.set(key, sub.id)
      rates.set(sub.id, rate)
      totalPaise += rate
    }
  }

  return { totalPaise, rates, missing, coveredBy }
}

/**
 * The food + add-on side of the proposal (M4). Food per sub-event is pax × per-plate rate,
 * where the per-plate rate is the snapshotted (base + wedding surcharge) on the saved menu —
 * never the master, so it survives menu-master edits (BR-M1) — plus any chef delicacy the Chef
 * has priced for that function, which is also charged per plate. Add-ons are qty × rate.
 * A sub-event with no saved menu contributes nothing (menus can be deferred; FR-3.2).
 */
export async function foodAndAddonTotal(
  eventId: string,
  e?: Exec,
): Promise<{ foodPaise: number; addonPaise: number; barPaise: number }> {
  const [food] = (await exec(e).execute(sql`
    SELECT COALESCE(sum(se.pax::bigint * (
             m.base_rate_paise + m.surcharge_paise
             + COALESCE((SELECT sum(c.charge_paise) FROM chef_requests c
                         WHERE c.sub_event_id = se.id AND c.status = 'priced'), 0)
           )), 0)::bigint AS total
    FROM sub_event_menus m
    JOIN sub_events se ON se.id = m.sub_event_id
    WHERE se.event_id = ${eventId}
  `)) as unknown as { total: number }[]

  const [addon] = (await exec(e).execute(sql`
    SELECT COALESCE(sum(a.qty::bigint * a.rate_paise), 0)::bigint AS total
    FROM sub_event_addons a
    JOIN sub_events se ON se.id = a.sub_event_id
    WHERE se.event_id = ${eventId}
  `)) as unknown as { total: number }[]

  // The bar (12 Aug 2026): bottles × the rate SNAPSHOTTED on the line, never bar_brands, so
  // re-pricing a brand tomorrow does not re-price a proposal quoted today. Kept as its own
  // figure rather than folded into add-ons — the arithmetic is the same, but "add-ons" would
  // stop meaning add-ons and every report reading it would quietly be wrong.
  const [bar] = (await exec(e).execute(sql`
    SELECT COALESCE(sum(b.bottles::bigint * b.rate_paise), 0)::bigint AS total
    FROM sub_event_bar_items b
    JOIN sub_events se ON se.id = b.sub_event_id
    WHERE se.event_id = ${eventId}
  `)) as unknown as { total: number }[]

  return { foodPaise: food!.total, addonPaise: addon!.total, barPaise: bar!.total }
}

/**
 * The promised-rooms estimate for an event: per `room_requirements` line,
 * count × nights × the cheapest active rack rate for that type, plus its room tax.
 *
 * Two things to know about the rate. It is the chosen lodge's rate for that category —
 * Regency deluxe is Rs. 4,500 where Palace deluxe is Rs. 5,000, so the lodge matters. And the
 * tax is rounded PER LINE and summed, matching lib/invoice.ts, so the number quoted here and
 * the number on the Draft cannot differ by a rounding paisa.
 *
 * The tax rate is the line's own: 5% at or under ₹7,500 a night, 18% above it (client, 17 Aug
 * 2026). Both are collected, so both belong in this figure and in the advance base it feeds.
 *
 * Kept separate from `proposal_total_paise` on purpose: that column feeds BR-D2's 10%
 * discount cap, and folding rooms into it would quietly raise the discount ceiling. Rooms
 * enter the 25% advance base (client, 20 Jul 2026) and nothing else — see SEED_ASSUMPTIONS §F10.
 */
export async function roomEstimatePaise(
  eventId: string,
  e?: Exec,
): Promise<{ roomsPaise: number; roomsTaxPaise: number }> {
  const rows = (await exec(e).execute(sql`
    SELECT rr.count::int AS count,
           (rr.check_out - rr.check_in)::int AS nights,
           -- The category decides whether the ₹7,500 threshold applies at all: a dormitory is
           -- one room of 18–30 beds and stays at 5% however much it costs (client, 17 Aug 2026).
           rr.room_type AS "roomType",
           -- The proposal now names the lodge (21 Jul 2026), so price at THAT lodge's rate.
           -- The cheapest-across-lodges fallback only applies to rows captured before the
           -- proposal asked, where no unit is recorded and none may be invented.
           -- The rate FROZEN AT CONFIRMATION wins (13 Aug 2026), so re-pricing a category in
           -- the lodge master never moves a booking that has already been promised one.
           -- NULL means the booking is still an enquiry, or predates the column: price live.
           COALESCE(
             rr.rate_paise,
             (SELECT min(r.rack_rate_paise) FROM rooms r
               WHERE r.room_type = rr.room_type AND r.is_active
                 AND (rr.unit_id IS NULL OR r.unit_id = rr.unit_id)),
             0
           )::bigint AS rate
    FROM room_requirements rr
    WHERE rr.event_id = ${eventId}
  `)) as unknown as { count: number; nights: number; rate: number; roomType: string }[]

  let roomsPaise = 0
  let roomsTaxPaise = 0
  for (const r of rows) {
    const amount = Number(r.rate) * Math.max(0, r.count) * Math.max(0, r.nights)
    roomsPaise += amount
    // The room's own rate, decided by what ONE night costs — not by the line total, or four
    // nights of a cheap room would tip itself into the higher band. Collected either way; the
    // 18% added on 4 Aug 2026 on everything BUT rooms enters no threshold and is absent here.
    roomsTaxPaise += taxOf(amount, roomGstBp(Number(r.rate), r.roomType))
  }
  return { roomsPaise, roomsTaxPaise }
}

/**
 * Recomputes and persists an event's running proposal total: priceable venue charges
 * (BR-R1 gaps are simply skipped from the running estimate — they become a hard gate only
 * at confirm) + food + add-ons. Called whenever a menu or add-on changes so the proposal
 * a booking manager sees stays current (schema note on proposal_total_paise). Returns the
 * new total.
 */
export async function recomputeProposalTotal(
  exec2: Exec & Pick<typeof db, 'update'>,
  eventId: string,
  eventType: string,
): Promise<number> {
  const subs = await loadSubEventsForPricing(eventId, exec2)
  const venue = await priceProposal(eventType, subs, exec2)
  const { foodPaise, addonPaise, barPaise } = await foodAndAddonTotal(eventId, exec2)
  const total = venue.totalPaise + foodPaise + addonPaise + barPaise
  await exec2
    .update(schema.events)
    .set({ proposalTotalPaise: total })
    .where(eq(schema.events.id, eventId))
  return total
}

/** Loads an event's sub-events in the shape priceProposal needs. */
export async function loadSubEventsForPricing(
  eventId: string,
  e?: Exec,
): Promise<SubEventForPricing[]> {
  return exec(e)
    .select({
      id: schema.subEvents.id,
      name: schema.subEvents.name,
      eventDate: schema.subEvents.eventDate,
      startTime: schema.subEvents.startTime,
      endTime: schema.subEvents.endTime,
      venueId: schema.subEvents.venueId,
      bundleId: schema.subEvents.bundleId,
    })
    .from(schema.subEvents)
    .where(eq(schema.subEvents.eventId, eventId))
    .orderBy(schema.subEvents.eventDate, schema.subEvents.startTime)
}
