import 'server-only'
import { eq, sql } from 'drizzle-orm'
import { db, schema } from '@/db/drizzle'
import { audit, type Actor } from '@/lib/audit'
import { badRequest, conflict, notFound, ApiError } from '@/lib/api'
import { occupancyParts } from '@/lib/occupancy'
import { foodAndAddonTotal, loadSubEventsForPricing, priceProposal } from '@/lib/pricing'

/**
 * Post-confirm editing by the top roles (tester, 23 Jul 2026). The Higher Authority and the
 * Auditor may edit a CONFIRMED booking through the wizard — including adding, removing and
 * moving functions — where everyone else is still sent to the change-request flow.
 *
 * A confirmed booking already holds its venue slots (venue_bookings), so every function change
 * here keeps those holds in step: an add inserts them, overlap-checked by the SAME GiST
 * exclusion that guards confirm (BR-C1); a remove drops them via ON DELETE CASCADE; and the
 * proposal total and derived dates are recomputed after either. Only `confirmed` is opened —
 * an in-progress/completed/locked event is not, and neither is any non-authority role.
 */
export const AUTHORITY_ROLES = new Set(['higher_authority', 'auditor'])
const EXCLUSION_VIOLATION = '23P01'

function pgCode(err: unknown): string | undefined {
  let cur: unknown = err
  for (let i = 0; i < 5 && cur && typeof cur === 'object'; i++) {
    if ('code' in cur && typeof (cur as { code: unknown }).code === 'string') {
      return (cur as { code: string }).code
    }
    cur = (cur as { cause?: unknown }).cause
  }
  return undefined
}

/** True when this actor may edit THIS event's functions directly — a confirmed booking, Authority. */
export function canAuthorityEditConfirmed(status: string, actor: Actor): boolean {
  return status === 'confirmed' && AUTHORITY_ROLES.has(actor.roleName)
}

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0]

/**
 * Recompute proposal_total_paise + first/last dates from the event's current sub-events.
 * Exported for lib/gm-authority.ts, whose edits move exactly the same figures.
 */
export async function recomputeProposal(tx: Tx, eventId: string, eventType: string): Promise<void> {
  const subs = await loadSubEventsForPricing(eventId, tx)
  const pricing = await priceProposal(eventType, subs, tx)
  const extras = await foodAndAddonTotal(eventId, tx)
  const total = pricing.totalPaise + extras.foodPaise + extras.addonPaise
  const dates = subs.map((s) => s.eventDate).sort()
  await tx
    .update(schema.events)
    .set({ proposalTotalPaise: total, firstDate: dates[0] ?? null, lastDate: dates[dates.length - 1] ?? null })
    .where(eq(schema.events.id, eventId))
}

export type ConfirmedFunctionInput = {
  name: string
  eventDate: string
  startTime: string
  endTime: string
  venueId?: string
  bundleId?: string
  pax: number
  paxOverrideNote?: string
}

/**
 * Adds a function to a CONFIRMED booking and blocks its venue window(s). Authority only.
 * Mirrors the confirm transaction's venue-hold logic, so the calendar can never drift.
 */
