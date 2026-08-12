import type { NextRequest } from 'next/server'
import { z } from 'zod'
import { requirePermission } from '@/lib/auth'
import { ok, route } from '@/lib/api'
import { updateBundle } from '@/lib/venue-master'

const patchSchema = z.object({
  name: z.string().min(1).max(120).optional(),
  venue_ids: z.array(z.uuid()).min(2).optional(),
})

/**
 * PUT /venue-master/bundles/:id — rename, or replace the membership.
 *
 * Membership is refused once the bundle is on a booking: it decides which halls that booking
 * holds (FR-2.3), so changing it would silently move what has already been sold.
 */
export const PUT = route(async (req: NextRequest, ctx: { params: Promise<{ id: string }> }) => {
  const actor = await requirePermission('venue_master', 'create_edit')
  const { id } = await ctx.params
  const b = patchSchema.parse(await req.json())
  await updateBundle(actor, id, { name: b.name, venueIds: b.venue_ids })
  return ok({ ok: true })
})
