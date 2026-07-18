import type { NextRequest } from 'next/server'
import { requirePermission } from '@/lib/auth'
import { ok, route } from '@/lib/api'
import { finaliseInvoice } from '@/lib/invoice'

/** POST /events/:id/invoice/finalise — assign the invoice number and move to Billed (FR-7.4). */
export const POST = route(async (_req: NextRequest, ctx: { params: Promise<{ id: string }> }) => {
  const actor = await requirePermission('billing', 'create_edit')
  const { id } = await ctx.params
  return ok(await finaliseInvoice(actor, id))
})
