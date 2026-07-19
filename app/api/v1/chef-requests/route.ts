import type { NextRequest } from 'next/server'
import { requirePermission } from '@/lib/auth'
import { ok, route } from '@/lib/api'
import { listChefQueue } from '@/lib/chef'

/**
 * GET /chef-requests?status=pending — the Chef's queue of delicacy requests, pending first.
 * Gated on `menus` view, which the Chef role holds; pricing itself is role-checked in the
 * service (only the Chef may set an amount).
 */
export const GET = route(async (req: NextRequest) => {
  await requirePermission('menus', 'view')
  const status = new URL(req.url).searchParams.get('status') ?? undefined
  return ok({ requests: await listChefQueue(status) })
})
