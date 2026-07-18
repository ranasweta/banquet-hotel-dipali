import type { NextRequest } from 'next/server'
import { requirePermission } from '@/lib/auth'
import { ok, route } from '@/lib/api'
import { listExceptions } from '@/lib/approvals'

/**
 * GET /exceptions?status=pending&mine=1 — the approvals queue. Any role with `approvals`
 * view sees it; `mine=1` restricts to exceptions the caller raised (their own outcomes).
 */
export const GET = route(async (req: NextRequest) => {
  const actor = await requirePermission('approvals', 'view')
  const url = new URL(req.url)
  const status = url.searchParams.get('status') ?? undefined
  const mine = url.searchParams.get('mine') === '1'
  const rows = await listExceptions({
    status: status && ['pending', 'approved', 'rejected', 'approved_modified'].includes(status) ? status : undefined,
    mineId: mine ? actor.id : undefined,
  })
  return ok({ exceptions: rows })
})
