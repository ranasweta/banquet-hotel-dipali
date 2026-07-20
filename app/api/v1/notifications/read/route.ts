import type { NextRequest } from 'next/server'
import { z } from 'zod'
import { requireAuth } from '@/lib/auth'
import { ok, route } from '@/lib/api'
import { markNotificationsRead } from '@/lib/notifications'

const bodySchema = z.object({ ids: z.array(z.string().min(1).max(80)).min(1).max(200) })

/**
 * POST /notifications/read — marks notifications dealt with for the signed-in user, so a
 * touched item stops reappearing. Always scoped to the caller: the id is only ever paired with
 * their own user, so marking cannot affect anyone else's feed.
 */
export const POST = route(async (req: NextRequest) => {
  const user = await requireAuth()
  const { ids } = bodySchema.parse(await req.json())
  const n = await markNotificationsRead(user.id, ids)
  return ok({ marked: n })
})
