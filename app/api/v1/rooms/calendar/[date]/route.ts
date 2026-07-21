import type { NextRequest } from 'next/server'
import { requirePermission } from '@/lib/auth'
import { badRequest, ok, route } from '@/lib/api'
import { getLodgingDay } from '@/lib/rooms'

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/

/**
 * GET /rooms/calendar/:date — one date drilled down: which event holds how many rooms of
 * each category in each unit, and how many are left.
 */
export const GET = route(async (_req: NextRequest, ctx: { params: Promise<{ date: string }> }) => {
  await requirePermission('lodging_calendar', 'view')
  const { date } = await ctx.params
  if (!ISO_DATE.test(date)) throw badRequest('Date must be YYYY-MM-DD')
  return ok(await getLodgingDay(date))
})
