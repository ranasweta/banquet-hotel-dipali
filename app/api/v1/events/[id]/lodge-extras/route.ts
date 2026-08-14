import type { NextRequest } from 'next/server'
import { requirePermission } from '@/lib/auth'
import { ok, route } from '@/lib/api'
import { getLodgeExtras } from '@/lib/lodge-extras'

/**
 * GET /events/:id/lodge-extras — the extra rooms given during the event, the in-room dining
 * total, the closed flag, and the lodge + category list the form picks from.
 *
 * The options ride along because the Lodge Manager has no `bookings` permission and so cannot
 * call `/booking-options`, which is where every other room form gets its categories.
 */
export const GET = route(async (_req: NextRequest, ctx: { params: Promise<{ id: string }> }) => {
  await requirePermission('rooms', 'view')
  const { id } = await ctx.params
  return ok(await getLodgeExtras(id))
})
