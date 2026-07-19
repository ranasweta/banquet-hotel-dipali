import type { NextRequest } from 'next/server'
import { z } from 'zod'
import { requirePermission } from '@/lib/auth'
import { badRequest, ok, route } from '@/lib/api'
import { priceDelicacy } from '@/lib/chef'

const priceSchema = z
  .object({
    // Per-plate addition in paise (money is paise everywhere — CLAUDE.md rule 1).
    charge_paise: z.number().int().min(0).optional(),
    decline: z.boolean().optional(),
    remark: z.string().max(300).optional(),
  })
  .refine((v) => v.decline === true || v.charge_paise != null, {
    message: 'Give a per-plate charge, or decline the request',
  })

/**
 * POST /chef-requests/:id/price — the Chef sets the per-plate charge (or declines).
 * The service enforces that only the Chef may price, and recomputes the proposal total.
 */
export const POST = route(async (req: NextRequest, ctx: { params: Promise<{ id: string }> }) => {
  const actor = await requirePermission('menus', 'view')
  const { id } = await ctx.params
  const parsed = priceSchema.safeParse(await req.json())
  if (!parsed.success) throw badRequest(parsed.error.issues[0]?.message ?? 'Invalid request')

  const result = await priceDelicacy(actor, id, {
    chargePaise: parsed.data.charge_paise,
    decline: parsed.data.decline,
    remark: parsed.data.remark,
  })
  return ok({ request: result })
})
