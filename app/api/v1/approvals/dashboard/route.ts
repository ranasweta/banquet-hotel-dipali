import { requirePermission } from '@/lib/auth'
import { ok, route } from '@/lib/api'
import { authorityDashboard } from '@/lib/approvals'

/** GET /approvals/dashboard — pending load + biggest upcoming events (FR-6.3). */
export const GET = route(async () => {
  await requirePermission('approvals', 'view')
  const data = await authorityDashboard()
  return ok(data)
})
