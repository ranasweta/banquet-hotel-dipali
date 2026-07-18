import type { NextRequest } from 'next/server'
import { requirePermission } from '@/lib/auth'
import { badRequest, ok, route } from '@/lib/api'
import { REPORTS } from '@/lib/reports'

/** GET /reports/:kind — one of the six management reports (PRD §7). Audit-gated (management). */
export const GET = route(async (_req: NextRequest, ctx: { params: Promise<{ kind: string }> }) => {
  await requirePermission('audit', 'view')
  const { kind } = await ctx.params
  const fn = REPORTS[kind]
  if (!fn) throw badRequest(`Unknown report. Choose: ${Object.keys(REPORTS).join(', ')}`)
  return ok({ kind, data: await fn() })
})
