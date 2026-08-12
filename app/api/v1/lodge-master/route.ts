import { requirePermission } from '@/lib/auth'
import { ok, route } from '@/lib/api'
import { getLodgeCatalog } from '@/lib/lodge-master'

/** GET /lodge-master — every lodge with its categories, room counts and nightly rates. */
export const GET = route(async () => {
  await requirePermission('lodge_master', 'view')
  return ok({ lodges: await getLodgeCatalog() })
})
