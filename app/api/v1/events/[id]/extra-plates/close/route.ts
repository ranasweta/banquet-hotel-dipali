import type { NextRequest } from 'next/server'
import { requirePermission } from '@/lib/auth'
import { ok, route } from '@/lib/api'
import { closeUtensilExtras } from '@/lib/utensils'

/**
 * POST /events/:id/extra-plates/close — freeze the plate log and let it reach the bill.
 *
 * Nothing logged is charged until this is pressed, as with maintenance (FR-5.2) and the
 * lodge's extras.
 */
export const POST = route(async (_req: NextRequest, ctx: { params: Promise<{ id: string }> }) => {
  const actor = await requirePermission('utensils', 'create_edit')
  const { id } = await ctx.params
  await closeUtensilExtras(actor, id)
  return ok({ ok: true })
})
