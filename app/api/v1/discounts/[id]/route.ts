import type { NextRequest } from 'next/server'
import { requirePermission } from '@/lib/auth'
import { ok, route } from '@/lib/api'
import { deleteDiscount } from '@/lib/discounts'

/** DELETE /discounts/:id — remove a discount (and its pending exception, if any). */
export const DELETE = route(async (_req: NextRequest, ctx: { params: Promise<{ id: string }> }) => {
  const actor = await requirePermission('billing', 'create_edit')
  const { id } = await ctx.params
  await deleteDiscount(actor, id)
  return ok({ ok: true })
})
