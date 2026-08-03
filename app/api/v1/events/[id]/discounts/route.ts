import type { NextRequest } from 'next/server'
import { z } from 'zod'
import { requirePermission } from '@/lib/auth'
import { ok, route } from '@/lib/api'
import { addDiscount, discountBases, listDiscounts } from '@/lib/discounts'
import { AUTHORITY_ROLES } from '@/lib/post-confirm'
import { getIntSettings } from '@/lib/settings'

const bodySchema = z
  .object({
    head: z.enum(['menu', 'venue', 'room', 'overall']),
    percent_bp: z.number().int().min(1).max(10000).optional(),
    amount_paise: z.number().int().positive().optional(),
    remark: z.string().trim().min(1).max(300),
    ref_id: z.uuid().optional(),
  })
  .refine((v) => (v.percent_bp == null) !== (v.amount_paise == null), {
    message: 'Give either a percentage or a rupee amount — exactly one.',
  })

/**
 * GET /events/:id/discounts — every discount (tagged effective/pending/rejected, live rupee
 * value) plus the per-head subtotals so the UI can price a "30% on menu" before it is saved.
 *
 * `capPct` and `uncapped` are here so the screen can state the rule it is actually under: the
 * cap is a setting, not the constant 10 the copy used to hardcode, and it does not bind the
 * Higher Authority at all (FR-11.3a). Telling him his discount goes to the GM for approval,
 * when he IS the GM and it takes effect at once, is the kind of small lie that costs a phone call.
 */
export const GET = route(async (_req: NextRequest, ctx: { params: Promise<{ id: string }> }) => {
  const actor = await requirePermission('billing', 'view')
  const { id } = await ctx.params
  const [discounts, bases, settings] = await Promise.all([
    listDiscounts(id),
    discountBases(id),
    getIntSettings(['discount_cap_pct'] as const, { discount_cap_pct: 10 }),
  ])
  return ok({
    discounts,
    bases,
    capPct: settings.discount_cap_pct,
    uncapped: AUTHORITY_ROLES.has(actor.roleName),
  })
})

/**
 * POST /events/:id/discounts — records a discount, as a percentage of a head or a fixed amount.
 * Within the 10% cap it takes effect (201); over the cap it is held behind a discount_over_cap
 * exception (202, BR-D2).
 */
export const POST = route(async (req: NextRequest, ctx: { params: Promise<{ id: string }> }) => {
  const actor = await requirePermission('billing', 'create_edit')
  const { id } = await ctx.params
  const input = bodySchema.parse(await req.json())
  const result = await addDiscount(actor, id, {
    head: input.head,
    percentBp: input.percent_bp,
    amountPaise: input.amount_paise,
    remark: input.remark,
    refId: input.ref_id,
  })
  return ok(result, result.deferred ? 202 : 201)
})
