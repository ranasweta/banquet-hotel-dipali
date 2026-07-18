import type { NextRequest } from 'next/server'
import { requirePermission } from '@/lib/auth'
import { ok, route } from '@/lib/api'
import { lockChecklist } from '@/lib/lock'

/** GET /events/:id/lock-checklist — computed item states + whether the event can lock. */
export const GET = route(async (_req: NextRequest, ctx: { params: Promise<{ id: string }> }) => {
  await requirePermission('billing', 'view')
  const { id } = await ctx.params
  return ok(await lockChecklist(id))
})
