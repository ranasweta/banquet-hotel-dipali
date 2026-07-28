import type { NextRequest } from 'next/server'
import { requirePermission } from '@/lib/auth'
import { ok, route } from '@/lib/api'
import { proposalDocument } from '@/lib/proposal'

/**
 * GET /events/:id/proforma — the guest-facing proposal document, live from current data (a
 * quote before the invoice exists). Gated on `bookings` view: the guest-facing Booking Manager
 * needs to hand over an estimate even though the final invoice is billing's domain.
 */
export const GET = route(async (_req: NextRequest, ctx: { params: Promise<{ id: string }> }) => {
  await requirePermission('bookings', 'view')
  const { id } = await ctx.params
  return ok(await proposalDocument(id))
})
