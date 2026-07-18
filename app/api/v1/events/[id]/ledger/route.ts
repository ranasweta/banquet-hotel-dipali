import type { NextRequest } from 'next/server'
import { requirePermission } from '@/lib/auth'
import { ok, route } from '@/lib/api'
import { getLedger } from '@/lib/payments'

/** GET /events/:id/ledger — proposal, discounts, payments, and running paid-vs-balance. */
export const GET = route(async (_req: NextRequest, ctx: { params: Promise<{ id: string }> }) => {
  await requirePermission('billing', 'view')
  const { id } = await ctx.params
  return ok(await getLedger(id))
})
