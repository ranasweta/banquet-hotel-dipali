import type { NextRequest } from 'next/server'
import { z } from 'zod'
import { requirePermission } from '@/lib/auth'
import { ok, route } from '@/lib/api'
import { decideChange } from '@/lib/change-requests'

const bodySchema = z.object({ action: z.enum(['approve', 'reject']), remark: z.string().max(500).optional() })

/**
 * POST /change-requests/:id/decide — Banquet Manager approves/rejects. Approval re-books the
 * venue slot (409 if the slot was taken meanwhile); reject needs a remark. Gated on calendar
 * create_edit — only the Banquet Manager and Auditor hold it.
 */
export const POST = route(async (req: NextRequest, ctx: { params: Promise<{ id: string }> }) => {
  const actor = await requirePermission('calendar', 'create_edit')
  const { id } = await ctx.params
  const input = bodySchema.parse(await req.json())
  const result = await decideChange(actor, id, input)
  return ok({ decision: result })
})
