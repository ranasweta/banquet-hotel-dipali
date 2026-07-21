import type { NextRequest } from 'next/server'
import { requirePermission } from '@/lib/auth'
import { ok, route } from '@/lib/api'
import { getReconciliation } from '@/lib/rooms'

/**
 * GET /events/:id/rooms/reconciliation — can the lodge deliver what the proposal sold?
 * (FR-4.5, rewritten 21 Jul 2026.)
 *
 * Per line: promised, the lodge's capacity for that category, the peak held by OTHER
 * committed events over the same nights, and the resulting shortfall. `deliverable` is the
 * Lodge Manager's sign-off in one boolean.
 */
export const GET = route(async (_req: NextRequest, ctx: { params: Promise<{ id: string }> }) => {
  await requirePermission('rooms', 'view')
  const { id } = await ctx.params
  const data = await getReconciliation(id)
  return ok(data)
})
