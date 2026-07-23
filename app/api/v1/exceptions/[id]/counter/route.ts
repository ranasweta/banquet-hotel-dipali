import type { NextRequest } from 'next/server'
import { z } from 'zod'
import { requirePermission } from '@/lib/auth'
import { ok, route } from '@/lib/api'
import { raiseCounterChange } from '@/lib/approvals'

const bodySchema = z.object({
  reason: z.string().trim().min(1).max(500),
})

/**
 * POST /exceptions/:id/counter — raise a counter-change against an already-decided approval
 * (tester, 23 Jul 2026). The service enforces Authority/Auditor-only, a mandatory reason, and
 * that the target is settled. It records a new linked exception; it never edits the original or
 * auto-reverses its effect. Returns 201 with the new exception id.
 */
export const POST = route(async (req: NextRequest, ctx: { params: Promise<{ id: string }> }) => {
  const actor = await requirePermission('approvals', 'create_edit')
  const { id } = await ctx.params
  const { reason } = bodySchema.parse(await req.json())
  const result = await raiseCounterChange(actor, id, reason)
  return ok({ counterChange: result }, 201)
})
