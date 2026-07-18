import type { NextRequest } from 'next/server'
import { requirePermission } from '@/lib/auth'
import { ok, route } from '@/lib/api'
import { closeMaintenance } from '@/lib/maintenance'

/** POST /events/:id/maintenance/close — freeze entries + record the maintenance sign-off (FR-5.2). */
export const POST = route(async (_req: NextRequest, ctx: { params: Promise<{ id: string }> }) => {
  const actor = await requirePermission('maintenance', 'create_edit')
  const { id } = await ctx.params
  await closeMaintenance(actor, id)
  return ok({ ok: true })
})
