import type { NextRequest } from 'next/server'
import { z } from 'zod'
import { requireAuth } from '@/lib/auth'
import { ok, route } from '@/lib/api'
import { saveSubscription, removeSubscription } from '@/lib/push'

/**
 * The device's push endpoint. Gated on being signed in and nothing else: a push tells you
 * that something in YOUR queue changed, so it is not a module the Auditor grants — it is the
 * same entitlement as the bell, which every signed-in user already has.
 */
const subscribeSchema = z.object({
  endpoint: z.url().max(2000),
  keys: z.object({
    p256dh: z.string().min(1).max(255),
    auth: z.string().min(1).max(255),
  }),
})

export const POST = route(async (req: NextRequest) => {
  const user = await requireAuth()
  const sub = subscribeSchema.parse(await req.json())
  await saveSubscription(user.id, sub, req.headers.get('user-agent'))
  return ok({ subscribed: true })
})

const unsubscribeSchema = z.object({ endpoint: z.url().max(2000) })

/** Turning notifications off on this device. Deletes by endpoint, which is the device. */
export const DELETE = route(async (req: NextRequest) => {
  await requireAuth()
  const { endpoint } = unsubscribeSchema.parse(await req.json())
  await removeSubscription(endpoint)
  return ok({ subscribed: false })
})
