import type { NextRequest } from 'next/server'
import { z } from 'zod'
import { requirePermission } from '@/lib/auth'
import { ok, route } from '@/lib/api'
import { cancelEvent } from '@/lib/events'

const bodySchema = z.object({ reason: z.string().trim().min(1).max(500) })

/**
 * POST /events/:id/cancel — cancel a pre-lock event, releasing its venue windows and its
 * rooms. The service does the work (lib/events.ts, cancelEvent); PRD §4.1 refuses the move
 * from locked onward.
 */
export const POST = route(async (req: NextRequest, ctx: { params: Promise<{ id: string }> }) => {
  const actor = await requirePermission('bookings', 'create_edit')
  const { id } = await ctx.params
  const { reason } = bodySchema.parse(await req.json())
  return ok(await cancelEvent(actor, id, reason))
})
