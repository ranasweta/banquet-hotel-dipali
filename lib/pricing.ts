import 'server-only'
import { and, desc, eq, lte, sql } from 'drizzle-orm'
import { db, schema } from '@/db/drizzle'
import { ROOM_GST_BP } from '@/lib/tax'

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
  rates: Map<string, number> // subEventId -> venue rate paise
  missing: { subEventId: string; name: string }[] // sub-events with no rate card (BR-R1)
}

/**
 * Prices every sub-event of an event from its rate card. `missing` lists any sub-event
 * that has no rate — the confirm transaction refuses while `missing` is non-empty.
 */
export async function priceProposal(
  eventType: string,
  subs: SubEventForPricing[],
  e?: Exec,
): Promise<ProposalPricing> {
  const rates = new Map<string, number>()
  const missing: { subEventId: string; name: string }[] = []
  let totalPaise = 0

  for (const sub of subs) {
    const rate = await venueRatePaise(
      { venueId: sub.venueId, bundleId: sub.bundleId },
      eventType,
      sub.eventDate,
      e,
    )
    if (rate == null) {
      missing.push({ subEventId: sub.id, name: sub.name })
    } else {
      rates.set(sub.id, rate)
      totalPaise += rate
    }
  }

  return { totalPaise, rates, missing }
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
 * count × nights × the cheapest active rack rate for that type, plus 5% tax.
 *
 * Two things to know about the rate. It is the chosen lodge's rate for that category —
 * Regency deluxe is Rs. 4,500 where Palace deluxe is Rs. 5,000, so the lodge matters. And the
 * tax is rounded PER LINE and summed, matching lib/invoice.ts, so the number quoted here and
 * the number on the Draft cannot differ by a rounding paisa.
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
           -- The proposal now names the lodge (21 Jul 2026), so price at THAT lodge's rate.
           -- The cheapest-across-lodges fallback only applies to rows captured before the
           -- proposal asked, where no unit is recorded and none may be invented.
           COALESCE(
             (SELECT min(r.rack_rate_paise) FROM rooms r
               WHERE r.room_type = rr.room_type AND r.is_active
                 AND (rr.unit_id IS NULL OR r.unit_id = rr.unit_id)),
             0
           )::bigint AS rate
    FROM room_requirements rr
    WHERE rr.event_id = ${eventId}
  `)) as unknown as { count: number; nights: number; rate: number }[]

  let roomsPaise = 0
  let roomsTaxPaise = 0
  for (const r of rows) {
    const amount = Number(r.rate) * Math.max(0, r.count) * Math.max(0, r.nights)
    roomsPaise += amount
    // 5%, and the only tax the hotel actually collects — the 18% added on 4 Aug 2026 is
    // printed on the document and enters no threshold, so it is absent here by design.
    roomsTaxPaise += Math.round((amount * ROOM_GST_BP) / 10000)
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
      venueId: schema.subEvents.venueId,
      bundleId: schema.subEvents.bundleId,
    })
    .from(schema.subEvents)
    .where(eq(schema.subEvents.eventId, eventId))
    .orderBy(schema.subEvents.eventDate, schema.subEvents.startTime)
}
