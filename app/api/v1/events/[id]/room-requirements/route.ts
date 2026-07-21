import type { NextRequest } from 'next/server'
import { z } from 'zod'
import { requirePermission } from '@/lib/auth'
import { ok, route } from '@/lib/api'
import { listRoomRequirements, saveRoomRequirements } from '@/lib/rooms'

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/

const bodySchema = z.object({
  requirements: z
    .array(
      z
        .object({
          unit_id: z.uuid(),
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
 * POST /events/:id/room-requirements — rooms are booked here, in bulk, on the proposal
 * (client, 21 Jul 2026): lodge + category + count + dates IS the booking, and it is what
 * the lodging calendar reads. Room numbers are the reception desk's business and are not
 * recorded. Replace-all for the event.
 *
 * The rule itself (BR-L2, 35+ rooms defer to the Authority) lives in the service so it runs
 * in one transaction and can be tested directly — CLAUDE.md keeps business rules out of
 * route handlers.
 */
export const POST = route(async (req: NextRequest, ctx: { params: Promise<{ id: string }> }) => {
  const actor = await requirePermission('bookings', 'create_edit')
  const { id } = await ctx.params
  const { requirements } = bodySchema.parse(await req.json())

  const result = await saveRoomRequirements(
    actor,
    id,
    requirements.map((r) => ({
      unitId: r.unit_id,
      roomType: r.room_type,
      count: r.count,
      checkIn: r.check_in,
      checkOut: r.check_out,
    })),
  )

  // 202 when the Authority has to decide first, mirroring the other deferral paths.
  return ok(result, result.deferred ? 202 : 200)
})

/** GET /events/:id/room-requirements — the rooms on this booking, for the event's panel. */
export const GET = route(async (_req: NextRequest, ctx: { params: Promise<{ id: string }> }) => {
  await requirePermission('bookings', 'view')
  const { id } = await ctx.params
  return ok({ requirements: await listRoomRequirements(id) })
})
