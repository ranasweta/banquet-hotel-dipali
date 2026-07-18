import type { NextRequest } from 'next/server'
import { z } from 'zod'
import { requirePermission } from '@/lib/auth'
import { ok, route } from '@/lib/api'
import { getSubEventMenu, saveSubEventMenu } from '@/lib/menus'

/** GET /sub-events/:id/menu — the sub-event's saved menu snapshot + completion state. */
export const GET = route(async (_req: NextRequest, ctx: { params: Promise<{ id: string }> }) => {
  await requirePermission('menus', 'view')
  const { id } = await ctx.params
  const data = await getSubEventMenu(id)
  return ok(data)
})

const saveSchema = z.object({
  tier_id: z.uuid(),
  is_tentative: z.boolean().optional(),
  // categoryName -> chosen item names. Server validates against the tier master.
  selections: z.record(z.string().min(1), z.array(z.string().min(1))).default({}),
})

/**
 * PUT /sub-events/:id/menu — save tier + selections (tentative allowed). Applies the
 * wedding surcharge and enforces pick-counts; an incomplete menu is accepted (FR-3.2).
 */
export const PUT = route(async (req: NextRequest, ctx: { params: Promise<{ id: string }> }) => {
  const actor = await requirePermission('menus', 'create_edit')
  const { id } = await ctx.params
  const input = saveSchema.parse(await req.json())
  const result = await saveSubEventMenu(actor, id, {
    tierId: input.tier_id,
    isTentative: input.is_tentative,
    selections: input.selections,
  })
  return ok({ menu: result })
})
