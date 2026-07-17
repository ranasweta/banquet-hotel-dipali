import 'server-only'
import { and, desc, eq, lte } from 'drizzle-orm'
import { db, schema } from '@/db/drizzle'

/** A db handle or a transaction handle — pricing reads must run inside the confirm tx. */
type Exec = Pick<typeof db, 'select'>
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