export async function addConfirmedFunction(
  actor: Actor,
  eventId: string,
  input: ConfirmedFunctionInput,
): Promise<{ id: string }> {
  try {
    return await db.transaction(async (tx) => {
      const [event] = await tx
        .select({ status: schema.events.status, eventType: schema.events.eventType })
        .from(schema.events)
        .where(eq(schema.events.id, eventId))
        .for('update')
        .limit(1)
      if (!event) throw notFound('Event not found')
      if (!canAuthorityEditConfirmed(event.status, actor)) {
        throw conflict('Only the Higher Authority or Auditor can add a function to a confirmed booking.')
      }

      const [sub] = await tx
        .insert(schema.subEvents)
        .values({
          eventId,
          name: input.name,
          eventDate: input.eventDate,
          startTime: input.startTime,
          endTime: input.endTime,
          venueId: input.venueId ?? null,
          bundleId: input.bundleId ?? null,
          pax: input.pax,
          paxOverrideNote: input.paxOverrideNote ?? null,
        })
        .returning({ id: schema.subEvents.id })

      // Price with the new function included; a venue with no rate card is a gate (BR-R1).
      const subs = await loadSubEventsForPricing(eventId, tx)
      const pricing = await priceProposal(event.eventType, subs, tx)
      if (pricing.missing.some((m) => m.subEventId === sub!.id)) {
        throw badRequest(
          'This venue has no rate card for the event type. An Authority-approved manual rate is needed first (BR-R1).',
        )
      }

      // Block the venue window(s). The exclusion constraint decides races, exactly as confirm.
      const { lowerDate, lowerTime, upperDate, upperTime } = occupancyParts(input.eventDate, input.startTime, input.endTime)
      const venueIds = input.bundleId
        ? (
            await tx
              .select({ venueId: schema.venueBundleMembers.venueId })
              .from(schema.venueBundleMembers)
              .where(eq(schema.venueBundleMembers.bundleId, input.bundleId))
          ).map((r) => r.venueId)
        : [input.venueId!]
      for (const venueId of venueIds) {
        await tx.execute(sql`
          INSERT INTO venue_bookings (venue_id, sub_event_id, event_id, occupancy)
          VALUES (${venueId}, ${sub!.id}, ${eventId},
                  tsrange((${lowerDate}::date + ${lowerTime}::time),
                          (${upperDate}::date + ${upperTime}::time), '[)'))
        `)
      }

      await tx.update(schema.subEvents).set({ venueRatePaise: pricing.rates.get(sub!.id) ?? 0 }).where(eq(schema.subEvents.id, sub!.id))
      await recomputeProposal(tx, eventId, event.eventType)
      await audit(tx, actor, {
        entity: 'sub_events',
        entityId: sub!.id,
        eventId,
        action: 'insert',
        field: 'name',
        newValue: `${input.name} (added post-confirm)`,
      })
      return { id: sub!.id }
    })
  } catch (err) {
    if (err instanceof ApiError) throw err
    if (pgCode(err) === EXCLUSION_VIOLATION) {
      throw conflict('That venue is already booked for this window. Pick a different time or venue.')
    }
    throw err
  }
}

/**
 * Removes a function from a CONFIRMED booking. Authority only. The venue holds fall away with
 * the sub-event (ON DELETE CASCADE); the total and dates are recomputed. A booking must keep at
 * least one function — to drop the last one, cancel the booking instead.
 */
export async function removeConfirmedFunction(actor: Actor, subEventId: string): Promise<void> {
  await db.transaction(async (tx) => {
    const [row] = await tx
      .select({
        eventId: schema.subEvents.eventId,
        name: schema.subEvents.name,
        status: schema.events.status,
        eventType: schema.events.eventType,
      })
      .from(schema.subEvents)
      .innerJoin(schema.events, eq(schema.events.id, schema.subEvents.eventId))
      .where(eq(schema.subEvents.id, subEventId))
      .for('update')
      .limit(1)
    if (!row) throw notFound('Function not found')
    if (!canAuthorityEditConfirmed(row.status, actor)) {
      throw conflict('Only the Higher Authority or Auditor can remove a function from a confirmed booking.')
    }
    const [{ n }] = (await tx.execute(
      sql`SELECT count(*)::int AS n FROM sub_events WHERE event_id = ${row.eventId}`,
    )) as unknown as { n: number }[]
    if (n <= 1) {
      throw badRequest('A confirmed booking must keep at least one function — cancel the booking instead.')
    }
    await tx.delete(schema.subEvents).where(eq(schema.subEvents.id, subEventId)) // cascade drops venue_bookings
    await recomputeProposal(tx, row.eventId, row.eventType)
    await audit(tx, actor, {
      entity: 'sub_events',
      entityId: subEventId,
      eventId: row.eventId,
      action: 'delete',
      field: 'name',
      oldValue: `${row.name} (removed post-confirm)`,
    })
  })
}
