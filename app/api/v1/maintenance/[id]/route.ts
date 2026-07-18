import type { NextRequest } from 'next/server'
import { z } from 'zod'
import { requirePermission } from '@/lib/auth'
import { ok, route } from '@/lib/api'
import { deleteEntry, updateEntry } from '@/lib/maintenance'

const patchSchema = z.object({
  item: z.string().trim().min(1).max(120).optional(),
  qty: z.number().positive().max(1_000_000).optional(),
  unit: z.string().trim().min(1).max(20).optional(),
  rate_paise: z.number().int().nonnegative().optional(),
  remarks: z.string().max(300).optional(),
})

/** PUT /maintenance/:id — edit an entry (author or Auditor, before close). */
export const PUT = route(async (req: NextRequest, ctx: { params: Promise<{ id: string }> }) => {
  const actor = await requirePermission('maintenance', 'create_edit')
  const { id } = await ctx.params
  const p = patchSchema.parse(await req.json())
  await updateEntry(actor, id, { item: p.item, qty: p.qty, unit: p.unit, ratePaise: p.rate_paise, remarks: p.remarks })
  return ok({ ok: true })
})

/** DELETE /maintenance/:id — remove an entry (author or Auditor, before close). */
export const DELETE = route(async (_req: NextRequest, ctx: { params: Promise<{ id: string }> }) => {
  const actor = await requirePermission('maintenance', 'create_edit')
  const { id } = await ctx.params
  await deleteEntry(actor, id)
  return ok({ ok: true })
})
