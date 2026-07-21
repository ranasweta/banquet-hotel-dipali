import type { NextRequest } from 'next/server'
import { z } from 'zod'
import { requirePermission } from '@/lib/auth'
import { ok, route } from '@/lib/api'
import { increaseCategory } from '@/lib/menus'

const bodySchema = z.object({ category: z.string().min(1) })

/**
 * POST /sub-events/:id/menu/increase { category } — unlocks the segment.
 *
 * It does not grant "+1". From here the manager takes as many dishes from that segment as
 * the guest wants, and everything above the base count is an extra: coloured apart in the
 * picker and remembered by name (client, 21 Jul 2026).
 *
 * Always 200, and nothing reaches the Higher Authority here. Two extras per FUNCTION are
 * free; the rest go out when the function presses submit — see ./submit.
 */
export const POST = route(async (req: NextRequest, ctx: { params: Promise<{ id: string }> }) => {
  const actor = await requirePermission('menus', 'create_edit')
  const { id } = await ctx.params
  const { category } = bodySchema.parse(await req.json())
  const result = await increaseCategory(actor, id, category)
  return ok(result)
})
