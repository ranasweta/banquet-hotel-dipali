import type { NextRequest } from 'next/server'
import { z } from 'zod'
import { requirePermission } from '@/lib/auth'
import { ok, route } from '@/lib/api'
import { renameTier, setTierSharesVenue } from '@/lib/menu-master'

const bodySchema = z.object({
  name: z.string().min(1).max(80).optional(),
  /** BR-C1: a function on this tier may overlap its own booking's others in one venue. */
  shares_venue: z.boolean().optional(),
})

/**
 * PUT /menu/master/tiers/:id — rename a tier, or set whether it shares a venue.
 *
 * Neither reaches saved menus: each carries its own `tier_name` snapshot, so an event booked
 * as "Silver" still reads "Silver" on its bill however the catalog is relabelled afterwards,
 * and a venue hold carries its own copy of the sharing flag (migration 0038).
 */
export const PUT = route(async (req: NextRequest, ctx: { params: Promise<{ id: string }> }) => {
  const actor = await requirePermission('menu_master', 'create_edit')
  const { id } = await ctx.params
  const body = bodySchema.parse(await req.json())
  if (body.name !== undefined) await renameTier(actor, id, body.name)
  if (body.shares_venue !== undefined) await setTierSharesVenue(actor, id, body.shares_venue)
  return ok({ ok: true })
})
