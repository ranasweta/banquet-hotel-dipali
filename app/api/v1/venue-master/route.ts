import { requirePermission } from '@/lib/auth'
import { ok, route } from '@/lib/api'
import { getVenueCatalog } from '@/lib/venue-master'

/** GET /venue-master — properties, venues, bundles and every rate in force. */
export const GET = route(async () => {
  await requirePermission('venue_master', 'view')
  return ok(await getVenueCatalog())
})
