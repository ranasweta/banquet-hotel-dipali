import type { NextRequest } from 'next/server'
import { requirePermission } from '@/lib/auth'
import { ok, route } from '@/lib/api'
import { removePlates } from '@/lib/utensils'

/** DELETE /extra-plates/:id — remove a plate entry (and its photo), before the log is closed. */
export const DELETE = route(async (_req: NextRequest, ctx: { params: Promise<{ id: string }> }) => {
  const actor = await requirePermission('utensils', 'create_edit')
  const { id } = await ctx.params
  await removePlates(actor, id)
  return ok({ ok: true })
})
