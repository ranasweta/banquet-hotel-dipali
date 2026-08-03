import type { NextRequest } from 'next/server'
import { eq } from 'drizzle-orm'
import { z } from 'zod'
import { db, schema } from '@/db/drizzle'
import { requirePermission } from '@/lib/auth'
import { audit } from '@/lib/audit'
import { conflict, notFound, ok, route } from '@/lib/api'
import { addConfirmedFunction, canAuthorityEditConfirmed } from '@/lib/post-confirm'

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/

/**
 * Pax is whatever the Booking Manager says it is (client, 3 Aug 2026 — withdraws FR-2.6).
 * The venue's `capacity_min`/`capacity_max` no longer gate the number and no override note is
 * demanded: the hotel seats guests across a lawn and its adjoining hall in ways the stored
 * range does not describe, and a manager taking a booking should not have to argue with a
 * figure that was, for half the venues, invented in the first place (SEED_ASSUMPTIONS A3/A4).
 * `max(100000)` stays as a typo guard — it is not a venue capacity.
 */
export const subEventSchema = z
  .object({
    name: z.string().trim().min(1).max(80),
    event_date: z.string().regex(ISO_DATE),
    start_time: z.string().regex(HHMM),
    end_time: z.string().regex(HHMM),
    venue_id: z.uuid().optional(),
    bundle_id: z.uuid().optional(),
    pax: z.number().int().positive().max(100000),
    pax_override_note: z.string().max(300).optional(),
  })
  .refine((s) => Boolean(s.venue_id) !== Boolean(s.bundle_id), {
    message: 'provide exactly one of venue_id or bundle_id',
  })
  .refine((s) => s.start_time !== s.end_time, { message: 'start and end time cannot be equal' })

/**
 * POST /events/:id/sub-events — add a function. Enquiries: anyone with bookings create_edit.
 * A confirmed booking: Higher Authority / Auditor only — they go through addConfirmedFunction,
 * which also blocks the venue window and recomputes totals (lib/post-confirm). Everyone else on
 * a confirmed booking is sent to the change-request flow.
 */
export const POST = route(async (req: NextRequest, ctx: { params: Promise<{ id: string }> }) => {
  const actor = await requirePermission('bookings', 'create_edit')
  const { id } = await ctx.params
  const input = subEventSchema.parse(await req.json())

  const [event] = await db
    .select({ status: schema.events.status })
    .from(schema.events)
    .where(eq(schema.events.id, id))
    .limit(1)
  if (!event) throw notFound('Event not found')

  if (canAuthorityEditConfirmed(event.status, actor)) {
    const created = await addConfirmedFunction(actor, id, {
      name: input.name,
      eventDate: input.event_date,
      startTime: input.start_time,
      endTime: input.end_time,
      venueId: input.venue_id,
      bundleId: input.bundle_id,
      pax: input.pax,
      paxOverrideNote: input.pax_override_note,
    })
    return ok({ subEvent: created }, 201)
  }
  if (event.status !== 'enquiry') {
    throw conflict('This event is confirmed. Changing sub-events needs a change request (coming in M8).')
  }

  const [sub] = await db
    .insert(schema.subEvents)
    .values({
      eventId: id,
      name: input.name,
      eventDate: input.event_date,
      startTime: input.start_time,
      endTime: input.end_time,
      venueId: input.venue_id ?? null,
      bundleId: input.bundle_id ?? null,
      pax: input.pax,
      paxOverrideNote: input.pax_override_note ?? null,
    })
    .returning({ id: schema.subEvents.id })

  await audit(db, actor, {
    entity: 'sub_events',
    entityId: sub!.id,
    eventId: id,
    action: 'insert',
    field: 'name',
    newValue: input.name,
  })
  return ok({ subEvent: { id: sub!.id } }, 201)
})
