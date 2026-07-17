import type { NextRequest } from 'next/server'
import { eq } from 'drizzle-orm'
import { z } from 'zod'
import { db, schema } from '@/db/drizzle'
import { requirePermission } from '@/lib/auth'
import { badRequest, ok, route } from '@/lib/api'
import { transitionEvent } from '@/lib/events'

const bodySchema = z.object({ reason: z.string().trim().min(1).max(500) })

/**
 * POST /events/:id/cancel — cancel a pre-lock event. Cancelling a confirmed event also
 * frees its venue windows (the venue_bookings rows cascade with the sub-events, which
 * remain, so we clear the bookings explicitly).
 */
export const POST = route(async (req: NextRequest, ctx: { params: Promise<{ id: string }> }) => {
  const actor = await requirePermission('bookings', 'create_edit')
  const { id } = await ctx.params
  const { reason } = bodySchema.parse(await req.json())

  await db.transaction(async (tx) => {
    const [event] = await tx
      .select({ status: schema.events.status })
      .from(schema.events)
      .where(eq(schema.events.id, id))
      .for('update')
      .limit(1)
    if (!event) throw badRequest('Event not found')

    // Free the calendar: a cancelled event holds no venue windows.
    await tx.delete(schema.venueBookings).where(eq(schema.venueBookings.eventId, id))
    await transitionEvent(tx, id, 'cancelled', actor, { reason })
  })

  return ok({ ok: true })
})
