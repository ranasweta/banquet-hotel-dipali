import type { NextRequest } from 'next/server'
import { z } from 'zod'
import { requirePermission } from '@/lib/auth'
import { ok, route } from '@/lib/api'
import { createBrand, listBrands } from '@/lib/bar'

/** GET /menu/master/bar-brands — the bar list, retired brands included. */
export const GET = route(async () => {
  await requirePermission('menu_master', 'view')
  return ok({ brands: await listBrands() })
})

const bodySchema = z.object({
  name: z.string().min(1).max(120),
  price_per_bottle_paise: z.number().int().positive(),
})

/** POST /menu/master/bar-brands — a new brand and what a bottle costs. */
export const POST = route(async (req: NextRequest) => {
  const actor = await requirePermission('menu_master', 'create_edit')
  const b = bodySchema.parse(await req.json())
  return ok(await createBrand(actor, { name: b.name, pricePerBottlePaise: b.price_per_bottle_paise }), 201)
})
