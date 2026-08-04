import type { NextRequest } from 'next/server'
import { z } from 'zod'
import { requirePermission } from '@/lib/auth'
import { ok, route } from '@/lib/api'
import { changePax } from '@/lib/change-requests'

// No ceiling on pax (client, 4 Aug 2026) and no override note — that field existed to explain
// exceeding a venue capacity, and there is no capacity to exceed since 3 Aug.
const bodySchema = z.object({ pax: z.number().int().positive() })

/** POST /sub-events/:id/pax — a post-confirm pax change applies directly, versioned (FR-1.9). */
export const POST = route(async (req: NextRequest, ctx: { params: Promise<{ id: string }> }) => {
  const actor = await requirePermission('bookings', 'create_edit')
  const { id } = await ctx.params
  const input = bodySchema.parse(await req.json())
  await changePax(actor, id, input.pax)
  return ok({ ok: true })
})
