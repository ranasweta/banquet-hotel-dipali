import type { NextRequest } from 'next/server'
import { requirePermission } from '@/lib/auth'
import { ok, route } from '@/lib/api'
import { PRICER_ROLES, listChefQueue } from '@/lib/chef'

/**
 * GET /chef-requests?status=pending — delicacy requests, pending first.
 *
 * Scoped like the other approval queues: the Chef settles these, so only they (and the Auditor)
 * see the whole queue. Everyone else sees only the requests they raised — their own outcomes.
 */
export const GET = route(async (req: NextRequest) => {
  const actor = await requirePermission('menus', 'view')
  const status = new URL(req.url).searchParams.get('status') ?? undefined
  const mineId = PRICER_ROLES.has(actor.roleName) ? undefined : actor.id
  return ok({ requests: await listChefQueue(status, mineId) })
})
