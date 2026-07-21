import type { NextRequest } from 'next/server'
import { z } from 'zod'
import { requirePermission } from '@/lib/auth'
import { ok, route } from '@/lib/api'
import { createCategory } from '@/lib/menu-master'

const bodySchema = z.object({
  tier_id: z.string().uuid(),
  name: z.string().min(1).max(80),
  // null = every dish is included; the picker renders it read-only and it counts complete.
  pick_count: z.number().int().positive().nullable(),
  free_increase_eligible: z.boolean().default(false),
  sort_order: z.number().int().min(0).default(0),
})

/** POST /menu/master/categories — a new segment on a tier's printed card. */
export const POST = route(async (req: NextRequest) => {
  const actor = await requirePermission('menu_master', 'create_edit')
  const b = bodySchema.parse(await req.json())
  return ok(
    await createCategory(actor, b.tier_id, {
      name: b.name,
      pickCount: b.pick_count,
      freeIncreaseEligible: b.free_increase_eligible,
      sortOrder: b.sort_order,
    }),
    201,
  )
})
