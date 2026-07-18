import type { NextRequest } from 'next/server'
import { requirePermission } from '@/lib/auth'
import { ok, route } from '@/lib/api'
import { getInvoice } from '@/lib/invoice'

/** GET /events/:id/invoice — the drafted/finalised invoice with its lines and totals. */
export const GET = route(async (_req: NextRequest, ctx: { params: Promise<{ id: string }> }) => {
  await requirePermission('billing', 'view')
  const { id } = await ctx.params
  return ok({ invoice: await getInvoice(id) })
})
