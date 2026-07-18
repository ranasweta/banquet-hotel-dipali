import { requireAuth } from '@/lib/auth'
import { ok, route } from '@/lib/api'
import { notificationsFor } from '@/lib/notifications'

/** GET /notifications — the signed-in user's actionable feed (FR-9.1). */
export const GET = route(async () => {
  const user = await requireAuth()
  return ok({ notifications: await notificationsFor(user) })
})
