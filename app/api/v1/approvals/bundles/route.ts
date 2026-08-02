import { requirePermission } from '@/lib/auth'
import { forbidden, ok, route } from '@/lib/api'
import { listBundles } from '@/lib/approval-bundles'
import { DECIDER_ROLES } from '@/lib/approvals'

/**
 * GET /approvals/bundles — every proposal with at least one pending ask, one row each.
 *
 * Deciders only, matching the queue's existing scoping (migration 0019): an approvals queue
 * belongs to whoever settles it, and a bundle exposes the whole booking behind the ask, so a
 * role that cannot decide has no business reading one.
 */
export const GET = route(async () => {
  const actor = await requirePermission('approvals', 'view')
  if (!DECIDER_ROLES.has(actor.roleName)) {
    throw forbidden('Only the Higher Authority works the approvals queue.')
  }
  return ok({ bundles: await listBundles() })
})
