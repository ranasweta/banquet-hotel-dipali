import type { NextRequest } from 'next/server'
import { z } from 'zod'
import { requirePermission } from '@/lib/auth'
import { ok, route } from '@/lib/api'
import { renameTier } from '@/lib/menu-master'

const bodySchema = z.object({ name: z.string().min(1).max(80) })

/**
 * PUT /menu/master/tiers/:id — rename a tier.
 *
 * Does not reach saved menus: each carries its own `tier_name` snapshot, so an event booked
 * as "Silver" still reads "Silver" on its bill however the catalog is relabelled afterwards.
 */
export const PUT = route(async (req: NextRequest, ctx: { params: Promise<{ id: string }> }) => {
  const actor = await requirePermission('menu_master', 'create_edit')
  const { id } = await ctx.params
  const { name } = bodySchema.parse(await req.json())
  await renameTier(actor, id, name)
  return ok({ ok: true })
})
