import type { NextRequest } from 'next/server'
import { eq } from 'drizzle-orm'
import { db, schema } from '@/db/drizzle'
import { requirePermission } from '@/lib/auth'
import { audit } from '@/lib/audit'
import { conflict, notFound, ok, route } from '@/lib/api'
import { subEventSchema } from '@/app/api/v1/events/[id]/sub-events/route'
import { canAuthorityEditConfirmed, removeConfirmedFunction } from '@/lib/post-confirm'

async function loadEditableSub(subId: string) {
  const [sub] = await db
    .select({ id: schema.subEvents.id, eventId: schema.subEvents.eventId, status: schema.events.status })
    .from(schema.subEvents)
    .innerJoin(schema.events, eq(schema.events.id, schema.subEvents.eventId))
    .where(eq(schema.subEvents.id, subId))
    .limit(1)
  if (!sub) throw notFound('Sub-event not found')
  if (sub.status !== 'enquiry') {
    throw conflict('This event is confirmed. Changing sub-events needs a change request (coming in M8).')
  }
  return sub
}

/** PUT /sub-events/:id — edit a function (pre-confirm). */
export const PUT = route(async (req: NextRequest, ctx: { params: Promise<{ id: string }> }) => {
  const actor = await requirePermission('bookings', 'create_edit')
  const { id } = await ctx.params
  const sub = await loadEditableSub(id)
  const input = subEventSchema.parse(await req.json())

  await db
    .update(schema.subEvents)
    .set({
      name: input.name,
      eventDate: input.event_date,
      startTime: input.start_time,
      endTime: input.end_time,
      venueId: input.venue_id ?? null,
      bundleId: input.bundle_id ?? null,
      pax: input.pax,
      paxOverrideNote: input.pax_override_note ?? null,
    })
    .where(eq(schema.subEvents.id, id))
  await audit(db, actor, { entity: 'sub_events', entityId: id, eventId: sub.eventId, action: 'update', field: 'name', newValue: input.name })
  return ok({ subEvent: { id } })
})

/**
 * DELETE /sub-events/:id — remove a function. Enquiries: anyone with create_edit. A confirmed
 * booking: Higher Authority / Auditor only, via removeConfirmedFunction (which frees the venue
 * holds and recomputes totals). Everyone else on a confirmed booking is sent to change requests.
 */
export const DELETE = route(async (_req: NextRequest, ctx: { params: Promise<{ id: string }> }) => {
  const actor = await requirePermission('bookings', 'create_edit')
  const { id } = await ctx.params

  const [sub] = await db
    .select({ eventId: schema.subEvents.eventId, status: schema.events.status })
    .from(schema.subEvents)
    .innerJoin(schema.events, eq(schema.events.id, schema.subEvents.eventId))
    .where(eq(schema.subEvents.id, id))
    .limit(1)
  if (!sub) throw notFound('Sub-event not found')

  if (canAuthorityEditConfirmed(sub.status, actor)) {
    await removeConfirmedFunction(actor, id)
    return ok({ ok: true })
  }
  if (sub.status !== 'enquiry') {
    throw conflict('This event is confirmed. Changing sub-events needs a change request (coming in M8).')
  }

  await db.delete(schema.subEvents).where(eq(schema.subEvents.id, id))
  await audit(db, actor, { entity: 'sub_events', entityId: id, eventId: sub.eventId, action: 'delete', field: 'name' })
  return ok({ ok: true })
})
