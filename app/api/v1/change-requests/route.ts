import type { NextRequest } from 'next/server'
import { z } from 'zod'
import { requirePermission } from '@/lib/auth'
import { ok, route } from '@/lib/api'
import { DECIDER_ROLES, listChangeRequests, requestChange } from '@/lib/change-requests'

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/
const bodySchema = z.object({
  sub_event_id: z.uuid(),
  reason: z.string().max(300).optional(),
  payload: z
    .object({
      event_date: z.string().regex(ISO_DATE).optional(),
      start_time: z.string().regex(HHMM).optional(),
      end_time: z.string().regex(HHMM).optional(),
      venue_id: z.uuid().optional(),
      bundle_id: z.uuid().optional(),
    })
    .refine((p) => Object.keys(p).length > 0, { message: 'nothing to change' }),
})

/**
 * GET /change-requests?status=&event_id= — the change-request queue (pending first).
 *
 * Scoped like the exception queue: the Banquet Manager decides venue/timing moves, so only they
 * (and the Auditor) see the whole queue. Everyone else sees only the moves they asked for.
 */
export const GET = route(async (req: NextRequest) => {
  const actor = await requirePermission('calendar', 'view')
  const url = new URL(req.url)
  const status = url.searchParams.get('status') ?? undefined
  const eventId = url.searchParams.get('event_id') ?? undefined
  const rows = await listChangeRequests({
    mineId: DECIDER_ROLES.has(actor.roleName) ? undefined : actor.id,
    status: status && ['pending', 'approved', 'rejected'].includes(status) ? status : undefined,
    eventId: eventId ?? undefined,
  })
  return ok({ changeRequests: rows })
})

/** POST /change-requests — file a date/time/venue change on a confirmed sub-event (FR-1.9). */
export const POST = route(async (req: NextRequest) => {
  const actor = await requirePermission('bookings', 'create_edit')
  const input = bodySchema.parse(await req.json())
  const result = await requestChange(actor, input.sub_event_id, {
    reason: input.reason,
    payload: {
      eventDate: input.payload.event_date,
      startTime: input.payload.start_time,
      endTime: input.payload.end_time,
      venueId: input.payload.venue_id,
      bundleId: input.payload.bundle_id,
    },
  })
  return ok({ changeRequest: result }, 201)
})
