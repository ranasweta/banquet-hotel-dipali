import type { NextRequest } from 'next/server'
import { requirePermission } from '@/lib/auth'
import { ok, route } from '@/lib/api'
import { proposalDocument } from '@/lib/proposal'

/**
 * GET /events/:id/invoice/print — the same proposal document as /proforma, behind billing's
 * gate. A guest reads one design at both stages; only the Draft / Draft 2 stamp differs.
 */
export const GET = route(async (_req: NextRequest, ctx: { params: Promise<{ id: string }> }) => {
  await requirePermission('billing', 'view')
  const { id } = await ctx.params
  return ok(await proposalDocument(id))
})
