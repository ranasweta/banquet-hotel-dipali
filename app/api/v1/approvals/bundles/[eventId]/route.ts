import type { NextRequest } from 'next/server'
import { requirePermission } from '@/lib/auth'
import { forbidden, ok, route } from '@/lib/api'
import { bundleDetail } from '@/lib/approval-bundles'
import { DECIDER_ROLES } from '@/lib/approvals'

/**
 * GET /approvals/bundles/:eventId — the asks on one proposal plus the proposal itself.
 * `?settled=1` also returns decisions already made, so the GM can see his own history on
 * this booking rather than a screen that empties as he works it.
 */
export const GET = route(async (req: NextRequest, ctx: { params: Promise<{ eventId: string }> }) => {
  const actor = await requirePermission('approvals', 'view')
  if (!DECIDER_ROLES.has(actor.roleName)) {
    throw forbidden('Only the Higher Authority works the approvals queue.')
  }
  const { eventId } = await ctx.params
  const includeSettled = new URL(req.url).searchParams.get('settled') === '1'
  return ok(await bundleDetail(eventId, { includeSettled }))
})
