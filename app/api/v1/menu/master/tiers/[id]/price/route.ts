import type { NextRequest } from 'next/server'
import { z } from 'zod'
import { requirePermission } from '@/lib/auth'
import { badRequest, ok, route } from '@/lib/api'
import { priceChangeImpact, setTierPrice } from '@/lib/menu-master'

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/

const bodySchema = z.object({
  effective_from: z.string().regex(ISO_DATE),
  base_rate_paise: z.number().int().positive(),
  wedding_surcharge_paise: z.number().int().min(0),
})

/**
 * GET /menu/master/tiers/:id/price?effective_from= — what a re-price would touch, asked
 * BEFORE it is made so the screen can say it out loud. Saved menus are never affected
 * (BR-M1); unsaved future menus on this tier will pick the new rate up.
 */
export const GET = route(async (req: NextRequest, ctx: { params: Promise<{ id: string }> }) => {
  await requirePermission('menu_master', 'view')
  const { id } = await ctx.params
  const from = new URL(req.url).searchParams.get('effective_from')
  if (!from || !ISO_DATE.test(from)) throw badRequest('effective_from must be YYYY-MM-DD')
  return ok(await priceChangeImpact(id, from))
})

/**
 * PUT /menu/master/tiers/:id/price — records a per-plate rate effective from a date.
 *
 * A new date is a NEW ROW, never an edit to the old one: what a tier cost last March stays
 * on record, so last March's bill can still be explained. Re-sending an existing date
 * corrects that row, which is why the screen only offers today and later.
 */
export const PUT = route(async (req: NextRequest, ctx: { params: Promise<{ id: string }> }) => {
  const actor = await requirePermission('menu_master', 'create_edit')
  const { id } = await ctx.params
  const b = bodySchema.parse(await req.json())
  await setTierPrice(actor, id, {
    effectiveFrom: b.effective_from,
    baseRatePaise: b.base_rate_paise,
    weddingSurchargePaise: b.wedding_surcharge_paise,
  })
  return ok({ ok: true })
})
