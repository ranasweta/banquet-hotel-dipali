import type { NextRequest } from 'next/server'
import { z } from 'zod'
import { requirePermission } from '@/lib/auth'
import { badRequest, ok, route } from '@/lib/api'
import { listVenueAvailability } from '@/lib/availability'

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/
const querySchema = z.object({ date: z.string().regex(ISO_DATE), start: z.string().regex(HHMM), end: z.string().regex(HHMM) })

/**
 * GET /availability/venues?date=&start=&end= — every venue and bundle flagged free/booked
 * for the window, so the booking form can offer only the free ones (BR-C1).
 */
export const GET = route(async (req: NextRequest) => {
  await requirePermission('bookings', 'view')
  const url = new URL(req.url)
  const q = querySchema.parse({ date: url.searchParams.get('date') ?? undefined, start: url.searchParams.get('start') ?? undefined, end: url.searchParams.get('end') ?? undefined })
  if (q.start === q.end) throw badRequest('Start and end time cannot be equal')
  return ok(await listVenueAvailability(q.date, q.start, q.end))
})
