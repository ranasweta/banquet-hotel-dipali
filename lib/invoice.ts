import 'server-only'
import { asc, eq, sql } from 'drizzle-orm'
import { db, schema } from '@/db/drizzle'
import { audit, type Actor } from '@/lib/audit'
import { badRequest, conflict, forbidden, notFound } from '@/lib/api'
import { effectiveDiscountPaise } from '@/lib/discounts'
import { transitionEvent } from '@/lib/events'

/**
 * Consolidated invoice (M9, FR-7.3/7.4). Drafted from LOCKED data — venue rate-card
 * snapshots, food (pax × snapshotted per-plate) + add-ons, room allocations (nights × rate),
 * closed maintenance lines — less effective discounts and advances. GST is computed per line.
 *
 * TAX: the client's instruction of 20 Jul 2026 is that **only rooms are taxed, at 5%**.
 * Venue, food and maintenance are zero-rated here — they previously carried placeholder
 * rates of 18%, 5% and 18% pending the hotel's tax consultant (PRD open question 5). This
 * is the hotel's own instruction and CLAUDE.md ranks that above the PRD, but zero GST on
 * banquet food and venue hire is unusual enough to be worth re-confirming before a real
 * guest pays against it — see docs/SEED_ASSUMPTIONS.md §F8.
 *
 * Tax is charged per line on the GROSS line amount and rounded per line, so the sum of the
 * line taxes is the authoritative figure (not 5% of the room subtotal, which can differ by
 * a paisa). Discounts are shown as a separate deduction, not pro-rated into each line's
 * taxable value — a documented simplification to revisit (D9).
 */

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0]
type Exec = Tx | typeof db

// Basis points. Only rooms are taxed (client, 20 Jul 2026) — see the note above.
const GST_BP: Record<string, number> = { venue: 0, food: 0, rooms: 500, maintenance: 0, adjustment: 0 }
// "INV" would put the banned word in front of the guest; the number belongs to the Draft 2
// document, so it carries that name instead (client: never "invoice", never "final").
const INVOICE_PREFIX = 'D2-2026-'
const LOCKED_PLUS = new Set(['locked', 'billed', 'closed'])

const taxOf = (amountPaise: number, bp: number) => Math.round((amountPaise * bp) / 10000)

export type LineSpec = { section: string; description: string; sacHsn?: string | null; qty: number; ratePaise: number; gstRateBp: number; amountPaise: number; taxPaise: number }

/**
 * Computes the venue / food / rooms / maintenance bill lines from an event's snapshots.
 * Adjustment lines are the Auditor's own and are not recomputed here.
 */
