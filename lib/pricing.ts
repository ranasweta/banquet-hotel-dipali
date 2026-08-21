import 'server-only'
import { and, desc, eq, lte, sql, type SQL } from 'drizzle-orm'
import { db, schema } from '@/db/drizzle'
import { prevDay } from '@/lib/occupancy'
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
  /** Needed to place the function in a venue-day: before 8 AM belongs to the day before. */
  startTime: string
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
 * The hour a venue-day turns over. A hire runs 9 AM to 8 AM the next morning (client, 12 Aug
 * 2026), so a function that STARTS before 8 AM is still inside the previous day's let — the
 * guest never gave the hall back.
 */
export const VENUE_DAY_START_TIME = '08:00'

/**
 * The venue-day a function's charge belongs to.
 *
 * THE EARLY-MORNING CASE (client, 21 Aug 2026). This used to key on the calendar date alone,
 * which charged a second full day's hire for a 6 AM breakfast served in the same hall the
 * wedding had run in until midnight. The hall was never released: the let that began at 9 AM
 * on the wedding day runs to 8 AM the next morning, and the breakfast is inside it.
 *
 * CLAUDE.md also said "a function is keyed to the day it STARTS on", and that is still true of
 * a single function running 8 PM to 6 AM — one function, one day. It was written to settle
 * which calendar square the board draws, and it quietly contradicted the 9-to-8 window for a
 * SEPARATE function starting between midnight and 8 AM. This is that contradiction resolved.
 *
 * The boundary is 8 AM exactly, on the client's instruction: before it, the previous day; at or
 * after it, its own day. The 8–9 AM hour therefore starts a fresh let, which is what a hall let
 * go at 8 and taken again at 9 actually is.
 *
 * THE BOARD IS NOT AFFECTED. The breakfast still draws on its own date and the occupancy range
 * is untouched, so BR-C1 refuses the same clashes it always did. Only the charge moves.
 */
function venueDayOf(sub: SubEventForPricing): string {
  return sub.startTime < VENUE_DAY_START_TIME ? prevDay(sub.eventDate) : sub.eventDate
}

/**
 * The same rule in SQL, for the three readers that group in one statement — lib/invoice.ts,
 * lib/proposal.ts and lib/payment-schedule.ts. Written once here because those three plus
 * `priceProposal` must agree on which functions share a let, and a fix in one is worth nothing
 * if another still charges the morning twice.
 */
export function venueDaySql(dateCol: string, startCol: string): SQL {
  // A LITERAL time, not a bound parameter: two of the three callers use this expression in both
  // DISTINCT ON and ORDER BY, and Postgres requires those to match structurally. A parameter
  // renders as $1 in one and $2 in the other, which it rejects. The constant is ours, not user
  // input, so interpolating it keeps one source of truth without opening anything up.
  return sql.raw(
    `(${dateCol} - (CASE WHEN ${startCol} < TIME '${VENUE_DAY_START_TIME}' THEN 1 ELSE 0 END))`,
  )
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
      venueId: schema.subEvents.venueId,
      bundleId: schema.subEvents.bundleId,
    })
    .from(schema.subEvents)
    .where(eq(schema.subEvents.eventId, eventId))
    .orderBy(schema.subEvents.eventDate, schema.subEvents.startTime)
}
