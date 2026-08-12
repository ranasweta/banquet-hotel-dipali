import type { NextRequest } from 'next/server'
import { z } from 'zod'
import { requirePermission } from '@/lib/auth'
import { ok, route } from '@/lib/api'
import { createVenue } from '@/lib/venue-master'

const bodySchema = z.object({
  property_id: z.uuid(),
  name: z.string().min(1).max(120),
  kind: z.enum(['hall', 'lawn']),
  // A capacity is descriptive seed data and gates nothing (rule 13); it still has to be a
  // sane pair, or the venue list reads as nonsense.
  capacity_min: z.number().int().positive(),
  capacity_max: z.number().int().positive(),
}).refine((b) => b.capacity_max >= b.capacity_min, {
  message: 'The maximum capacity cannot be below the minimum.',
})

/** POST /venue-master/venues — a new hall or lawn. It carries NO rate until one is set. */
export const POST = route(async (req: NextRequest) => {
  const actor = await requirePermission('venue_master', 'create_edit')
  const b = bodySchema.parse(await req.json())
  return ok(
    await createVenue(actor, {
      propertyId: b.property_id,
      name: b.name,
      kind: b.kind,
      capacityMin: b.capacity_min,
      capacityMax: b.capacity_max,
    }),
    201,
  )
})
