import type { NextRequest } from 'next/server'
import { eq } from 'drizzle-orm'
import { z } from 'zod'
import { db, schema } from '@/db/drizzle'
import { requirePermission } from '@/lib/auth'
import { audit } from '@/lib/audit'
import { badRequest, notFound, ok, route } from '@/lib/api'

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/

const bodySchema = z.object({
  requirements: z
    .array(
      z
        .object({
          room_type: z.string().min(1).max(40),
          count: z.number().int().positive().max(1000),
          check_in: z.string().regex(ISO_DATE),
          check_out: z.string().regex(ISO_DATE),
        })
        .refine((r) => r.check_out > r.check_in, { message: 'check_out must be after check_in' }),
    )
    .max(50),
})

/**
 * POST /events/:id/room-requirements — the wizard's step 4 hand-off to the Lodge Manager
 * (FR-1.6). Replace-all for the event. Palace-default for lawn weddings (BR-L1) is a UI
 * hint on the allocation screen (M5); requirements themselves carry no unit.
 */
export const POST = route(async (req: NextRequest, ctx: { params: Promise<{ id: string }> }) => {
  const actor = await requirePermission('bookings', 'create_edit')
  const { id } = await ctx.params
  const { requirements } = bodySchema.parse(await req.json())

  await db.transaction(async (tx) => {
    const [event] = await tx
      .select({ status: schema.events.status })
      .from(schema.events)
      .where(eq(schema.events.id, id))
      .limit(1)
    if (!event) throw notFound('Event not found')
    if (event.status !== 'enquiry') throw badRequest('Room requirements can only be set on an enquiry')

    await tx.delete(schema.roomRequirements).where(eq(schema.roomRequirements.eventId, id))
    if (requirements.length) {
      await tx.insert(schema.roomRequirements).values(
        requirements.map((r) => ({
          eventId: id,
          roomType: r.room_type,
          count: r.count,
          checkIn: r.check_in,
          checkOut: r.check_out,
        })),
      )
    }
    await audit(tx, actor, {
      entity: 'room_requirements',
      entityId: id,
      eventId: id,
      action: 'update',
      field: 'requirements',
      newValue: `${requirements.length} line(s)`,
    })
  })

  return ok({ ok: true })
})
