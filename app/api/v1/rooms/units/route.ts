import { requirePermission } from '@/lib/auth'
import { ok, route } from '@/lib/api'
import { listUnits } from '@/lib/rooms'

/** GET /rooms/units — lodging units + room counts, for the board's unit selector. */
export const GET = route(async () => {
  await requirePermission('rooms', 'view')
  const units = await listUnits()
  return ok({ units })
})
