import type { NextRequest } from 'next/server'
import { z } from 'zod'
import { requirePermission } from '@/lib/auth'
import { ok, route } from '@/lib/api'
import { decideException } from '@/lib/approvals'

const bodySchema = z.object({
  action: z.enum(['approve', 'reject', 'approve_modified']),
  remark: z.string().max(500).optional(),
  modified: z.record(z.string(), z.unknown()).optional(),
})

/**
 * POST /exceptions/:id/decide — approve / reject / approve-modified. The service enforces
 * Authority-only deciding, a mandatory remark on reject, and applies the deferred change on
 * approval. Returns 200 with the new status and what was applied.
 */
export const POST = route(async (req: NextRequest, ctx: { params: Promise<{ id: string }> }) => {
  const actor = await requirePermission('approvals', 'create_edit')
  const { id } = await ctx.params
  const input = bodySchema.parse(await req.json())
  const result = await decideException(actor, id, input)
  return ok({ decision: result })
})
