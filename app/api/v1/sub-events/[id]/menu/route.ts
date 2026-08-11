import type { NextRequest } from 'next/server'
import { z } from 'zod'
import { requirePermission } from '@/lib/auth'
import { ok, route } from '@/lib/api'
import { getSubEventMenu, saveSubEventMenu, getIncreaseSummary } from '@/lib/menus'

/** GET /sub-events/:id/menu — the sub-event's saved menu snapshot + completion state. */
export const GET = route(async (_req: NextRequest, ctx: { params: Promise<{ id: string }> }) => {
  await requirePermission('menus', 'view')
  const { id } = await ctx.params
  const data = await getSubEventMenu(id)
  return ok(data)
})

const saveSchema = z.object({
  tier_id: z.uuid(),
  is_tentative: z.boolean().optional(),
  // categoryName -> chosen item names. Server validates against the pooled master menu.
  selections: z.record(z.string().min(1), z.array(z.string().min(1))).default({}),
  // categoryName -> itemName -> preference note ("dal spicy"). Never affects price.
  notes: z.record(z.string().min(1), z.record(z.string().min(1), z.string().max(200))).optional(),
})

/**
 * PUT /sub-events/:id/menu — save tier + selections (tentative allowed). Applies the
 * wedding surcharge and enforces pick-counts; an incomplete menu is accepted (FR-3.2).
 *
 * RETURNS THE WHOLE STATE, not just the save's own result. The picker used to save and then
 * fetch the snapshot and the increase summary back in two more calls — three client round
 * trips for one click, and a phone in Sagar talking to a container in Singapore pays for each
 * of them. The server is already holding the connection and is far closer to the database
 * than the phone is, so it reads them here instead. Same queries, a third of the waiting.
 */
export const PUT = route(async (req: NextRequest, ctx: { params: Promise<{ id: string }> }) => {
  const actor = await requirePermission('menus', 'create_edit')
  const { id } = await ctx.params
  const input = saveSchema.parse(await req.json())
  const result = await saveSubEventMenu(actor, id, {
    tierId: input.tier_id,
    isTentative: input.is_tentative,
    selections: input.selections,
    notes: input.notes,
  })
  // After the write, so both reflect it. In parallel — they are independent, and sequentially
  // they would hand back the latency this change exists to remove.
  const [snapshot, increases] = await Promise.all([
    getSubEventMenu(id),
    getIncreaseSummary(id),
  ])
  return ok({
    menu: result,
    snapshot,
    increases: increases ?? { subEventId: id, totalExtras: 0, awaitingSubmission: 0, segments: [] },
  })
})