export async function computeBillLines(exec: Exec, eventId: string): Promise<LineSpec[]> {
  const lines: LineSpec[] = []
  const push = (section: string, description: string, qty: number, ratePaise: number, amountPaise: number) => {
    const bp = GST_BP[section] ?? 0
    lines.push({ section, description, qty, ratePaise, gstRateBp: bp, amountPaise, taxPaise: taxOf(amountPaise, bp) })
  }

  // Venue — the rate-card snapshot on each sub-event (set at confirm).
  const venues = (await exec.execute(sql`
    SELECT se.name, se.venue_rate_paise AS "ratePaise", COALESCE(v.name, b.name) AS "venueName"
    FROM sub_events se LEFT JOIN venues v ON v.id = se.venue_id LEFT JOIN venue_bundles b ON b.id = se.bundle_id
    WHERE se.event_id = ${eventId} AND se.venue_rate_paise > 0
    ORDER BY se.event_date, se.start_time
  `)) as unknown as { name: string; ratePaise: number; venueName: string }[]
  for (const v of venues) push('venue', `${v.venueName} — ${v.name}`, 1, Number(v.ratePaise), Number(v.ratePaise))

  // Food — pax × snapshotted per-plate, per sub-event with a saved menu.
  const food = (await exec.execute(sql`
    SELECT se.name, se.pax, m.tier_name AS "tierName", (m.base_rate_paise + m.surcharge_paise) AS "perPlate"
    FROM sub_event_menus m JOIN sub_events se ON se.id = m.sub_event_id
    WHERE se.event_id = ${eventId}
    ORDER BY se.event_date, se.start_time
  `)) as unknown as { name: string; pax: number; tierName: string; perPlate: number }[]
  for (const f of food) push('food', `${f.tierName} × ${f.pax} pax — ${f.name}`, f.pax, Number(f.perPlate), f.pax * Number(f.perPlate))

  // Add-ons — separate food lines (FR-3.6).
  const addons = (await exec.execute(sql`
    SELECT a.description, a.qty, a.rate_paise AS "ratePaise"
    FROM sub_event_addons a JOIN sub_events se ON se.id = a.sub_event_id
    WHERE se.event_id = ${eventId}
  `)) as unknown as { description: string; qty: number; ratePaise: number }[]
  for (const a of addons) push('food', `Add-on: ${a.description}`, a.qty, Number(a.ratePaise), a.qty * Number(a.ratePaise))

  // Rooms — nights × snapshotted rate (per-room discounts appear in the invoice discount total).
  const rooms = (await exec.execute(sql`
    SELECT u.name AS "unitName", r.room_no AS "roomNo",
           (upper(a.stay) - lower(a.stay)) AS nights, a.rate_paise AS "ratePaise"
    FROM room_allocations a JOIN rooms r ON r.id = a.room_id JOIN lodging_units u ON u.id = r.unit_id
    WHERE a.event_id = ${eventId}
    ORDER BY u.name, r.room_no
  `)) as unknown as { unitName: string; roomNo: string; nights: number; ratePaise: number }[]
  for (const rm of rooms) push('rooms', `${rm.unitName} ${rm.roomNo} × ${rm.nights} night(s)`, rm.nights, Number(rm.ratePaise), rm.nights * Number(rm.ratePaise))

  // Maintenance — closed entries only (FR-5.3).
  const maint = (await exec.execute(sql`
    SELECT item, qty, rate_paise AS "ratePaise", amount_paise AS "amountPaise"
    FROM maintenance_entries WHERE event_id = ${eventId} AND is_closed
    ORDER BY created_at
  `)) as unknown as { item: string; qty: string; ratePaise: number; amountPaise: number }[]
  for (const m of maint) push('maintenance', m.item, Number(m.qty), Number(m.ratePaise), Number(m.amountPaise))

  return lines
}

/** Net advances = payments received less refunds. */
async function advancesPaise(exec: Exec, eventId: string): Promise<number> {
  const [{ paid }] = (await exec.execute(sql`
    SELECT COALESCE(sum(CASE WHEN kind = 'refund' THEN -amount_paise ELSE amount_paise END), 0)::bigint AS paid
    FROM payments WHERE event_id = ${eventId}
  `)) as unknown as { paid: number }[]
  return Number(paid)
}

/** Recomputes and persists the invoice totals from its current lines + discounts + advances. */
async function recomputeTotals(tx: Tx, invoiceId: string, eventId: string): Promise<void> {
  const rows = await tx.select({ amountPaise: schema.invoiceLines.amountPaise, taxPaise: schema.invoiceLines.taxPaise }).from(schema.invoiceLines).where(eq(schema.invoiceLines.invoiceId, invoiceId))
  const gross = rows.reduce((s, r) => s + r.amountPaise, 0)
  const tax = rows.reduce((s, r) => s + r.taxPaise, 0)
  const discount = await effectiveDiscountPaise(eventId, tx)
  const advances = await advancesPaise(tx, eventId)
  const net = gross - discount + tax
  await tx
    .update(schema.invoices)
    .set({ grossPaise: gross, discountPaise: discount, taxPaise: tax, netPaise: net, advancesPaise: advances, balancePaise: net - advances })
    .where(eq(schema.invoices.id, invoiceId))
}

/** Drafts the invoice inside the lock transaction (FR-7.3). One invoice per event. */
export async function draftInvoice(tx: Tx, actor: Actor, eventId: string): Promise<void> {
  const [tnc] = (await tx.execute(sql`SELECT value FROM settings WHERE key = 'terms_and_conditions'`)) as unknown as { value: string }[]
  const specs = await computeBillLines(tx, eventId)
  const gross = specs.reduce((s, l) => s + l.amountPaise, 0)
  const tax = specs.reduce((s, l) => s + l.taxPaise, 0)
  const discount = await effectiveDiscountPaise(eventId, tx)
  const advances = await advancesPaise(tx, eventId)
  const net = gross - discount + tax

  const [inv] = await tx
    .insert(schema.invoices)
    .values({ eventId, grossPaise: gross, discountPaise: discount, taxPaise: tax, netPaise: net, advancesPaise: advances, balancePaise: net - advances, tncSnapshot: tnc?.value ?? '' })
    .returning({ id: schema.invoices.id })
  if (specs.length > 0) {
    await tx.insert(schema.invoiceLines).values(specs.map((l) => ({ invoiceId: inv!.id, section: l.section, description: l.description, sacHsn: l.sacHsn ?? null, qty: String(l.qty), ratePaise: l.ratePaise, gstRateBp: l.gstRateBp, amountPaise: l.amountPaise, taxPaise: l.taxPaise })))
  }
  await audit(tx, actor, { entity: 'invoices', entityId: inv!.id, eventId, action: 'insert', field: 'draft', newValue: `net ${net}` })
}

