import type { NextRequest } from 'next/server'
import { eq } from 'drizzle-orm'
import { db, schema } from '@/db/drizzle'
import { requirePermission } from '@/lib/auth'
import { notFound, ok, route } from '@/lib/api'
import { loadSubEventsForPricing, priceProposal } from '@/lib/pricing'
import { shownTaxPaise } from '@/lib/invoice'
import { ADVANCE_PCT, WEDDING_MILESTONE_PCT, payableBreakdown } from '@/lib/payment-schedule'
import { percentOfPaise } from '@/lib/money'

/**
 * GET /events/:id/quote — the priced proposal for the review step, before confirm. Shows
 * per-sub-event venue charges, what is payable, the 25% advance required, and any venue with
 * no rate card (BR-R1) so the wizard can warn before the confirm gate is hit.
 *
 * Two totals, because the bill carries two (client's lead, 4 Aug 2026): `displayTotalPaise`
 * is what the document prints, `payablePaise` is what is collected and what every percentage
 * here is taken from. The 18% sits between them and is charged to nobody.
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
  const [bill, shownGstPaise] = await Promise.all([payableBreakdown(id), shownTaxPaise(id)])

  const lines = subs.map((s) => ({
    subEventId: s.id,
    name: s.name,
    ratePaise: pricing.rates.get(s.id) ?? null,
  }))

  return ok({
    totalPaise: pricing.totalPaise,
    proposalPaise: bill.proposalPaise,
    roomsPaise: bill.roomsPaise,
    roomsTaxPaise: bill.roomsTaxPaise,
    discountPaise: bill.discountPaise,
    // Everything the guest actually pays: venue + food + rooms + the 5%, less discounts.
    payablePaise: bill.payablePaise,
    shownGstPaise,
    displayTotalPaise: bill.payablePaise + shownGstPaise,
    paidPaise: bill.paidPaise,
    // The 25% is measured on the payable amount, rooms and their 5% included (client,
    // 20/25 Jul 2026 — see SEED_ASSUMPTIONS §F10). The 18% is not in it.
    advanceRequiredPaise: percentOfPaise(bill.payablePaise, ADVANCE_PCT),
    weddingMilestonePaise: percentOfPaise(bill.payablePaise, WEDDING_MILESTONE_PCT),
    lines,
    missing: pricing.missing,
  })
})
