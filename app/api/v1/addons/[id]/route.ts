import type { NextRequest } from 'next/server'
import { requirePermission } from '@/lib/auth'
import { ok, route } from '@/lib/api'
import { deleteAddon } from '@/lib/menus'

/** DELETE /addons/:id — remove an add-on line. */
export const DELETE = route(async (_req: NextRequest, ctx: { params: Promise<{ id: string }> }) => {
  const actor = await requirePermission('menus', 'create_edit')
  const { id } = await ctx.params
  await deleteAddon(actor, id)
  return ok({ ok: true })
})
