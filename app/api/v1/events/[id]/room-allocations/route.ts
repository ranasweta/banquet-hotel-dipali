import type { NextRequest } from 'next/server'
import { z } from 'zod'
import { requirePermission } from '@/lib/auth'
import { ok, route } from '@/lib/api'
import { allocateRooms } from '@/lib/rooms'

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/
const bodySchema = z.object({
  allocations: z
    .array(
      z.object({
        room_id: z.uuid(),
        check_in: z.string().regex(ISO_DATE),
        check_out: z.string().regex(ISO_DATE),
        rate_paise: z.number().int().nonnegative().optional(),
        discount_paise: z.number().int().nonnegative().optional(),
        override_note: z.string().max(300).optional(),
      }),
    )
    .min(1)
    .max(200),
})

/**
 * POST /events/:id/room-allocations — bulk allocate rooms. Overlap → 409; reaching the
 * large-allocation threshold defers the batch to an exception → 202; a per-room discount
 * over the cap → 400 (BR-D1).
 */
export const POST = route(async (req: NextRequest, ctx: { params: Promise<{ id: string }> }) => {
  const actor = await requirePermission('rooms', 'create_edit')
  const { id } = await ctx.params
  const { allocations } = bodySchema.parse(await req.json())
  const result = await allocateRooms(
    actor,
    id,
    allocations.map((a) => ({
      roomId: a.room_id,
      checkIn: a.check_in,
      checkOut: a.check_out,
      ratePaise: a.rate_paise,
      discountPaise: a.discount_paise,
      overrideNote: a.override_note,
    })),
  )
  return ok(result, result.deferred ? 202 : 201)
})
