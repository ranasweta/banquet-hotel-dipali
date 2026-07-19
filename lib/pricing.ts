import 'server-only'
import { and, desc, eq, lte, sql } from 'drizzle-orm'
import { db, schema } from '@/db/drizzle'

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
): Promise<{ foodPaise: number; addonPaise: number }> {
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

  return { foodPaise: food!.total, addonPaise: addon!.total }
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
  const { foodPaise, addonPaise } = await foodAndAddonTotal(eventId, exec2)
  const total = venue.totalPaise + foodPaise + addonPaise
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
