import type { NextRequest } from 'next/server'
import { z } from 'zod'
import { requirePermission } from '@/lib/auth'
import { ok, route } from '@/lib/api'
import { getSubEventBar, listActiveBrands, setBarLine } from '@/lib/bar'

/**
 * GET /sub-events/:id/bar — the bottles ordered for this function, plus the brands that can
 * still be ordered.
 *
 * The dropdown ships with the lines rather than from its own endpoint: the Alcohol panel needs
 * both the moment it opens, and a phone on the hotel's connection pays for every round trip.
 */
export const GET = route(async (_req: NextRequest, ctx: { params: Promise<{ id: string }> }) => {
  await requirePermission('menus', 'view')
  const { id } = await ctx.params
  const [lines, brands] = await Promise.all([getSubEventBar(id), listActiveBrands()])
  return ok({ lines, brands })
})

const bodySchema = z.object({
  brand_id: z.uuid(),
  // A count, not a limit — the hotel stocks what it stocks (cf. rule 13 on pax).
  bottles: z.number().int().positive(),
})

/**
 * PUT /sub-events/:id/bar — order bottles of a brand for this function.
 *
 * Idempotent per brand: sending it again REPLACES the count. Two lines of the same whisky on
 * one bill is a number nobody can reconcile against what was actually ordered.
 */
export const PUT = route(async (req: NextRequest, ctx: { params: Promise<{ id: string }> }) => {
  const actor = await requirePermission('menus', 'create_edit')
  const { id } = await ctx.params
  const b = bodySchema.parse(await req.json())
  await setBarLine(actor, id, { brandId: b.brand_id, bottles: b.bottles })
  const [lines, brands] = await Promise.all([getSubEventBar(id), listActiveBrands()])
  return ok({ lines, brands })
})
