import type { NextRequest } from 'next/server'
import { requirePermission } from '@/lib/auth'
import { ok, route } from '@/lib/api'
import { invoicePrintData } from '@/lib/invoice'

/** GET /events/:id/invoice/print — bill + guest details + T&C snapshot + sign-offs (FR-7.6). */
export const GET = route(async (_req: NextRequest, ctx: { params: Promise<{ id: string }> }) => {
  await requirePermission('billing', 'view')
  const { id } = await ctx.params
  return ok(await invoicePrintData(id))
})
