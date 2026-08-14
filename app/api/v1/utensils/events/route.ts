import { requirePermission } from '@/lib/auth'
import { ok, route } from '@/lib/api'
import { listUtensilEvents } from '@/lib/utensils'

/** GET /utensils/events — the Utensil Manager's work queue: In Progress / Completed events. */
export const GET = route(async () => {
  await requirePermission('utensils', 'view')
  return ok({ events: await listUtensilEvents() })
})
