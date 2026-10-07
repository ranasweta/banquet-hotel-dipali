import type { NextRequest } from 'next/server'
import { z } from 'zod'
import { requirePermission } from '@/lib/auth'
import { ok, route } from '@/lib/api'
import { markConverted } from '@/lib/instant-proposals'

const bodySchema = z.object({ event_id: z.uuid() })

/**
 * POST /instant-proposals/:id/convert { event_id } — records the real enquiry this instant
 * became. The enquiry itself is created through POST /events and its sub-event, menu and room
 * routes, so every rule a proposal obeys applies to it unchanged.
 */
export const POST = route(async (req: NextRequest, ctx: { params: Promise<{ id: string }> }) => {
  const actor = await requirePermission('bookings', 'create_edit')
  const { id } = await ctx.params
  const body = bodySchema.parse(await req.json())
  await markConverted(actor, z.uuid().parse(id), body.event_id)
  return ok({ id, eventId: body.event_id })
})
