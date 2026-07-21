import type { NextRequest } from 'next/server'
import { z } from 'zod'
import { requirePermission } from '@/lib/auth'
import { ok, route } from '@/lib/api'
import { createItem } from '@/lib/menu-master'

const bodySchema = z.object({ category_id: z.string().uuid(), name: z.string().min(1).max(120) })

/** POST /menu/master/items — a new dish on a segment. */
export const POST = route(async (req: NextRequest) => {
  const actor = await requirePermission('menu_master', 'create_edit')
  const b = bodySchema.parse(await req.json())
  return ok(await createItem(actor, b.category_id, b.name), 201)
})
