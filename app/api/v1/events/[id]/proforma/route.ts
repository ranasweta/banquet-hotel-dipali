import type { NextRequest } from 'next/server'
import { requirePermission } from '@/lib/auth'
import { ok, route } from '@/lib/api'
import { proformaData } from '@/lib/invoice'

/**
 * GET /events/:id/proforma — a live proforma estimate for a confirmed-but-unlocked event (a
 * quote before the invoice exists). Gated on `bookings` view: the guest-facing Booking Manager
 * needs to hand over an estimate even though the final invoice is billing's domain.
 */
export const GET = route(async (_req: NextRequest, ctx: { params: Promise<{ id: string }> }) => {
  await requirePermission('bookings', 'view')
  const { id } = await ctx.params
  return ok(await proformaData(id))
})
