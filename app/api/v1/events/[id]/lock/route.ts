import type { NextRequest } from 'next/server'
import { requirePermission } from '@/lib/auth'
import { ok, route } from '@/lib/api'
import { lockEvent } from '@/lib/lock'

/** POST /events/:id/lock — validate the checklist, freeze the event, draft the invoice (Auditor). */
export const POST = route(async (_req: NextRequest, ctx: { params: Promise<{ id: string }> }) => {
  const actor = await requirePermission('billing', 'create_edit')
  const { id } = await ctx.params
  const result = await lockEvent(actor, id)
  return ok(result)
})
