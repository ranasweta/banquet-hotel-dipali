import type { NextRequest } from 'next/server'
import { z } from 'zod'
import { requirePermission } from '@/lib/auth'
import { ok, route } from '@/lib/api'
import { changePax } from '@/lib/change-requests'

const bodySchema = z.object({ pax: z.number().int().positive().max(100000), override_note: z.string().max(300).optional() })

/** POST /sub-events/:id/pax — a post-confirm pax change applies directly, versioned (FR-1.9). */
export const POST = route(async (req: NextRequest, ctx: { params: Promise<{ id: string }> }) => {
  const actor = await requirePermission('bookings', 'create_edit')
  const { id } = await ctx.params
  const input = bodySchema.parse(await req.json())
  await changePax(actor, id, input.pax, input.override_note)
  return ok({ ok: true })
})
