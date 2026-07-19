import { requireAuth } from '@/lib/auth'
import { ok, route } from '@/lib/api'
import { getDashboardForRole } from '@/lib/dashboard'

/**
 * GET /dashboard — the home overview for the signed-in user, tailored to their role
 * (booking / banquet / lodge / maintenance; the `kind` field discriminates). Gated on
 * authentication only, like the home page itself — every underlying mutation still enforces
 * its own module permission (CLAUDE.md rule 2).
 */
export const GET = route(async () => {
  const user = await requireAuth()
  const data = await getDashboardForRole(user.roleName)
  return ok(data)
})
