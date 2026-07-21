import type { NextRequest } from 'next/server'
import { eq } from 'drizzle-orm'
import { db, schema } from '@/db/drizzle'
import { requirePermission } from '@/lib/auth'
import { notFound, ok, route } from '@/lib/api'
import { foodAndAddonTotal, loadSubEventsForPricing, priceProposal, roomEstimatePaise } from '@/lib/pricing'
import { percentOfPaise } from '@/lib/money'

/**
 * GET /events/:id/quote — the priced proposal for the review step, before confirm. Shows
 * per-sub-event venue charges, the total, the 25% advance required, and any venue with no
 * rate card (BR-R1) so the wizard can warn before the confirm gate is hit.
 */
export const GET = route(async (_req: NextRequest, ctx: { params: Promise<{ id: string }> }) => {
  await requirePermission('bookings', 'view')
  const { id } = await ctx.params

  const [event] = await db
    .select({ eventType: schema.events.eventType })
    .from(schema.events)
    .where(eq(schema.events.id, id))
    .limit(1)
  if (!event) throw notFound('Event not found')

  const subs = await loadSubEventsForPricing(id)
  const pricing = await priceProposal(event.eventType, subs)
  const [extras, roomEst] = await Promise.all([foodAndAddonTotal(id), roomEstimatePaise(id)])

  const lines = subs.map((s) => ({
    subEventId: s.id,
    name: s.name,
    ratePaise: pricing.rates.get(s.id) ?? null,
  }))

  return ok({
    totalPaise: pricing.totalPaise,
    // The 25% is measured on everything the guest will pay, rooms included
    // (client, 20 Jul 2026) — see SEED_ASSUMPTIONS §F10.
    advanceRequiredPaise: percentOfPaise(
      pricing.totalPaise + extras.foodPaise + extras.addonPaise + roomEst.roomsPaise + roomEst.roomsTaxPaise,
      25,
    ),
    lines,
    missing: pricing.missing,
  })
})
