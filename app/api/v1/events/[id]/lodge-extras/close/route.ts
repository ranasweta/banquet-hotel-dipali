import type { NextRequest } from 'next/server'
import { requirePermission } from '@/lib/auth'
import { ok, route } from '@/lib/api'
import { closeLodgeExtras } from '@/lib/lodge-extras'

/**
 * POST /events/:id/lodge-extras/close — freeze the extras and let them reach the bill.
 *
 * Nothing logged here is charged until this is pressed, exactly as maintenance works (FR-5.2).
 */
export const POST = route(async (_req: NextRequest, ctx: { params: Promise<{ id: string }> }) => {
  const actor = await requirePermission('rooms', 'create_edit')
  const { id } = await ctx.params
  await closeLodgeExtras(actor, id)
  return ok({ ok: true })
})
