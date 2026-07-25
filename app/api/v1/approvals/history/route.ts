import { requirePermission } from '@/lib/auth'
import { forbidden, ok, route } from '@/lib/api'
import { DECIDER_ROLES, listExceptions } from '@/lib/approvals'

/**
 * GET /approvals/history — every settled exception across all bookings, for the record.
 *
 * Higher Authority and Auditor only. The `approvals:view` bit already limits to them
 * (masters.ts: everyone else is `none`), and the explicit role check keeps this true even if
 * the matrix ever widens — the history is the deciders' record, never a raiser's.
 */
export const GET = route(async () => {
  const actor = await requirePermission('approvals', 'view')
  if (!DECIDER_ROLES.has(actor.roleName)) {
    throw forbidden('Only the Higher Authority and Auditor can view the approvals history.')
  }
  const rows = await listExceptions({ decidedOnly: true })
  return ok({ exceptions: rows })
})
