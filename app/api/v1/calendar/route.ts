import type { NextRequest } from 'next/server'
import { z } from 'zod'
import { requirePermission } from '@/lib/auth'
import { getCalendarBookings, listVenuesForBoard } from '@/lib/availability'
import { badRequest, ok, route } from '@/lib/api'
import { nextDay } from '@/lib/occupancy'

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/
const WINDOW_DAYS = 15

// FR-2.1 and PRD §2 give the rolling 15-day operational view to the **Banquet Manager**,
// who owns the venue calendar. It was previously applied to every role except Auditor and
// Higher Authority, which over-read the spec: a Booking Manager quoting dates needs to see
// as far ahead as a guest might ask (client, 20 Jul 2026). Capping is now opt-in by role.
const CAPPED_ROLES = new Set(['banquet_manager'])

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

/** GET /calendar — venues × dates board of confirmed-and-beyond bookings (FR-2.1, FR-2.5). */
export const GET = route(async (req: NextRequest) => {
  const user = await requirePermission('calendar', 'view')
  const parsed = querySchema.safeParse(Object.fromEntries(new URL(req.url).searchParams))
  if (!parsed.success) throw badRequest('from/to must be YYYY-MM-DD')

  const today = todayLocal()
  let from = parsed.data.from ?? today
  let to = parsed.data.to ?? addDays(today, WINDOW_DAYS - 1)

  const capped = CAPPED_ROLES.has(user.roleName)
  if (capped) {
    // Clamp to [today, today + 15 days) server-side — the client cannot widen it.
    const maxTo = addDays(today, WINDOW_DAYS - 1)
    if (from < today) from = today
    if (to > maxTo) to = maxTo
    if (from > maxTo) from = today
  }
  if (to < from) to = from

  const [venues, bookings] = await Promise.all([listVenuesForBoard(), getCalendarBookings(from, to)])

  return ok({
    from,
    to,
    capped,
    windowDays: WINDOW_DAYS,
    venues,
    bookings,
  })
})
