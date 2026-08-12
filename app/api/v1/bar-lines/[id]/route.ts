import type { NextRequest } from 'next/server'
import { requirePermission } from '@/lib/auth'
import { ok, route } from '@/lib/api'
import { removeBarLine } from '@/lib/bar'

/** DELETE /bar-lines/:id — take a brand off a function. */
export const DELETE = route(async (_req: NextRequest, ctx: { params: Promise<{ id: string }> }) => {
  const actor = await requirePermission('menus', 'create_edit')
  const { id } = await ctx.params
  await removeBarLine(actor, id)
  return ok({ ok: true })
})
