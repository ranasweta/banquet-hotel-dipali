import 'server-only'
import { eq } from 'drizzle-orm'
import { db, schema } from '@/db/drizzle'
import { audit, type Actor } from '@/lib/audit'
import { badRequest, conflict, notFound } from '@/lib/api'
import { effectiveDiscountPaise } from '@/lib/discounts'

/**
 * Payment ledger (M7, FR-7.7, FR-11.4). Part-payments of any amount are recorded as they
 * arrive with a unique internal receipt number; the event shows running paid-vs-balance.
 * Payments are exempt from the lock guard (settlement arrives after lock, per schema).
 */

const UNIQUE_VIOLATION = '23505'
const RECORDABLE = new Set(['confirmed', 'in_progress', 'completed', 'locked', 'billed'])
const PAYMENT_KINDS = new Set(['advance_block', 'part_payment', 'settlement', 'refund'])

function pgCode(err: unknown): string | undefined {
  let cur: unknown = err
  for (let i = 0; i < 5 && cur && typeof cur === 'object'; i++) {
    if ('code' in cur && typeof (cur as { code: unknown }).code === 'string') return (cur as { code: string }).code
    cur = (cur as { cause?: unknown }).cause
  }
  return undefined
}

export type PaymentInput = {
  kind: string
  amountPaise: number
  mode: string
  receiptNo: string
  receivedOn: string
  note?: string
}

/** Records a payment (or refund) against an event; the receipt number must be unique. */
export async function recordPayment(actor: Actor, eventId: string, input: PaymentInput): Promise<{ id: string }> {
  if (!PAYMENT_KINDS.has(input.kind)) throw badRequest('Unknown payment kind')
  if (input.amountPaise <= 0) throw badRequest('Amount must be positive')

  const [ev] = await db.select({ status: schema.events.status }).from(schema.events).where(eq(schema.events.id, eventId)).limit(1)
  if (!ev) throw notFound('Event not found')
  if (!RECORDABLE.has(ev.status)) throw badRequest('Payments are recorded once the booking is confirmed.')

  try {
    const [row] = await db
      .insert(schema.payments)
      .values({
        eventId,
        kind: input.kind as 'part_payment',
        amountPaise: input.amountPaise,
        mode: input.mode,
        receiptNo: input.receiptNo,
        receivedOn: input.receivedOn,
        recordedBy: actor.id,
        note: input.note ?? null,
      })
      .returning({ id: schema.payments.id })
    await audit(db, actor, {
      entity: 'payments',
      entityId: row!.id,
      eventId,
      action: 'insert',
      field: input.kind,
      newValue: `${input.amountPaise} (${input.receiptNo})`,
    })
    return { id: row!.id }
  } catch (err) {
    if (pgCode(err) === UNIQUE_VIOLATION) throw conflict(`Receipt number ${input.receiptNo} is already recorded.`)
    throw err
  }
}

export type Ledger = {
  proposalTotalPaise: number
  discountPaise: number
  netBillPaise: number
  paidPaise: number
  balancePaise: number
  payments: { id: string; kind: string; amountPaise: number; mode: string; receiptNo: string; receivedOn: string; note: string | null }[]
}

/**
 * The running ledger: proposal − effective discounts = net bill; payments net of refunds =
 * paid; balance = net bill − paid. (GST and line-level billing arrive with the invoice in M9.)
 */
export async function getLedger(eventId: string): Promise<Ledger> {
  const [ev] = await db
    .select({ proposalTotalPaise: schema.events.proposalTotalPaise })
    .from(schema.events)
    .where(eq(schema.events.id, eventId))
    .limit(1)
  if (!ev) throw notFound('Event not found')

  const discountPaise = await effectiveDiscountPaise(eventId)
  const rows = await db
    .select({
      id: schema.payments.id,
      kind: schema.payments.kind,
      amountPaise: schema.payments.amountPaise,
      mode: schema.payments.mode,
      receiptNo: schema.payments.receiptNo,
      receivedOn: schema.payments.receivedOn,
      note: schema.payments.note,
    })
    .from(schema.payments)
    .where(eq(schema.payments.eventId, eventId))
    .orderBy(schema.payments.receivedOn)

  const paidPaise = rows.reduce((s, p) => s + (p.kind === 'refund' ? -p.amountPaise : p.amountPaise), 0)
  const netBillPaise = ev.proposalTotalPaise - discountPaise
  return {
    proposalTotalPaise: ev.proposalTotalPaise,
    discountPaise,
    netBillPaise,
    paidPaise,
    balancePaise: netBillPaise - paidPaise,
    payments: rows,
  }
}
