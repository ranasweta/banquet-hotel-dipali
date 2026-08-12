import type { NextRequest } from 'next/server'
import { z } from 'zod'
import { requirePermission } from '@/lib/auth'
import { ok, route } from '@/lib/api'
import { createVenue } from '@/lib/venue-master'

// No capacity (client, 13 Aug 2026). It gates nothing and is displayed nowhere, so asking for
// it collected two numbers that do nothing; the columns stay NULL rather than invented.
const bodySchema = z.object({
  property_id: z.uuid(),
  name: z.string().min(1).max(120),
  kind: z.enum(['hall', 'lawn']),
})

/** POST /venue-master/venues — a new hall or lawn. It carries no rate until one is set. */
export const POST = route(async (req: NextRequest) => {
  const actor = await requirePermission('venue_master', 'create_edit')
  const b = bodySchema.parse(await req.json())
  return ok(await createVenue(actor, { propertyId: b.property_id, name: b.name, kind: b.kind }), 201)
})
