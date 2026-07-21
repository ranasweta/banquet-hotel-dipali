import type { NextRequest } from 'next/server'
import { z } from 'zod'
import { requirePermission } from '@/lib/auth'
import { badRequest, ok, route } from '@/lib/api'
import { getLodgingCalendar } from '@/lib/rooms'
import { nextDay } from '@/lib/occupancy'

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/

// The Lodge Manager's window is 30 days, wider than the venue board's rolling 15 (FR-2.1).
// That divergence is the client's instruction, not an oversight — recorded in
// docs/SEED_ASSUMPTIONS.md. MAX_SPAN_DAYS is a query guard, not a permission boundary.
const WINDOW_DAYS = 30
const MAX_SPAN_DAYS = 92

function todayLocal(): string {
  return new Date().toLocaleDateString('en-CA') // YYYY-MM-DD in the server's local zone
}
function addDays(date: string, n: number): string {
  let d = date
  for (let i = 0; i < n; i++) d = nextDay(d)
  return d
}

const querySchema = z.object({
  from: z.string().regex(ISO_DATE).optional(),
  to: z.string().regex(ISO_DATE).optional(),
})

/**
 * GET /rooms/calendar?from=&to= — cumulative room occupancy per date, unit and category.
 * Both ends inclusive. Defaults to the next 30 days from today.
 */
export const GET = route(async (req: NextRequest) => {
  await requirePermission('lodging_calendar', 'view')
  const parsed = querySchema.safeParse(Object.fromEntries(new URL(req.url).searchParams))
  if (!parsed.success) throw badRequest('from/to must be YYYY-MM-DD')

  const from = parsed.data.from ?? todayLocal()
  let to = parsed.data.to ?? addDays(from, WINDOW_DAYS - 1)
  if (to < from) throw badRequest('`to` cannot be before `from`')

  // Bound the generate_series so a hand-built URL can't ask for a decade.
  const maxTo = addDays(from, MAX_SPAN_DAYS - 1)
  if (to > maxTo) to = maxTo

  return ok({ ...(await getLodgingCalendar(from, to)), windowDays: WINDOW_DAYS })
})
