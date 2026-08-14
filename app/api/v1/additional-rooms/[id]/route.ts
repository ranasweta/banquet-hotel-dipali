import type { NextRequest } from 'next/server'
import { requirePermission } from '@/lib/auth'
import { ok, route } from '@/lib/api'
import { removeRoomLine } from '@/lib/lodge-extras'

/** DELETE /additional-rooms/:id — remove a line of extra rooms, before the extras are closed. */
export const DELETE = route(async (_req: NextRequest, ctx: { params: Promise<{ id: string }> }) => {
  const actor = await requirePermission('rooms', 'create_edit')
  const { id } = await ctx.params
  await removeRoomLine(actor, id)
  return ok({ ok: true })
})
