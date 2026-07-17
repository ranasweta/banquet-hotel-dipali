import type { NextRequest } from 'next/server'
import { z } from 'zod'
import { requirePermission } from '@/lib/auth'
import { checkAvailability, countOpenEnquiries } from '@/lib/availability'
import { badRequest, ok, route } from '@/lib/api'

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/

const querySchema = z
  .object({
    venue_id: z.uuid().optional(),
    bundle_id: z.uuid().optional(),
    date: z.string().regex(ISO_DATE, 'date must be YYYY-MM-DD'),
    start: z.string().regex(HHMM, 'start must be HH:MM'),
    end: z.string().regex(HHMM, 'end must be HH:MM'),
    exclude_event_id: z.uuid().optional(),
  })
  .refine((q) => Boolean(q.venue_id) !== Boolean(q.bundle_id), {
    message: 'provide exactly one of venue_id or bundle_id',
  })
  .refine((q) => q.start !== q.end, { message: 'start and end cannot be equal' })

/** GET /availability — inline time-overlap check for the booking wizard (FR-1.4). */
export const GET = route(async (req: NextRequest) => {
  await requirePermission('calendar', 'view')
  const params = Object.fromEntries(new URL(req.url).searchParams)
  const q = querySchema.safeParse(params)
  if (!q.success) throw badRequest(q.error.issues[0]?.message ?? 'invalid query')

  const result = await checkAvailability({
    venueId: q.data.venue_id,
    bundleId: q.data.bundle_id,
    date: q.data.date,
    startTime: q.data.start,
    endTime: q.data.end,
    excludeEventId: q.data.exclude_event_id,
  })

  return ok({
    available: result.available,
    crossesMidnight: result.crossesMidnight,
    conflicts: result.conflicts,
    open_enquiries: await countOpenEnquiries(result.venueIds, q.data.date),
  })
})
