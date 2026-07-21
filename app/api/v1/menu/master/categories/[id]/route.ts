import type { NextRequest } from 'next/server'
import { z } from 'zod'
import { requirePermission } from '@/lib/auth'
import { ok, route } from '@/lib/api'
import { deleteCategory, updateCategory } from '@/lib/menu-master'

const bodySchema = z.object({
  name: z.string().min(1).max(80),
  pick_count: z.number().int().positive().nullable(),
  free_increase_eligible: z.boolean(),
  sort_order: z.number().int().min(0),
})

/**
 * PUT /menu/master/categories/:id — rename a segment, change how many dishes it allows, or
 * move it up the card.
 *
 * Saved menus keep the pick-count they were saved with: `sub_event_menu_categories` holds
 * its own `base_pick`. This governs menus saved from now on.
 */
export const PUT = route(async (req: NextRequest, ctx: { params: Promise<{ id: string }> }) => {
  const actor = await requirePermission('menu_master', 'create_edit')
  const { id } = await ctx.params
  const b = bodySchema.parse(await req.json())
  await updateCategory(actor, id, {
    name: b.name,
    pickCount: b.pick_count,
    freeIncreaseEligible: b.free_increase_eligible,
    sortOrder: b.sort_order,
  })
  return ok({ ok: true })
})

/**
 * DELETE /menu/master/categories/:id — removes a segment and the dishes on it.
 *
 * Booked menus are untouched (they snapshot by name), but the dishes leave the pooled Swap
 * list other tiers draw on, and there is no undo — hence `delete`, not `create_edit`.
 */
export const DELETE = route(async (_req: NextRequest, ctx: { params: Promise<{ id: string }> }) => {
  const actor = await requirePermission('menu_master', 'delete')
  const { id } = await ctx.params
  await deleteCategory(actor, id)
  return ok({ ok: true })
})
