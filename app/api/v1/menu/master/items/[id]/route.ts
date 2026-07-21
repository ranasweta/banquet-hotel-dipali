import type { NextRequest } from 'next/server'
import { z } from 'zod'
import { requirePermission } from '@/lib/auth'
import { ok, route } from '@/lib/api'
import { updateItem } from '@/lib/menu-master'

const bodySchema = z
  .object({ name: z.string().min(1).max(120).optional(), is_active: z.boolean().optional() })
  .refine((b) => b.name !== undefined || b.is_active !== undefined, {
    message: 'Send a name, an is_active, or both',
  })

/**
 * PUT /menu/master/items/:id — rename a dish, retire it, or bring it back.
 *
 * Retiring rather than deleting: snapshots copy dishes by NAME so a delete would not corrupt
 * a booked menu, but it would erase the dish from every tier's pooled Swap list with no way
 * back. `is_active = false` hides it from the picker and leaves the record intact.
 */
export const PUT = route(async (req: NextRequest, ctx: { params: Promise<{ id: string }> }) => {
  const actor = await requirePermission('menu_master', 'create_edit')
  const { id } = await ctx.params
  const b = bodySchema.parse(await req.json())
  await updateItem(actor, id, { name: b.name, isActive: b.is_active })
  return ok({ ok: true })
})
