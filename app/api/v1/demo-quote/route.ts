import type { NextRequest } from 'next/server'
import { z } from 'zod'
import { requirePermission } from '@/lib/auth'
import { ok, route } from '@/lib/api'
import { demoQuote } from '@/lib/demo-quote'

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/
const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/

const bodySchema = z.object({
  event_type: z.string().min(1).max(40),
  functions: z
    .array(
      z
        .object({
          name: z.string().min(1).max(80),
          event_date: z.string().regex(ISO_DATE),
          start_time: z.string().regex(HHMM),
          end_time: z.string().regex(HHMM),
          venue_id: z.uuid().nullable(),
          bundle_id: z.uuid().nullable(),
          pax: z.number().int().positive(),
          tier_id: z.uuid(),
        })
        .refine((f) => Boolean(f.venue_id) !== Boolean(f.bundle_id), { message: 'Pick one venue or one bundle' }),
    )
    .min(1)
    .max(30),
  rooms: z
    .array(
      z.object({
        unit_id: z.uuid(),
        room_type: z.string().min(1).max(40),
        count: z.number().int().positive(),
        nights: z.number().int().positive(),
      }),
    )
    .max(50),
})

/**
 * POST /demo-quote — prices a demo proposal without saving anything (see lib/demo-quote.ts).
 * Read-only, so nothing to audit; gated like New proposal because it is the same counter's tool.
 */
export const POST = route(async (req: NextRequest) => {
  await requirePermission('bookings', 'create_edit')
  const body = bodySchema.parse(await req.json())
  const quote = await demoQuote({
    eventType: body.event_type,
    functions: body.functions.map((f) => ({
      name: f.name,
      eventDate: f.event_date,
      startTime: f.start_time,
      endTime: f.end_time,
      venueId: f.venue_id,
      bundleId: f.bundle_id,
      pax: f.pax,
      tierId: f.tier_id,
    })),
    rooms: body.rooms.map((r) => ({ unitId: r.unit_id, roomType: r.room_type, count: r.count, nights: r.nights })),
  })
  return ok({ quote })
})
