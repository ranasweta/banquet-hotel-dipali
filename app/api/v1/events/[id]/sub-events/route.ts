import type { NextRequest } from 'next/server'
import { eq } from 'drizzle-orm'
import { z } from 'zod'
import { db, schema } from '@/db/drizzle'
import { requirePermission } from '@/lib/auth'
import { audit } from '@/lib/audit'
import { badRequest, conflict, notFound, ok, route } from '@/lib/api'

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/

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
 * Soft capacity check (FR-2.6): pax outside the venue's range is allowed only with an
 * explicit override note. For a bundle, the combined range is used.
 */
export async function assertCapacity(input: z.infer<typeof subEventSchema>): Promise<void> {
  let min = 0
  let max = Number.MAX_SAFE_INTEGER
  if (input.venue_id) {
    const [v] = await db
      .select({ min: schema.venues.capacityMin, max: schema.venues.capacityMax })
      .from(schema.venues)
      .where(eq(schema.venues.id, input.venue_id))
      .limit(1)
    if (!v) throw badRequest('Unknown venue')
    min = v.min
    max = v.max
  } else if (input.bundle_id) {
    const rows = await db
      .select({ min: schema.venues.capacityMin, max: schema.venues.capacityMax })
      .from(schema.venueBundleMembers)
      .innerJoin(schema.venues, eq(schema.venues.id, schema.venueBundleMembers.venueId))
      .where(eq(schema.venueBundleMembers.bundleId, input.bundle_id))
    if (rows.length === 0) throw badRequest('Unknown bundle')
    min = Math.min(...rows.map((r) => r.min))
    max = rows.reduce((sum, r) => sum + r.max, 0)
  }
  if ((input.pax < min || input.pax > max) && !input.pax_override_note?.trim()) {
    throw badRequest(
      `Pax ${input.pax} is outside this venue's range (${min}–${max}). Add an override note to proceed.`,
    )
  }
}

async function assertEnquiry(eventId: string): Promise<void> {
  const [event] = await db
    .select({ status: schema.events.status })
    .from(schema.events)
    .where(eq(schema.events.id, eventId))
    .limit(1)
  if (!event) throw notFound('Event not found')
  if (event.status !== 'enquiry') {
    throw conflict('This event is confirmed. Changing sub-events needs a change request (coming in M8).')
  }
}

/** POST /events/:id/sub-events — add a function to the event. */
export const POST = route(async (req: NextRequest, ctx: { params: Promise<{ id: string }> }) => {
  const actor = await requirePermission('bookings', 'create_edit')
  const { id } = await ctx.params
  const input = subEventSchema.parse(await req.json())
  await assertEnquiry(id)
  await assertCapacity(input)

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
