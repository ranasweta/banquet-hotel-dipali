import type { NextRequest } from 'next/server'
import { z } from 'zod'
import { requirePermission } from '@/lib/auth'
import { ok, route } from '@/lib/api'
import { setInRoomDining } from '@/lib/lodge-extras'

const bodySchema = z.object({ amount_paise: z.number().int().nonnegative() })

/**
 * PUT /events/:id/lodge-extras/dining — set the in-room dining total for the whole stay.
 *
 * A PUT, not a POST: it is one box that is overwritten as it grows (client, 15 Aug 2026), so
 * sending 4,200 twice must leave 4,200 and not 8,400. The old figure survives in the audit log.
 */
export const PUT = route(async (req: NextRequest, ctx: { params: Promise<{ id: string }> }) => {
  const actor = await requirePermission('rooms', 'create_edit')
  const { id } = await ctx.params
  const { amount_paise } = bodySchema.parse(await req.json())
  await setInRoomDining(actor, id, amount_paise)
  return ok({ ok: true })
})
