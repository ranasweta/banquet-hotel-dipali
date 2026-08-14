import type { NextRequest } from 'next/server'
import { z } from 'zod'
import { requirePermission } from '@/lib/auth'
import { ok, route } from '@/lib/api'
import { addRoomLine } from '@/lib/lodge-extras'

const bodySchema = z.object({
  unit_id: z.string().uuid(),
  room_type: z.string().trim().min(1).max(60),
  // Whole positive numbers, with no ceiling of their own: the desk gives out what it has, and
  // this is a record of what happened rather than a booking to be bounded (rule 13).
  count: z.number().int().positive(),
  nights: z.number().int().positive(),
  remarks: z.string().max(300).optional(),
})

/** POST /events/:id/lodge-extras/rooms — log rooms given beyond the booking. */
export const POST = route(async (req: NextRequest, ctx: { params: Promise<{ id: string }> }) => {
  const actor = await requirePermission('rooms', 'create_edit')
  const { id } = await ctx.params
  const b = bodySchema.parse(await req.json())
  const line = await addRoomLine(actor, id, {
    unitId: b.unit_id,
    roomType: b.room_type,
    count: b.count,
    nights: b.nights,
    remarks: b.remarks,
  })
  return ok({ line }, 201)
})
