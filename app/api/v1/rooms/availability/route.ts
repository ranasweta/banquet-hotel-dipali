import type { NextRequest } from 'next/server'
import { z } from 'zod'
import { requirePermission } from '@/lib/auth'
import { badRequest, ok, route } from '@/lib/api'
import { getRoomAvailability } from '@/lib/rooms'

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/

const lineSchema = z
  .object({
    unit_id: z.string().uuid(),
    room_type: z.string().min(1),
    check_in: z.string().regex(ISO_DATE),
    check_out: z.string().regex(ISO_DATE),
  })
  .refine((l) => l.check_out > l.check_in, { message: 'check_out must be after check_in' })

const bodySchema = z.object({
  event_id: z.string().uuid().optional(),
  lines: z.array(lineSchema).min(1).max(50),
})

/**
 * POST /rooms/availability — how many rooms of each category a lodge has free over a
 * range. Drives the ceiling the booking form shows before anyone tries to save; the same
 * numbers are re-checked inside the save transaction, which is what actually binds.
 *
 * A POST rather than a GET because the question is asked about a list of lines, and the
 * wizard asks it on every edit. `event_id` excludes an event's own existing rows so
 * editing a saved requirement doesn't count against itself.
 *
 * Gated on `bookings:view`: rooms are booked on the proposal now (migration 0009), so this
 * is a booking question. Lodge Managers read the same numbers through the lodging calendar.
 */
export const POST = route(async (req: NextRequest) => {
  await requirePermission('bookings', 'view')

  const parsed = bodySchema.safeParse(await req.json().catch(() => null))
  if (!parsed.success) throw badRequest(parsed.error.issues[0]?.message ?? 'Invalid request')

  const lines = await getRoomAvailability(
    parsed.data.lines.map((l) => ({
      unitId: l.unit_id,
      roomType: l.room_type,
      checkIn: l.check_in,
      checkOut: l.check_out,
    })),
    parsed.data.event_id,
  )

  return ok({ lines })
})
