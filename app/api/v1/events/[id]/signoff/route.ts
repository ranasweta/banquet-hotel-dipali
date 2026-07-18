import type { NextRequest } from 'next/server'
import { z } from 'zod'
import { requireAuth } from '@/lib/auth'
import { ok, route } from '@/lib/api'
import { signoff } from '@/lib/lock'

const bodySchema = z.object({ designation: z.enum(['banquet_manager', 'lodge_manager', 'maintenance', 'booking_manager']) })

/**
 * POST /events/:id/signoff — record a lock sign-off. Not billing-gated: each manager signs
 * their own designation (the service enforces role = designation, or Auditor).
 */
export const POST = route(async (req: NextRequest, ctx: { params: Promise<{ id: string }> }) => {
  const actor = await requireAuth()
  const { id } = await ctx.params
  const { designation } = bodySchema.parse(await req.json())
  await signoff(actor, id, designation)
  return ok({ ok: true })
})
