import { requirePermission } from '@/lib/auth'
import { ok, route } from '@/lib/api'
import { listMaintenanceEvents } from '@/lib/maintenance'

/** GET /maintenance/events — In Progress / Completed events the team may log against (FR-5.1). */
export const GET = route(async () => {
  await requirePermission('maintenance', 'view')
  return ok({ events: await listMaintenanceEvents() })
})
