import type { NextRequest } from 'next/server'
import { z } from 'zod'
import { requirePermission } from '@/lib/auth'
import { ok, route } from '@/lib/api'
import { addAddon } from '@/lib/menus'

const bodySchema = z.object({
  description: z.string().trim().min(1).max(200),
  rate_paise: z.number().int().nonnegative(),
  qty: z.number().int().positive().max(100000).default(1),
})

/** POST /sub-events/:id/addons — an item outside the tier (paan counter, extra live counter). */
export const POST = route(async (req: NextRequest, ctx: { params: Promise<{ id: string }> }) => {
  const actor = await requirePermission('menus', 'create_edit')
  const { id } = await ctx.params
  const input = bodySchema.parse(await req.json())
  const result = await addAddon(actor, id, {
    description: input.description,
    ratePaise: input.rate_paise,
    qty: input.qty,
  })
  return ok({ addon: result }, 201)
})
