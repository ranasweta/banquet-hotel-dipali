import type { NextRequest } from 'next/server'
import { z } from 'zod'
import { requirePermission } from '@/lib/auth'
import { ok, route } from '@/lib/api'
import { createBundle } from '@/lib/venue-master'

const bodySchema = z.object({
  name: z.string().min(1).max(120),
  venue_ids: z.array(z.uuid()).min(2),
})

/** POST /venue-master/bundles — combine two or more venues into one bookable offering. */
export const POST = route(async (req: NextRequest) => {
  const actor = await requirePermission('venue_master', 'create_edit')
  const b = bodySchema.parse(await req.json())
  return ok(await createBundle(actor, { name: b.name, venueIds: b.venue_ids }), 201)
})
