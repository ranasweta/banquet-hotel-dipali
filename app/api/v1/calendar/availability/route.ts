import type { NextRequest } from 'next/server'
import { z } from 'zod'
import { requirePermission } from '@/lib/auth'
import { getVenueTape } from '@/lib/availability'
import { badRequest, ok, route } from '@/lib/api'
import { nextDay } from '@/lib/occupancy'

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/
const WINDOW_DAYS = 31
const MAX_SPAN_DAYS = 92

const querySchema = z.object({
  from: z.string().regex(ISO_DATE).optional(),
  to: z.string().regex(ISO_DATE).optional(),
})

function addDays(date: string, n: number): string {
  let d = date
  for (let i = 0; i < n; i++) d = nextDay(d)
  return d
}

/**
 * GET /calendar/availability?from=&to= — the tape chart's occupancy: every hall, lawn and
 * bundle with the windows it is taken in over the span (client's lead, 18 Sep 2026). Both
 * ends inclusive; a month at a time, since the screen picks its day from a month grid.
 *
 * No 15-day clamp, unlike `/calendar`. That cap exists because the board carries whose booking
 * a date belongs to; this payload carries no guest, no code and no money — only busy windows —
 * and a manager asked whether a hall is free in November needs the answer for November.
 * MAX_SPAN_DAYS is a query guard, not a permission boundary.
 */
export const GET = route(async (req: NextRequest) => {
  await requirePermission('calendar', 'view')
  const parsed = querySchema.safeParse(Object.fromEntries(new URL(req.url).searchParams))
  if (!parsed.success) throw badRequest('from/to must be YYYY-MM-DD')

  const from = parsed.data.from ?? new Date().toLocaleDateString('en-CA')
  let to = parsed.data.to ?? addDays(from, WINDOW_DAYS - 1)
  if (to < from) throw badRequest('`to` cannot be before `from`')
  const maxTo = addDays(from, MAX_SPAN_DAYS - 1)
  if (to > maxTo) to = maxTo

  return ok(await getVenueTape(from, to))
})
