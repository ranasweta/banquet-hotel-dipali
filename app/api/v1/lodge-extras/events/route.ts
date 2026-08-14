import { requirePermission } from '@/lib/auth'
import { ok, route } from '@/lib/api'
import { listLodgeExtrasEvents } from '@/lib/lodge-extras'

/** GET /lodge-extras/events — the Lodge Manager's work queue: In Progress / Completed events. */
export const GET = route(async () => {
  await requirePermission('rooms', 'view')
  return ok({ events: await listLodgeExtrasEvents() })
})
