import type { NextRequest } from 'next/server'
import { z } from 'zod'
import { requirePermission } from '@/lib/auth'
import { ok, route } from '@/lib/api'
import { addDiscount, listDiscounts } from '@/lib/discounts'

const bodySchema = z.object({
  head: z.enum(['menu', 'venue', 'overall']),
  amount_paise: z.number().int().positive(),
  remark: z.string().trim().min(1).max(300),
  ref_id: z.uuid().optional(),
})

/** GET /events/:id/discounts — every discount on the event, tagged effective/pending/rejected. */
export const GET = route(async (_req: NextRequest, ctx: { params: Promise<{ id: string }> }) => {
  await requirePermission('billing', 'view')
  const { id } = await ctx.params
  return ok({ discounts: await listDiscounts(id) })
})

/**
 * POST /events/:id/discounts — records a discount. Within the 10% cap it takes effect (201);
 * over the cap it is held behind a discount_over_cap exception (202, BR-D2).
 */
export const POST = route(async (req: NextRequest, ctx: { params: Promise<{ id: string }> }) => {
  const actor = await requirePermission('billing', 'create_edit')
  const { id } = await ctx.params
  const input = bodySchema.parse(await req.json())
  const result = await addDiscount(actor, id, {
    head: input.head,
    amountPaise: input.amount_paise,
    remark: input.remark,
    refId: input.ref_id,
  })
  return ok(result, result.deferred ? 202 : 201)
})
