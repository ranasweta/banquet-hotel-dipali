import type { NextRequest } from 'next/server'
import { requirePermission } from '@/lib/auth'
import { ok, route } from '@/lib/api'
import { getIncreaseSummary, submitIncreases } from '@/lib/menus'

/**
 * GET /sub-events/:id/menu/increase/submit — what the submit button would send: every
 * extra above the free two, by segment, with the dish names already ticked. Pre-fills the
 * confirmation exactly the way a chef delicacy request is pre-filled.
 */
export const GET = route(async (_req: NextRequest, ctx: { params: Promise<{ id: string }> }) => {
  await requirePermission('menus', 'view')
  const { id } = await ctx.params
  return ok((await getIncreaseSummary(id)) ?? { subEventId: id, totalExtras: 0, awaitingSubmission: 0, segments: [] })
})

/**
 * POST /sub-events/:id/menu/increase/submit — sends this function's outstanding extras to
 * the Higher Authority as one request.
 *
 * Per function and on demand, not batched at the lock: a wedding menu is settled over days
 * and the Authority is fed as each function is finished. Pressing it again after adding
 * more dishes sends only what is new; pressing it with nothing outstanding is a no-op 200.
 */
export const POST = route(async (_req: NextRequest, ctx: { params: Promise<{ id: string }> }) => {
  const actor = await requirePermission('menus', 'create_edit')
  const { id } = await ctx.params
  return ok(await submitIncreases(actor, id))
})
