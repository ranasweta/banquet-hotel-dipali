import { requireAuth } from '@/lib/auth'
import { ok, route } from '@/lib/api'
import { getBookingDashboard } from '@/lib/dashboard'

/**
 * GET /dashboard — the home overview every signed-in user lands on: today's functions,
 * the next-7-day agenda, open enquiries, pending approvals, and 30-day payment balances.
 *
 * This is a read-only operations board shown to all staff on login, so it gates on
 * authentication only (like the home page itself) rather than a single module — every
 * underlying mutation still enforces its own permission elsewhere (CLAUDE.md rule 2).
 */
export const GET = route(async () => {
  await requireAuth()
  const data = await getBookingDashboard()
  return ok(data)
})
