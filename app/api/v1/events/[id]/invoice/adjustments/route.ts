import type { NextRequest } from 'next/server'
import { z } from 'zod'
import { requirePermission } from '@/lib/auth'
import { ok, route } from '@/lib/api'
import { setAdjustments } from '@/lib/invoice'

const putSchema = z.object({
  adjustments: z
    .array(z.object({ description: z.string().trim().min(1).max(160), amount_paise: z.number().int(), gst_rate_bp: z.number().int().min(0).max(10000).optional(), remark: z.string().trim().min(1).max(200) }))
    .max(50),
})

/** PUT /events/:id/invoice/adjustments — replace the Auditor's adjustment lines (FR-7.4). */
export const PUT = route(async (req: NextRequest, ctx: { params: Promise<{ id: string }> }) => {
  const actor = await requirePermission('billing', 'create_edit')
  const { id } = await ctx.params
  const { adjustments } = putSchema.parse(await req.json())
  await setAdjustments(actor, id, adjustments.map((a) => ({ description: a.description, amountPaise: a.amount_paise, gstRateBp: a.gst_rate_bp, remark: a.remark })))
  return ok({ ok: true })
})
