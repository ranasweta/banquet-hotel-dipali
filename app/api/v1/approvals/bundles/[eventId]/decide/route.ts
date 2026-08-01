import type { NextRequest } from 'next/server'
import { z } from 'zod'
import { requirePermission } from '@/lib/auth'
import { ok, route } from '@/lib/api'
import { decideBundle } from '@/lib/approval-bundles'

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/
const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/

const decisionSchema = z.object({
  id: z.string().uuid(),
  source: z.enum(['exception', 'change_request']),
  action: z.enum(['approve', 'reject', 'approve_modified']),
  remark: z.string().max(500).optional(),
  modified: z.record(z.string(), z.unknown()).optional(),
})

const functionEditSchema = z.object({
  id: z.string().uuid(),
  name: z.string().min(1).max(120).optional(),
  eventDate: z.string().regex(ISO_DATE).optional(),
  startTime: z.string().regex(HHMM).optional(),
  endTime: z.string().regex(HHMM).optional(),
  venueId: z.string().uuid().nullable().optional(),
  bundleId: z.string().uuid().nullable().optional(),
  pax: z.number().int().positive().optional(),
})

const menuEditSchema = z.object({
  subEventId: z.string().uuid(),
  categoryName: z.string().min(1),
  dishes: z.array(z.string().min(1)).max(100),
})

const roomEditSchema = z.object({
  unitId: z.string().uuid(),
  roomType: z.string().min(1),
  count: z.number().int().positive(),
  checkIn: z.string().regex(ISO_DATE),
  checkOut: z.string().regex(ISO_DATE),
})

// Money stays BIGINT paise on the wire (CLAUDE.md rule 1) — the UI formats rupees, it never
// sends them. `amountPaise` is the Authority's uncapped rupee discount.
const discountEditSchema = z
  .object({
    head: z.enum(['menu', 'venue', 'room', 'overall']),
    amountPaise: z.number().int().positive().optional(),
    percentBp: z.number().int().positive().max(10_000).optional(),
    remark: z.string().min(1).max(500),
  })
  .refine((d) => (d.amountPaise == null) !== (d.percentBp == null), {
    message: 'give either a rupee amount or a percentage — exactly one',
  })

const editsSchema = z.object({
  event: z
    .object({
      guestName: z.string().min(1).max(160).optional(),
      plannedFrom: z.string().regex(ISO_DATE).nullable().optional(),
      plannedTo: z.string().regex(ISO_DATE).nullable().optional(),
    })
    .optional(),
  functions: z.array(functionEditSchema).max(50).optional(),
  menus: z.array(menuEditSchema).max(200).optional(),
  rooms: z.array(roomEditSchema).max(100).optional(),
  addDiscounts: z.array(discountEditSchema).max(20).optional(),
  removeDiscountIds: z.array(z.string().uuid()).max(20).optional(),
  reason: z.string().max(500).optional(),
})

const bodySchema = z.object({
  decisions: z.array(decisionSchema).max(100).optional(),
  edits: editsSchema.optional(),
  remark: z.string().max(500).optional(),
})

/**
 * POST /approvals/bundles/:eventId/decide — settle every ask on one proposal, and apply the
 * Authority's edits to that proposal, in a single transaction.
 *
 * The service enforces Authority-only deciding, the mandatory remark on a rejection, the
 * mandatory reason for overriding a lock, the lodge inventory cap and the venue exclusion.
 * A 409 means nothing was saved.
 */
export const POST = route(async (req: NextRequest, ctx: { params: Promise<{ eventId: string }> }) => {
  const actor = await requirePermission('approvals', 'create_edit')
  const { eventId } = await ctx.params
  const input = bodySchema.parse(await req.json())
  return ok({ result: await decideBundle(actor, eventId, input) })
})
