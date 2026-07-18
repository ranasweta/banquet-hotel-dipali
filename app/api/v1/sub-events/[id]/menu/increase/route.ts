import type { NextRequest } from 'next/server'
import { z } from 'zod'
import { requirePermission } from '@/lib/auth'
import { ok, route } from '@/lib/api'
import { increaseCategory } from '@/lib/menus'

const bodySchema = z.object({ category: z.string().min(1) })

/**
 * POST /sub-events/:id/menu/increase { category } — one free +1 on an eligible category,
 * else a deferred Exception. Returns 200 when applied free, 202 when it raised an
 * exception awaiting Authority approval (BR-M2/BR-M3).
 */
export const POST = route(async (req: NextRequest, ctx: { params: Promise<{ id: string }> }) => {
  const actor = await requirePermission('menus', 'create_edit')
  const { id } = await ctx.params
  const { category } = bodySchema.parse(await req.json())
  const result = await increaseCategory(actor, id, category)
  return ok(result, result.applied === 'exception' ? 202 : 200)
})
