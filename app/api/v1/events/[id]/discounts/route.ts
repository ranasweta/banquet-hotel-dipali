import type { NextRequest } from 'next/server'
import { z } from 'zod'
import { requirePermission } from '@/lib/auth'
import { ok, route } from '@/lib/api'
import { discountCap, discountSheet, listDiscounts, setLineDiscounts } from '@/lib/discounts'
import { AUTHORITY_ROLES } from '@/lib/post-confirm'

const bodySchema = z.object({
  // One save carries the whole Discounted column, not one cell at a time: the cap is measured on
  // the combination, and a save that crosses it goes to the Authority as ONE request.
  lines: z
    .array(z.object({ key: z.string().min(1).max(200), discounted_paise: z.number().int().min(0) }))
    .min(1)
    .max(200),
  // Optional since 20 Aug 2026 (client). The audit row still names who moved which line to what.
  remark: z.string().trim().max(300).optional(),
})

/**
 * GET /events/:id/discounts — the Actual | Discounted sheet: every priced line with what it
 * lists at and what is being charged for it, the rooms tax on each, and the totals both columns
 * add up to. Plus the surviving pre-20-Aug lump rows, and the cap.
 *
 * The sheet is built server-side and rendered as-is. No screen recomputes it: once the room GST
 * band is decided by the DISCOUNTED nightly rate, a client-side copy of the arithmetic is a
 * counter and a bill quietly disagreeing about what the guest owes.
 *
 * `capPct` and `uncapped` are here so the screen can state the rule it is actually under: the
 * cap is a setting, not the constant 10 the copy used to hardcode, and it does not bind the
 * Higher Authority at all (FR-11.3a). Telling him his discount goes to the GM for approval,
 * when he IS the GM and it takes effect at once, is the kind of small lie that costs a phone call.
 */
export const GET = route(async (_req: NextRequest, ctx: { params: Promise<{ id: string }> }) => {
  const actor = await requirePermission('billing', 'view')
  const { id } = await ctx.params
  const [sheet, lumpDiscounts, cap] = await Promise.all([discountSheet(id), listDiscounts(id), discountCap(id)])
  return ok({
    sheet,
    lumpDiscounts,
    cap,
    capPct: cap.capPct,
    uncapped: AUTHORITY_ROLES.has(actor.roleName),
  })
})

/**
 * PUT /events/:id/discounts — writes the Discounted column. Send a line back at its actual price
 * to clear its discount.
 *
 * 200 when it takes effect; 202 when the combined discount crosses the 10% cap and the whole
 * save is held behind one `discount_over_cap` request for the Higher Authority (BR-D2). PUT, not
 * POST: this sets prices to a state rather than appending another deduction to a ledger, and
 * sending the same column twice must leave the same bill.
 */
export const PUT = route(async (req: NextRequest, ctx: { params: Promise<{ id: string }> }) => {
  const actor = await requirePermission('billing', 'create_edit')
  const { id } = await ctx.params
  const input = bodySchema.parse(await req.json())
  const result = await setLineDiscounts(
    actor,
    id,
    input.lines.map((l) => ({ key: l.key, discountedPaise: l.discounted_paise })),
    input.remark ?? '',
  )
  return ok(result, result.deferred ? 202 : 200)
})
