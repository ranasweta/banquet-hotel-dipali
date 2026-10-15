import 'server-only'
import { eq } from 'drizzle-orm'
import { db, schema } from '@/db/drizzle'
import { audit, type Actor } from '@/lib/audit'
import { badRequest, conflict, notFound } from '@/lib/api'
import { shownTaxPaise } from '@/lib/invoice'
import { paymentSchedule, type Milestone } from '@/lib/payment-schedule'
import { listEntries as maintenanceLog } from '@/lib/maintenance'
import { getLodgeExtras } from '@/lib/lodge-extras'
import { getUtensilExtras } from '@/lib/utensils'

/**
 * Payment ledger (M7, FR-7.7, FR-11.4). Part-payments of any amount are recorded as they
 * arrive with a unique internal receipt number; the event shows running paid-vs-balance and
 * the milestones behind it. Payments are exempt from the lock guard (settlement arrives after
 * lock, per schema).
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

/**
 * One team's after-the-event log, open or closed (client, 15 Oct 2026: "the maintenance and
 * plates and lodging logs are not working … not reflecting in ledger"). They were reaching the
 * bill exactly as designed — on the close — but an OPEN log was invisible here, so a logged
 * charge looked lost. Listed with its status, it can be chased instead.
 */
export type LoggedCharge = {
  key: 'maintenance' | 'lodge' | 'plates'
  label: string
  /** Who presses the close that puts it on the bill. */
  closedBy: string
  entryCount: number
  totalPaise: number
  /** Closed means it is inside `payablePaise`; open means it is not, yet. */
  closed: boolean
}

export type Ledger = {
  /** Venue + food + add-ons. */
  proposalTotalPaise: number
  roomsPaise: number
  roomsTaxPaise: number
  discountPaise: number
  givenDiscountPaise: number
  /** Closed maintenance, billed and now inside the payable (client, 11 Aug 2026). */
  maintenancePaise: number
  /** The Lodge Manager's closed extras: extra rooms, the 5% on them, and in-room dining. */
  lodgeExtrasPaise: number
  /** The Utensil Manager's closed plates, priced at each function's own per-plate rate. */
  extraPlatesPaise: number
  /**
   * Everything actually collectable: proposal + rooms + the 5% + maintenance + the lodge
   * extras, less discounts.
   */
  payablePaise: number
  /** The 18% the documents print and nobody pays — shown so the two can be reconciled. */
  shownGstPaise: number
  displayTotalPaise: number
  paidPaise: number
  balancePaise: number
  /** What is due, when, and what is short — the panel a reopened proposal is read from. */
  milestones: Milestone[]
  payments: { id: string; kind: string; amountPaise: number; mode: string; receiptNo: string; receivedOn: string; note: string | null }[]
  /** Only the logs with something in them. */
  loggedCharges: LoggedCharge[]
}

/**
 * The running ledger, and the instalments behind it (client's lead, 4 Aug 2026: "payment logs
 * should be maintained so that whenever they reopen the proposal they can get how much is due").
 *
 * It used to measure `proposal_total_paise − discounts`, which is venue+food only — so every
 * booking with lodging under-stated its balance by the entire room charge, and a guest could be
 * told they were square while owing for thirty rooms. Both the balance and the milestones now
 * come from `lib/payment-schedule.ts`, which is also what confirm and the reminders read.
 */
export async function getLedger(eventId: string): Promise<Ledger> {
  const [ev] = await db.select({ id: schema.events.id }).from(schema.events).where(eq(schema.events.id, eventId)).limit(1)
  if (!ev) throw notFound('Event not found')

  const [schedule, shownGstPaise, maintenance, lodge, plates, rows] = await Promise.all([
    paymentSchedule(eventId),
    shownTaxPaise(eventId),
    maintenanceLog(eventId),
    getLodgeExtras(eventId),
    getUtensilExtras(eventId),
    db
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
      .orderBy(schema.payments.receivedOn),
  ])

  return {
    proposalTotalPaise: schedule.proposalPaise,
    roomsPaise: schedule.roomsPaise,
    roomsTaxPaise: schedule.roomsTaxPaise,
    maintenancePaise: schedule.maintenancePaise,
    lodgeExtrasPaise:
      schedule.extraRoomsPaise + schedule.extraRoomsTaxPaise + schedule.inRoomDiningPaise,
    extraPlatesPaise: schedule.extraPlatesPaise,
    discountPaise: schedule.discountPaise,
    // What the guest was given, lines included — the figure the panel's Discounts tile shows.
    givenDiscountPaise: schedule.givenDiscountPaise,
    payablePaise: schedule.payablePaise,
    shownGstPaise,
    displayTotalPaise: schedule.payablePaise + shownGstPaise,
    paidPaise: schedule.paidPaise,
    balancePaise: schedule.balancePaise,
    milestones: schedule.milestones,
    payments: rows,
    // Each total is the team's own panel figure, so this list and their screen cannot differ.
    loggedCharges: ([
      { key: 'maintenance', label: 'Maintenance', closedBy: 'the Maintenance team', entryCount: maintenance.entries.length, totalPaise: maintenance.totalPaise, closed: maintenance.closed },
      { key: 'lodge', label: 'Lodge extras', closedBy: 'the Lodge Manager', entryCount: lodge.rooms.length + (lodge.inRoomDiningPaise > 0 ? 1 : 0), totalPaise: lodge.totalPaise, closed: lodge.closed },
      { key: 'plates', label: 'Extra plates', closedBy: 'the Utensil Manager', entryCount: plates.entries.length, totalPaise: plates.totalPaise, closed: plates.closed },
    ] satisfies LoggedCharge[]).filter((c) => c.entryCount > 0),
  }
}
