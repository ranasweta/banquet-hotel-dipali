import type { NextRequest } from 'next/server'
import { z } from 'zod'
import { requirePermission } from '@/lib/auth'
import { ok, route } from '@/lib/api'
import { recordPayment } from '@/lib/payments'
import { todayISO } from '@/lib/time'

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/
const bodySchema = z.object({
  kind: z.enum(['part_payment', 'settlement', 'refund']),
  amount_paise: z.number().int().positive(),
  mode: z.enum(['cash', 'upi', 'bank', 'cheque']),
  receipt_no: z.string().trim().min(1).max(60),
  received_on: z
    .string()
    .regex(ISO_DATE)
    .refine((d) => d <= todayISO(), { message: 'The received-on date cannot be in the future' }),
  note: z.string().max(300).optional(),
})

/** POST /events/:id/payments — record a part-payment / settlement / refund (FR-7.7). */
export const POST = route(async (req: NextRequest, ctx: { params: Promise<{ id: string }> }) => {
  const actor = await requirePermission('billing', 'create_edit')
  const { id } = await ctx.params
  const input = bodySchema.parse(await req.json())
  const result = await recordPayment(actor, id, {
    kind: input.kind,
    amountPaise: input.amount_paise,
    mode: input.mode,
    receiptNo: input.receipt_no,
    receivedOn: input.received_on,
    note: input.note,
  })
  return ok({ payment: result }, 201)
})
