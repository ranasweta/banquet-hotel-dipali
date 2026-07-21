import type { NextRequest } from 'next/server'
import { z } from 'zod'
import { requirePermission } from '@/lib/auth'
import { ok, route } from '@/lib/api'
import { createTier } from '@/lib/menu-master'

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/

const bodySchema = z.object({
  name: z.string().min(1).max(80),
  effective_from: z.string().regex(ISO_DATE),
  base_rate_paise: z.number().int().positive(),
  wedding_surcharge_paise: z.number().int().min(0).optional(),
})

/**
 * POST /menu/master/tiers — a new tier and its opening per-plate rate.
 *
 * The rate is part of creating one, not a second step: a tier with no price cannot be saved
 * onto a sub-event at all (lib/menus.ts refuses it), so a priceless tier would show up in
 * the picker and then fail on save.
 */
export const POST = route(async (req: NextRequest) => {
  const actor = await requirePermission('menu_master', 'create_edit')
  const b = bodySchema.parse(await req.json())
  return ok(
    await createTier(actor, {
      name: b.name,
      effectiveFrom: b.effective_from,
      baseRatePaise: b.base_rate_paise,
      weddingSurchargePaise: b.wedding_surcharge_paise,
    }),
    201,
  )
})
