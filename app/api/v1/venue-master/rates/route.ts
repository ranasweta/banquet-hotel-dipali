import type { NextRequest } from 'next/server'
import { z } from 'zod'
import { requirePermission } from '@/lib/auth'
import { ok, route } from '@/lib/api'
import { clearRate, setRate } from '@/lib/venue-master'

const target = z
  .object({ venue_id: z.uuid().optional(), bundle_id: z.uuid().optional() })
  .refine((t) => Boolean(t.venue_id) !== Boolean(t.bundle_id), {
    message: 'A rate belongs to a venue or a bundle, not both and not neither.',
  })

const putSchema = target.and(
  z.object({
    event_type: z.string().min(1),
    // ZERO IS VALID and means free — that is how "an Other booking pays no standalone hall
    // charge" is written down. Removing the rate is DELETE, and it means something else.
    rate_paise: z.number().int().nonnegative(),
    effective_from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  }),
)

/** PUT /venue-master/rates — set what a venue or bundle costs for one event type. */
export const PUT = route(async (req: NextRequest) => {
  const actor = await requirePermission('venue_master', 'create_edit')
  const b = putSchema.parse(await req.json())
  await setRate(
    actor,
    { venueId: b.venue_id, bundleId: b.bundle_id },
    { eventType: b.event_type, ratePaise: b.rate_paise, effectiveFrom: b.effective_from },
  )
  return ok({ ok: true })
})

const deleteSchema = target.and(z.object({ event_type: z.string().min(1) }))

/**
 * DELETE /venue-master/rates — remove a rate, turning that venue + event type back into a gate.
 *
 * Needs `delete`, not `create_edit`: an unpriced venue vanishes from the standalone picker and
 * blocks confirmation (BR-R1), which is a heavier act than pricing one at zero.
 */
export const DELETE = route(async (req: NextRequest) => {
  const actor = await requirePermission('venue_master', 'delete')
  const b = deleteSchema.parse(await req.json())
  await clearRate(actor, { venueId: b.venue_id, bundleId: b.bundle_id }, b.event_type)
  return ok({ ok: true })
})
