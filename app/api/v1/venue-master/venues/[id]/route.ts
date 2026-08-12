import type { NextRequest } from 'next/server'
import { z } from 'zod'
import { requirePermission } from '@/lib/auth'
import { ok, route } from '@/lib/api'
import { updateVenue } from '@/lib/venue-master'

const patchSchema = z.object({
  name: z.string().min(1).max(120).optional(),
  kind: z.enum(['hall', 'lawn']).optional(),
  capacity_min: z.number().int().positive().optional(),
  capacity_max: z.number().int().positive().optional(),
  is_active: z.boolean().optional(),
})

/** PUT /venue-master/venues/:id — rename, re-kind, re-size, retire or restore. */
export const PUT = route(async (req: NextRequest, ctx: { params: Promise<{ id: string }> }) => {
  const actor = await requirePermission('venue_master', 'create_edit')
  const { id } = await ctx.params
  const b = patchSchema.parse(await req.json())
  await updateVenue(actor, id, {
    name: b.name,
    kind: b.kind,
    capacityMin: b.capacity_min,
    capacityMax: b.capacity_max,
    isActive: b.is_active,
  })
  return ok({ ok: true })
})