export type InvoiceView = {
  id: string; invoiceNo: string | null; finalised: boolean
  grossPaise: number; discountPaise: number; taxPaise: number; netPaise: number; advancesPaise: number; balancePaise: number
  tncSnapshot: string
  lines: { id: string; section: string; description: string; qty: string; ratePaise: number; gstRateBp: number; amountPaise: number; taxPaise: number }[]
}

export async function getInvoice(eventId: string): Promise<InvoiceView | null> {
  const [inv] = await db.select().from(schema.invoices).where(eq(schema.invoices.eventId, eventId)).limit(1)
  if (!inv) return null
  const lines = await db.select().from(schema.invoiceLines).where(eq(schema.invoiceLines.invoiceId, inv.id)).orderBy(asc(schema.invoiceLines.section), asc(schema.invoiceLines.description))
  return {
    id: inv.id, invoiceNo: inv.invoiceNo, finalised: Boolean(inv.finalisedAt),
    grossPaise: inv.grossPaise, discountPaise: inv.discountPaise, taxPaise: inv.taxPaise, netPaise: inv.netPaise, advancesPaise: inv.advancesPaise, balancePaise: inv.balancePaise,
    tncSnapshot: inv.tncSnapshot,
    lines: lines.map((l) => ({ id: l.id, section: l.section, description: l.description, qty: l.qty, ratePaise: l.ratePaise, gstRateBp: l.gstRateBp, amountPaise: l.amountPaise, taxPaise: l.taxPaise })),
  }
}

export type AdjustmentInput = { description: string; amountPaise: number; gstRateBp?: number; remark: string }

/** Replaces the Auditor's adjustment lines (FR-7.4) and recomputes; only before finalisation. */
export async function setAdjustments(actor: Actor, eventId: string, adjustments: AdjustmentInput[]): Promise<void> {
  if (actor.roleName !== 'auditor') throw forbidden('Only the Auditor may adjust the invoice.')
  await db.transaction(async (tx) => {
    const [inv] = await tx.select().from(schema.invoices).where(eq(schema.invoices.eventId, eventId)).for('update').limit(1)
    if (!inv) throw notFound('No invoice drafted yet — lock the event first.')
    if (inv.finalisedAt) throw conflict('This invoice is finalised and can no longer be adjusted.')
    for (const a of adjustments) if (!a.remark.trim()) throw badRequest('Every adjustment needs a remark (FR-7.4).')

    await tx.delete(schema.invoiceLines).where(sql`invoice_id = ${inv.id} AND section = 'adjustment'`)
    if (adjustments.length > 0) {
      await tx.insert(schema.invoiceLines).values(adjustments.map((a) => {
        const bp = a.gstRateBp ?? 0
        return { invoiceId: inv.id, section: 'adjustment', description: `${a.description} (${a.remark})`, qty: '1', ratePaise: a.amountPaise, gstRateBp: bp, amountPaise: a.amountPaise, taxPaise: taxOf(a.amountPaise, bp) }
      }))
    }
    await recomputeTotals(tx, inv.id, eventId)
    await audit(tx, actor, { entity: 'invoices', entityId: inv.id, eventId, action: 'update', field: 'adjustments', newValue: `${adjustments.length} line(s)` })
  })
}

