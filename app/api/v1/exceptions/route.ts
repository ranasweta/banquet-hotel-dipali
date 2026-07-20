import type { NextRequest } from 'next/server'
import { requirePermission } from '@/lib/auth'
import { ok, route } from '@/lib/api'
import { DECIDER_ROLES, listExceptions } from '@/lib/approvals'

/**
 * GET /exceptions?status=pending — the exception queue.
 *
 * Scoped to the caller, server-side: only the role that decides an exception (Higher Authority,
 * and the Auditor for oversight) sees the whole queue. Everyone else sees just the ones they
 * raised — their own outcomes. Approvals belong to whoever settles them, and a Banquet Manager
 * reading a menu increase that is sitting with the GM is a leak, not a convenience. The
 * `approvals` permission bit cannot express that, so the rule lives here rather than relying on
 * the client to pass a flag it could simply omit.
 */
export const GET = route(async (req: NextRequest) => {
  const actor = await requirePermission('approvals', 'view')
  const url = new URL(req.url)
  const status = url.searchParams.get('status') ?? undefined
  const rows = await listExceptions({
    status: status && ['pending', 'approved', 'rejected', 'approved_modified'].includes(status) ? status : undefined,
    mineId: DECIDER_ROLES.has(actor.roleName) ? undefined : actor.id,
  })
  return ok({ exceptions: rows })
})
