import type { NextRequest } from 'next/server'
import { requireAuth } from '@/lib/auth'
import { ok, route } from '@/lib/api'
import { pendingReminders } from '@/lib/reminders'

/**
 * GET /reminders/pending — payment reminders due today for the caller's role audience
 * (booking_manager or higher_authority). Not gated on the billing module: a Booking Manager
 * needs their own reminders even though they don't touch billing.
 */
export const GET = route(async (req: NextRequest) => {
  const user = await requireAuth()
  const asOf = new URL(req.url).searchParams.get('as_of') ?? new Date().toISOString().slice(0, 10)
  const reminders = await pendingReminders(user.roleName, asOf)
  return ok({ reminders })
})
