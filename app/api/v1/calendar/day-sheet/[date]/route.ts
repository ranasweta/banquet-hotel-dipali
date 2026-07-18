import type { NextRequest } from 'next/server'
import { requirePermission } from '@/lib/auth'
import { badRequest, ok, route } from '@/lib/api'
import { getDaySheet } from '@/lib/daysheet'

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/

/** GET /calendar/day-sheet/:date — the consolidated kitchen & ops order for a date (FR-2.4). */
export const GET = route(async (_req: NextRequest, ctx: { params: Promise<{ date: string }> }) => {
  await requirePermission('calendar', 'view')
  const { date } = await ctx.params
  if (!ISO_DATE.test(date)) throw badRequest('Date must be YYYY-MM-DD')
  return ok(await getDaySheet(date))
})