/** Finalises: assigns the next invoice number and moves the event to Billed (FR-7.4). */
export async function finaliseInvoice(actor: Actor, eventId: string): Promise<{ invoiceNo: string }> {
  if (actor.roleName !== 'auditor') throw forbidden('Only the Auditor may finalise the invoice.')
  return db.transaction(async (tx) => {
    const [inv] = await tx.select().from(schema.invoices).where(eq(schema.invoices.eventId, eventId)).for('update').limit(1)
    if (!inv) throw notFound('No invoice drafted yet.')
    if (inv.finalisedAt) throw conflict(`This invoice is already finalised (${inv.invoiceNo}).`)

    // Atomic gapless-per-commit counter in settings (created on first use); the row lock
    // serialises concurrent finalisations.
    const [{ value }] = (await tx.execute(sql`
      INSERT INTO settings (key, value) VALUES ('invoice_next_no', '1')
      ON CONFLICT (key) DO UPDATE SET value = (settings.value::int + 1)::text, updated_at = now()
      RETURNING value
    `)) as unknown as { value: string }[]
    const invoiceNo = `${INVOICE_PREFIX}${String(Number(value)).padStart(4, '0')}`

    await tx.update(schema.invoices).set({ invoiceNo, finalisedAt: new Date().toISOString(), finalisedBy: actor.id }).where(eq(schema.invoices.id, inv.id))
    await transitionEvent(tx, eventId, 'billed', actor)
    await audit(tx, actor, { entity: 'invoices', entityId: inv.id, eventId, action: 'status', field: 'invoice_no', newValue: invoiceNo })
    return { invoiceNo }
  })
}

/** The full bill for the print view: invoice + event/guest details + T&C + sign-off list. */
export async function invoicePrintData(eventId: string) {
  const invoice = await getInvoice(eventId)
  if (!invoice) throw notFound('No invoice drafted yet.')
  const [event] = (await db.execute(sql`
    SELECT e.code, e.guest_name AS "guestName", e.event_type AS "eventType", e.status::text AS status,
           e.first_date::text AS "firstDate", e.last_date::text AS "lastDate"
    FROM events e WHERE e.id = ${eventId}
  `)) as unknown as { code: string; guestName: string; eventType: string; status: string; firstDate: string | null; lastDate: string | null }[]
  const contacts = (await db.execute(sql`SELECT phone, label FROM event_contacts WHERE event_id = ${eventId}`)) as unknown as { phone: string; label: string | null }[]
  const signoffs = (await db.execute(sql`
    SELECT s.designation::text AS designation, u.full_name AS "signedBy", s.signed_at AS "signedAt"
    FROM lock_signoffs s JOIN users u ON u.id = s.signed_by WHERE s.event_id = ${eventId}
  `)) as unknown as { designation: string; signedBy: string; signedAt: string }[]
  return { event, contacts, invoice, signoffs, lockedPlus: LOCKED_PLUS.has(event?.status ?? ''), proforma: false }
}

/**
 * A live proforma estimate for a not-yet-locked event (a quote before the invoice exists).
 * Computes the same lines and totals as the real bill from current data, but persists
 * nothing and assigns no invoice number — the shape matches invoicePrintData so the print
 * view can render either. Amounts are provisional until the event is locked.
 */
export async function proformaData(eventId: string) {
  const [event] = (await db.execute(sql`
    SELECT e.code, e.guest_name AS "guestName", e.event_type AS "eventType", e.status::text AS status,
           e.first_date::text AS "firstDate", e.last_date::text AS "lastDate"
    FROM events e WHERE e.id = ${eventId}
  `)) as unknown as { code: string; guestName: string; eventType: string; status: string; firstDate: string | null; lastDate: string | null }[]
  if (!event) throw notFound('Event not found')
  if (event.status === 'enquiry') throw badRequest('Confirm the booking to produce an estimate.')

  const specs = await computeBillLines(db, eventId)
  const gross = specs.reduce((s, l) => s + l.amountPaise, 0)
  const tax = specs.reduce((s, l) => s + l.taxPaise, 0)
  const discount = await effectiveDiscountPaise(eventId)
  const advances = await advancesPaise(db, eventId)
  const net = gross - discount + tax

  const [tnc] = (await db.execute(sql`SELECT value FROM settings WHERE key = 'terms_and_conditions'`)) as unknown as { value: string }[]
  const contacts = (await db.execute(sql`SELECT phone, label FROM event_contacts WHERE event_id = ${eventId}`)) as unknown as { phone: string; label: string | null }[]

  const invoice: InvoiceView = {
    id: '',
    invoiceNo: null,
    finalised: false,
    grossPaise: gross,
    discountPaise: discount,
    taxPaise: tax,
    netPaise: net,
    advancesPaise: advances,
    balancePaise: net - advances,
    tncSnapshot: tnc?.value ?? '',
    lines: specs.map((l, i) => ({ id: `p${i}`, section: l.section, description: l.description, qty: String(l.qty), ratePaise: l.ratePaise, gstRateBp: l.gstRateBp, amountPaise: l.amountPaise, taxPaise: l.taxPaise })),
  }
  return { event, contacts, invoice, signoffs: [] as { designation: string; signedBy: string; signedAt: string }[], lockedPlus: false, proforma: true }
}
