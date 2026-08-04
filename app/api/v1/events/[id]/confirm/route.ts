import type { NextRequest } from 'next/server'
import { z } from 'zod'
import { requirePermission } from '@/lib/auth'
import { ok, route } from '@/lib/api'
import { confirmEvent } from '@/lib/confirm'
import { todayISO } from '@/lib/time'

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/

const bodySchema = z
  .object({
    // The advance the Booking Manager attests was received (FR-11.4). Optional because an
    // advance may already be on file; confirm re-checks that SOME money is recorded and
    // reports what is still short of the 25% (client's lead, 4 Aug 2026).
    advance: z
      .object({
        amount_paise: z.number().int().positive(),
        mode: z.enum(['cash', 'upi', 'bank', 'cheque']),
        receipt_no: z.string().trim().min(1).max(60),
        received_on: z
          .string()
          .regex(ISO_DATE)
          .refine((d) => d <= todayISO(), { message: 'The received-on date cannot be in the future' }),
      })
      .optional(),
  })
  .optional()

/** POST /events/:id/confirm — THE atomic confirm transaction (FR-1.7, BR-P1). */
export const POST = route(async (req: NextRequest, ctx: { params: Promise<{ id: string }> }) => {
  const actor = await requirePermission('bookings', 'create_edit')
  const { id } = await ctx.params

  const raw = await req.json().catch(() => ({}))
  const body = bodySchema.parse(raw ?? {})
  const advance = body?.advance
    ? {
        amountPaise: body.advance.amount_paise,
        mode: body.advance.mode,
        receiptNo: body.advance.receipt_no,
        receivedOn: body.advance.received_on,
      }
    : undefined

  const result = await confirmEvent(actor, id, advance)
  return ok({
    event: {
      id: result.id,
      code: result.code,
      status: 'confirmed',
      proposalTotalPaise: result.proposalTotalPaise,
      // > 0 when the dates were held on a part payment. The screen says so rather than
      // letting a partially-locked booking look like any other.
      advanceShortfallPaise: result.advanceShortfallPaise,
      advanceRequiredPaise: result.advanceRequiredPaise,
    },
  })
})
