import type { NextRequest } from 'next/server'
import { requirePermission } from '@/lib/auth'
import { ok, route } from '@/lib/api'
import { getReconciliation } from '@/lib/rooms'

/** GET /events/:id/rooms/reconciliation — promised vs allocated vs occupied (FR-4.5). */
export const GET = route(async (_req: NextRequest, ctx: { params: Promise<{ id: string }> }) => {
  await requirePermission('rooms', 'view')
  const { id } = await ctx.params
  const data = await getReconciliation(id)
  return ok(data)
})
