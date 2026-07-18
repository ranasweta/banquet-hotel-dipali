import type { NextRequest } from 'next/server'
import { z } from 'zod'
import { requirePermission } from '@/lib/auth'
import { badRequest, ok, route } from '@/lib/api'
import { getRoomsBoard } from '@/lib/rooms'

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/
const querySchema = z.object({
  unit_id: z.uuid(),
  from: z.string().regex(ISO_DATE),
  to: z.string().regex(ISO_DATE),
})

/** GET /rooms/board?unit_id=&from=&to= — a unit's rooms with allocations in the window. */
export const GET = route(async (req: NextRequest) => {
  await requirePermission('rooms', 'view')
  const url = new URL(req.url)
  const q = querySchema.parse({
    unit_id: url.searchParams.get('unit_id') ?? undefined,
    from: url.searchParams.get('from') ?? undefined,
    to: url.searchParams.get('to') ?? undefined,
  })
  if (q.to <= q.from) throw badRequest('`to` must be after `from`')
  const board = await getRoomsBoard(q.unit_id, q.from, q.to)
  return ok(board)
})
