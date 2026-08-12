import type { NextRequest } from 'next/server'
import { z } from 'zod'
import { requirePermission } from '@/lib/auth'
import { ok, route } from '@/lib/api'
import { brandUsage, updateBrand } from '@/lib/bar'

/** GET /menu/master/bar-brands/:id — what a re-price would touch (nothing already ordered). */
export const GET = route(async (_req: NextRequest, ctx: { params: Promise<{ id: string }> }) => {
  await requirePermission('menu_master', 'view')
  const { id } = await ctx.params
  return ok(await brandUsage(id))
})

const patchSchema = z.object({
  name: z.string().min(1).max(120).optional(),
  price_per_bottle_paise: z.number().int().positive().optional(),
  is_active: z.boolean().optional(),
})

/** PUT /menu/master/bar-brands/:id — rename, re-price, retire or restore a brand. */
export const PUT = route(async (req: NextRequest, ctx: { params: Promise<{ id: string }> }) => {
  const actor = await requirePermission('menu_master', 'create_edit')
  const { id } = await ctx.params
  const b = patchSchema.parse(await req.json())
  await updateBrand(actor, id, {
    name: b.name,
    pricePerBottlePaise: b.price_per_bottle_paise,
    isActive: b.is_active,
  })
  return ok({ ok: true })
})
