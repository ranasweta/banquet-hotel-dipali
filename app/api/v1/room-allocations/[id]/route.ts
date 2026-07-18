import type { NextRequest } from 'next/server'
import { requirePermission } from '@/lib/auth'
import { ok, route } from '@/lib/api'
import { deallocateRoom } from '@/lib/rooms'

/** DELETE /room-allocations/:id — un-assign a room. */
export const DELETE = route(async (_req: NextRequest, ctx: { params: Promise<{ id: string }> }) => {
  const actor = await requirePermission('rooms', 'create_edit')
  const { id } = await ctx.params
  await deallocateRoom(actor, id)
  return ok({ ok: true })
})
