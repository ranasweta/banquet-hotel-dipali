import 'server-only'
import { and, asc, eq, isNull, sql } from 'drizzle-orm'
import { db, schema } from '@/db/drizzle'
import { audit, type Actor } from '@/lib/audit'
import { badRequest, conflict, forbidden, notFound } from '@/lib/api'
import { effectiveDiscountPaise } from '@/lib/discounts'
import { transitionEvent } from '@/lib/events'
import { GST_BP, isCollectedSection, taxOf } from '@/lib/tax'

/**
 * Consolidated invoice (M9, FR-7.3/7.4). Drafted from LOCKED data — venue rate-card
 * snapshots, food (pax × snapshotted per-plate) + add-ons, room allocations (nights × rate),
 * closed maintenance lines — less effective discounts and advances. GST is computed per line.
 *
 * TAX comes in two kinds now (client's lead, 4 Aug 2026) and they do not behave alike:
 *
 *   rooms 5%      printed AND collected. It is inside `taxPaise`, inside `netPaise`, and so
 *                 inside the balance the guest is chased for.
 *   everything    printed and collected from nobody — "at the end we are just showing we are
 *   else 18%      taking 18% gst but we wont be taking it". It lands in `shownTaxPaise`, which
 *                 enters exactly one figure: `displayTotalPaise`, the "Total" on the document.
 *
 * Folding the 18% into `netPaise` would leave `balancePaise` permanently 18% short of zero and
 * no booking could ever be settled. The split lives in lib/tax.ts so every screen agrees, and
 * it is by SECTION — rooms collected, all else shown — not by rate.
 *
 * Tax is charged per line on the GROSS line amount and rounded per line, so the sum of the
 * line taxes is the authoritative figure (not a percentage of a subtotal, which can differ by
 * a paisa). Discounts are shown as a separate deduction, not pro-rated into each line's
 * taxable value — a documented simplification to revisit (D9).
 */

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0]
type Exec = Tx | typeof db

// "INV" would put the banned word in front of the guest; the number belongs to the Draft 2
// document, so it carries that name instead (client: never "invoice", never "final").
const INVOICE_PREFIX = 'D2-2026-'

/** Splits a set of lines into the tax that is owed and the tax that is merely printed. */
function splitTax(lines: { section: string; taxPaise: number }[]): { collected: number; shown: number } {
  let collected = 0
  let shown = 0
  for (const l of lines) {
    if (isCollectedSection(l.section)) collected += l.taxPaise
    else shown += l.taxPaise
  }
  return { collected, shown }
}

/**
 * The event's LIVE invoice — the one version not yet superseded (migration 0025). Every read
 * goes through this: an event can now hold a chain of versions, and a query that matches on
 * event_id alone would pick an arbitrary one and, in the revenue reports, count the same
 * booking twice. A unique partial index guarantees there is at most one.
 */
const liveInvoice = (eventId: string) =>
  and(eq(schema.invoices.eventId, eventId), isNull(schema.invoices.supersededAt))!

export type LineSpec = {
  section: string; description: string; sacHsn?: string | null; qty: number
  ratePaise: number; gstRateBp: number; amountPaise: number; taxPaise: number
  /** The function this line belongs to; NULL for event-level lines (see migration 0015). */
  functionLabel?: string | null
}

/**
 * Computes the venue / food / rooms / maintenance bill lines from an event's snapshots.
 * Adjustment lines are the Auditor's own and are not recomputed here.
 */
export async function computeBillLines(exec: Exec, eventId: string): Promise<LineSpec[]> {
  const lines: LineSpec[] = []
  // `functionLabel` groups the printed bill the way the hotel counts — venue, menu and any
  // extras under each function in turn. `section` still decides the tax rate, so the
  // arithmetic is untouched by the grouping.
  const push = (
    section: string,
    description: string,
    qty: number,
    ratePaise: number,
    amountPaise: number,
    functionLabel: string | null = null,
  ) => {
    const bp = GST_BP[section] ?? 0
    lines.push({ section, description, qty, ratePaise, gstRateBp: bp, amountPaise, taxPaise: taxOf(amountPaise, bp), functionLabel })
  }

  // Venue — the rate-card snapshot on each sub-event (set at confirm). Before confirm the
  // snapshot is 0, so an enquiry Draft prices the venue live off the rate card instead, and
  // shows nothing only when no card exists yet (BR-R1). Post-confirm the snapshot always wins.
  const venues = (await exec.execute(sql`
    SELECT * FROM (
      -- ONE LINE PER VENUE-DAY, not per function (client, 12 Aug 2026). Hiring a hall takes
      -- it for the day — 9 AM to 8 AM the next morning — so three functions in it on one day
      -- are one let. Billing per function charged the guest for the room three times.
      --
      -- DISTINCT ON picks the day's FIRST function, matching lib/pricing.ts, so the proposal
      -- and the bill agree about which function carries the charge as well as what it costs.
      --
      -- Deliberately NOT relying on se.venue_rate_paise being zero for the covered functions:
      -- confirm writes that snapshot from the same dedupe, but the COALESCE below reads a zero
      -- as "not snapshotted" and falls back to the rate card — which would put the charge
      -- straight back on every function it was just taken off.
      SELECT DISTINCT ON (COALESCE(se.bundle_id::text, se.venue_id::text), se.event_date)
             se.name, se.event_date AS "eventDate", se.start_time AS "startTime",
             COALESCE(v.name, b.name) AS "venueName",
             COALESCE(NULLIF(se.venue_rate_paise, 0),
               (SELECT rc.rate_paise FROM venue_rate_cards rc
                 WHERE ((se.venue_id IS NOT NULL AND rc.venue_id = se.venue_id)
                     OR (se.bundle_id IS NOT NULL AND rc.bundle_id = se.bundle_id))
                   AND rc.event_type = e.event_type
                   AND rc.effective_from <= se.event_date
                 ORDER BY rc.effective_from DESC LIMIT 1),
               0)::bigint AS "ratePaise"
      FROM sub_events se
      JOIN events e ON e.id = se.event_id
      LEFT JOIN venues v ON v.id = se.venue_id LEFT JOIN venue_bundles b ON b.id = se.bundle_id
      WHERE se.event_id = ${eventId}
      ORDER BY COALESCE(se.bundle_id::text, se.venue_id::text), se.event_date, se.start_time
    ) d
    ORDER BY d."eventDate", d."startTime"
  `)) as unknown as { name: string; ratePaise: number; venueName: string }[]
  for (const v of venues) if (Number(v.ratePaise) > 0) push('venue', v.venueName, 1, Number(v.ratePaise), Number(v.ratePaise), v.name)

  // Food — pax × snapshotted per-plate, per sub-event with a saved menu.
  const food = (await exec.execute(sql`
    SELECT se.name, se.pax, m.tier_name AS "tierName", (m.base_rate_paise + m.surcharge_paise) AS "perPlate"
    FROM sub_event_menus m JOIN sub_events se ON se.id = m.sub_event_id
    WHERE se.event_id = ${eventId}
    ORDER BY se.event_date, se.start_time
  `)) as unknown as { name: string; pax: number; tierName: string; perPlate: number }[]
  for (const f of food) push('food', `${f.tierName} × ${f.pax} pax`, f.pax, Number(f.perPlate), f.pax * Number(f.perPlate), f.name)

  // Chef delicacies — a priced off-menu dish is a per-plate addition to the food rate, and
  // `foodAndAddonTotal` has always counted it, so the payment review, the payable amount and
  // every milestone include it. Leaving it off these lines made the Draft the guest holds
  // cheaper than the balance the same booking was asking for, by pax × the charge.
  //
  // It gets its own line rather than being folded into the per-plate rate: the tier rate on
  // the document has to stay the tier's own rate, or the guest reads a price the menu card
  // does not carry. Joined through `sub_event_menus` for the same reason the food line is —
  // a function with no saved menu contributes no food total, so a delicacy on one must not
  // appear here either, or the two figures part company again in the other direction.
  const delicacies = (await exec.execute(sql`
    SELECT se.name, se.pax, c.description, c.charge_paise AS "chargePaise"
    FROM chef_requests c
    JOIN sub_events se ON se.id = c.sub_event_id
    JOIN sub_event_menus m ON m.sub_event_id = se.id
    WHERE se.event_id = ${eventId} AND c.status = 'priced'
    ORDER BY se.event_date, se.start_time, c.description
  `)) as unknown as { name: string; pax: number; description: string; chargePaise: number }[]
  for (const d of delicacies) {
    push('food', `Chef delicacy: ${d.description}`, d.pax, Number(d.chargePaise), d.pax * Number(d.chargePaise), d.name)
  }

  // Add-ons — separate food lines (FR-3.6), under the FUNCTION they were ordered for. An
  // add-on hangs off a sub-event, so leaving it unlabelled dropped it into an event-level
  // Food group and the guest saw décor for the Sangeet sitting outside the Sangeet.
  const addons = (await exec.execute(sql`
    SELECT se.name, a.description, a.qty, a.rate_paise AS "ratePaise"
    FROM sub_event_addons a JOIN sub_events se ON se.id = a.sub_event_id
    WHERE se.event_id = ${eventId}
    ORDER BY se.event_date, se.start_time, a.description
  `)) as unknown as { name: string; description: string; qty: number; ratePaise: number }[]
  for (const a of addons) push('food', `Add-on: ${a.description}`, a.qty, Number(a.ratePaise), a.qty * Number(a.ratePaise), a.name)

  // The bar (12 Aug 2026) — bottles under the function that ordered them, priced from the
  // line's own snapshot so a re-priced brand never re-prices an issued document.
  //
  // Section `food`, which is the client's instruction: alcohol is taxed like everything but
  // rooms — 18%, printed on the Total and collected from nobody (rule 11). See SEED_ASSUMPTIONS
  // §F24: alcohol sits outside GST in India, so the LABEL may be wrong even though the money is
  // right. Moving it is a one-line change here plus a section in lib/tax.ts.
  const bar = (await exec.execute(sql`
    SELECT se.name, b.brand_name AS "brandName", b.bottles, b.rate_paise AS "ratePaise"
    FROM sub_event_bar_items b JOIN sub_events se ON se.id = b.sub_event_id
    WHERE se.event_id = ${eventId}
    ORDER BY se.event_date, se.start_time, b.brand_name
  `)) as unknown as { name: string; brandName: string; bottles: number; ratePaise: number }[]
  for (const b of bar) {
    push('food', `Bar: ${b.brandName}`, b.bottles, Number(b.ratePaise), b.bottles * Number(b.ratePaise), b.name)
  }

  // Rooms — count × nights × the lodge's rate for that category. Read from the bulk booking
  // on the proposal, NOT from room_allocations: rooms stopped being assigned room-by-room on
  // 21 Jul 2026 and nothing writes that table any more, so billing off it would have put
  // ZERO room charges on every bill. Room numbers are the reception desk's business and
  // never appear here.
  const rooms = (await exec.execute(sql`
    SELECT u.name AS "unitName", rr.room_type AS "roomType", rr.count::int AS count,
           (rr.check_out - rr.check_in)::int AS nights,
           COALESCE(rr.rate_paise, (SELECT min(r.rack_rate_paise) FROM rooms r
                      WHERE r.room_type = rr.room_type AND r.is_active
                        AND (rr.unit_id IS NULL OR r.unit_id = rr.unit_id)), 0)::bigint AS "ratePaise"
    FROM room_requirements rr
    LEFT JOIN lodging_units u ON u.id = rr.unit_id
    WHERE rr.event_id = ${eventId}
    ORDER BY u.name, rr.room_type
  `)) as unknown as { unitName: string | null; roomType: string; count: number; nights: number; ratePaise: number }[]
  for (const rm of rooms) {
    const qty = rm.count * rm.nights
    const label = `${rm.unitName ?? 'Lodging'} — ${rm.roomType.replace(/_/g, ' ')} × ${rm.count} room(s) × ${rm.nights} night(s)`
    push('rooms', label, qty, Number(rm.ratePaise), qty * Number(rm.ratePaise))
  }

  // Extra rooms the Lodge Manager handed out during the event (migration 0034) — closed lines
  // only, exactly as maintenance is charged. They are `rooms` lines because that is what they
  // are: the guest slept in them and the 5% on them is money the hotel collects. What keeps
  // them apart from the booking is the description and the fact that they are OUTSIDE the
  // pre-event base — see lib/payment-schedule.ts.
  const extraRooms = (await exec.execute(sql`
    SELECT u.name AS "unitName", a.room_type AS "roomType", a.count::int AS count,
           a.nights::int AS nights, a.rate_paise AS "ratePaise", a.amount_paise AS "amountPaise"
    FROM additional_rooms a
    LEFT JOIN lodging_units u ON u.id = a.unit_id
    JOIN lodge_extras x ON x.event_id = a.event_id AND x.closed_at IS NOT NULL
    WHERE a.event_id = ${eventId}
    ORDER BY u.name, a.room_type, a.created_at
  `)) as unknown as { unitName: string | null; roomType: string; count: number; nights: number; ratePaise: number; amountPaise: number }[]
  for (const rm of extraRooms) {
    const label = `${rm.unitName ?? 'Lodging'} — extra ${rm.roomType.replace(/_/g, ' ')} × ${rm.count} room(s) × ${rm.nights} night(s)`
    push('rooms', label, rm.count * rm.nights, Number(rm.ratePaise), Number(rm.amountPaise))
  }

  // In-room dining — one figure for the whole stay (client, 15 Aug 2026). A `food` line, so it
  // carries the 18% that is shown and collected from nobody (rule 11).
  const [dining] = (await exec.execute(sql`
    SELECT in_room_dining_paise AS "amountPaise" FROM lodge_extras
    WHERE event_id = ${eventId} AND closed_at IS NOT NULL AND in_room_dining_paise > 0
  `)) as unknown as { amountPaise: number }[]
  if (dining) push('food', 'In-room dining', 1, Number(dining.amountPaise), Number(dining.amountPaise))

  // Maintenance — closed entries only (FR-5.3).
  const maint = (await exec.execute(sql`
    SELECT item, qty, rate_paise AS "ratePaise", amount_paise AS "amountPaise"
    FROM maintenance_entries WHERE event_id = ${eventId} AND is_closed
    ORDER BY created_at
  `)) as unknown as { item: string; qty: string; ratePaise: number; amountPaise: number }[]
  for (const m of maint) push('maintenance', m.item, Number(m.qty), Number(m.ratePaise), Number(m.amountPaise))

  return lines
}

/**
 * The 18% an event would show if billed today, off the very lines the bill is built from — so
 * the wizard's payment review, the Draft and the Draft 2 print one figure between them. It is
 * display only: it enters no threshold and no balance (client's lead, 4 Aug 2026).
 */
export async function shownTaxPaise(eventId: string): Promise<number> {
  return splitTax(await computeBillLines(db, eventId)).shown
}

/**
 * Every payment against the event, oldest first — the instalment trail. A wedding is
 * frequently settled in pieces over months, and "Received so far: one number" hides who
 * paid what and when. Refunds are included (negative), so the trail always reconciles to
 * the advances figure beside it.
 */
export type PaymentTrailRow = {
  id: string; kind: string; amountPaise: number; mode: string
  receiptNo: string; receivedOn: string
}
async function paymentTrail(exec: Exec, eventId: string): Promise<PaymentTrailRow[]> {
  return (await exec.execute(sql`
    SELECT id, kind::text AS kind, amount_paise AS "amountPaise", mode,
           receipt_no AS "receiptNo", received_on::text AS "receivedOn"
    FROM payments WHERE event_id = ${eventId}
    ORDER BY received_on, receipt_no
  `)) as unknown as PaymentTrailRow[]
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
  const rows = await tx.select({ section: schema.invoiceLines.section, amountPaise: schema.invoiceLines.amountPaise, taxPaise: schema.invoiceLines.taxPaise }).from(schema.invoiceLines).where(eq(schema.invoiceLines.invoiceId, invoiceId))
  const gross = rows.reduce((s, r) => s + r.amountPaise, 0)
  const { collected, shown } = splitTax(rows)
  const discount = await effectiveDiscountPaise(eventId, tx)
  const advances = await advancesPaise(tx, eventId)
  const net = gross - discount + collected
  await tx
    .update(schema.invoices)
    .set({ grossPaise: gross, discountPaise: discount, taxPaise: collected, shownTaxPaise: shown, netPaise: net, advancesPaise: advances, balancePaise: net - advances })
    .where(eq(schema.invoices.id, invoiceId))
}

/** Drafts the invoice inside the lock transaction (FR-7.3). One invoice per event. */
export async function draftInvoice(tx: Tx, actor: Actor, eventId: string): Promise<void> {
  const [tnc] = (await tx.execute(sql`SELECT value FROM settings WHERE key = 'terms_and_conditions'`)) as unknown as { value: string }[]
  const specs = await computeBillLines(tx, eventId)
  const gross = specs.reduce((s, l) => s + l.amountPaise, 0)
  const { collected, shown } = splitTax(specs)
  const discount = await effectiveDiscountPaise(eventId, tx)
  const advances = await advancesPaise(tx, eventId)
  const net = gross - discount + collected

  const [inv] = await tx
    .insert(schema.invoices)
    .values({ eventId, grossPaise: gross, discountPaise: discount, taxPaise: collected, shownTaxPaise: shown, netPaise: net, advancesPaise: advances, balancePaise: net - advances, tncSnapshot: tnc?.value ?? '' })
    .returning({ id: schema.invoices.id })
  if (specs.length > 0) {
    await tx.insert(schema.invoiceLines).values(specs.map((l) => ({ invoiceId: inv!.id, section: l.section, description: l.description, sacHsn: l.sacHsn ?? null, qty: String(l.qty), ratePaise: l.ratePaise, gstRateBp: l.gstRateBp, amountPaise: l.amountPaise, taxPaise: l.taxPaise, functionLabel: l.functionLabel ?? null })))
  }
  await audit(tx, actor, { entity: 'invoices', entityId: inv!.id, eventId, action: 'insert', field: 'draft', newValue: `net ${net}` })
}

export type InvoiceView = {
  id: string; invoiceNo: string | null; finalised: boolean
  /**
   * Revision chain (migration 0025). `version` is 1 for every document not re-issued;
   * `supersedesNo` names the one this replaced, so staff looking at two numbers against one
   * booking can see which is live and what it grew out of.
   */
  version: number; supersedesNo: string | null
  grossPaise: number; discountPaise: number
  /** Tax that is COLLECTED — the 5% on rooms. Part of netPaise, and so of the balance. */
  taxPaise: number
  /** Tax that is SHOWN and never collected — the 18%. In displayTotalPaise and nothing else. */
  shownTaxPaise: number
  netPaise: number
  /** What the document prints as "Total": the payable amount plus the 18% nobody pays. */
  displayTotalPaise: number
  advancesPaise: number; balancePaise: number
  payments: PaymentTrailRow[]
  tncSnapshot: string
  lines: { id: string; section: string; description: string; qty: string; ratePaise: number; gstRateBp: number; amountPaise: number; taxPaise: number; functionLabel: string | null }[]
}

export async function getInvoice(eventId: string): Promise<InvoiceView | null> {
  const [inv] = await db.select().from(schema.invoices).where(liveInvoice(eventId)).limit(1)
  if (!inv) return null
  const lines = await db.select().from(schema.invoiceLines).where(eq(schema.invoiceLines.invoiceId, inv.id)).orderBy(asc(schema.invoiceLines.section), asc(schema.invoiceLines.description))
  const [prior] = inv.supersedesId
    ? await db.select({ invoiceNo: schema.invoices.invoiceNo }).from(schema.invoices).where(eq(schema.invoices.id, inv.supersedesId)).limit(1)
    : []
  return {
    id: inv.id, invoiceNo: inv.invoiceNo, finalised: Boolean(inv.finalisedAt),
    version: inv.version, supersedesNo: prior?.invoiceNo ?? null,
    grossPaise: inv.grossPaise, discountPaise: inv.discountPaise,
    taxPaise: inv.taxPaise, shownTaxPaise: inv.shownTaxPaise,
    netPaise: inv.netPaise, displayTotalPaise: inv.netPaise + inv.shownTaxPaise,
    advancesPaise: inv.advancesPaise, balancePaise: inv.balancePaise,
    payments: await paymentTrail(db, eventId),
    tncSnapshot: inv.tncSnapshot,
    lines: lines.map((l) => ({ id: l.id, section: l.section, description: l.description, functionLabel: l.functionLabel, qty: l.qty, ratePaise: l.ratePaise, gstRateBp: l.gstRateBp, amountPaise: l.amountPaise, taxPaise: l.taxPaise })),
  }
}

export type AdjustmentInput = { description: string; amountPaise: number; gstRateBp?: number; remark: string }

/** Replaces the Auditor's adjustment lines (FR-7.4) and recomputes; only before finalisation. */
export async function setAdjustments(actor: Actor, eventId: string, adjustments: AdjustmentInput[]): Promise<void> {
  if (actor.roleName !== 'auditor') throw forbidden('Only the Auditor may adjust the invoice.')
  await db.transaction(async (tx) => {
    const [inv] = await tx.select().from(schema.invoices).where(liveInvoice(eventId)).for('update').limit(1)
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

/**
 * The next document number. An atomic gapless-per-commit counter in `settings`, created on
 * first use; the caller's row lock on the invoice serialises concurrent finalisations.
 */
async function nextInvoiceNo(tx: Tx): Promise<string> {
  const [{ value }] = (await tx.execute(sql`
    INSERT INTO settings (key, value) VALUES ('invoice_next_no', '1')
    ON CONFLICT (key) DO UPDATE SET value = (settings.value::int + 1)::text, updated_at = now()
    RETURNING value
  `)) as unknown as { value: string }[]
  return `${INVOICE_PREFIX}${String(Number(value)).padStart(4, '0')}`
}

/**
 * Brings the invoice back into line after the Higher Authority has edited a locked or billed
 * booking (migration 0025). Called from inside the GM's own transaction, so the bill can never
 * disagree with the booking it bills — the edit and the re-issue commit together or not at all.
 *
 * Which of the two things it does depends on whether a number has left the building:
 *
 *   locked, not finalised   the draft is recomputed IN PLACE. Nobody has been shown a figure,
 *                           so there is nothing to supersede and no number to burn.
 *   finalised (billed)      the guest holds a document quoting a total that is now wrong.
 *                           That version is stamped superseded and a NEW version is issued with
 *                           its own number, finalised on the spot. The old row stays exactly as
 *                           it was — a superseded document is history, not a mistake to erase.
 *
 * Returns the new number when one was issued, so the caller can put it in front of the GM.
 */
export async function reissueInvoice(
  tx: Tx,
  actor: Actor,
  eventId: string,
  reason: string,
): Promise<{ reissued: boolean; invoiceNo: string | null }> {
  const [inv] = await tx.select().from(schema.invoices).where(liveInvoice(eventId)).for('update').limit(1)
  // No invoice at all — the event was never locked, so its numbers are still provisional.
  if (!inv) return { reissued: false, invoiceNo: null }

  const specs = await computeBillLines(tx, eventId)

  if (!inv.finalisedAt) {
    await tx.delete(schema.invoiceLines).where(sql`invoice_id = ${inv.id} AND section <> 'adjustment'`)
    if (specs.length > 0) {
      await tx.insert(schema.invoiceLines).values(specs.map((l) => ({ invoiceId: inv.id, section: l.section, description: l.description, sacHsn: l.sacHsn ?? null, qty: String(l.qty), ratePaise: l.ratePaise, gstRateBp: l.gstRateBp, amountPaise: l.amountPaise, taxPaise: l.taxPaise, functionLabel: l.functionLabel ?? null })))
    }
    await recomputeTotals(tx, inv.id, eventId)
    await audit(tx, actor, { entity: 'invoices', entityId: inv.id, eventId, action: 'update', field: 'redraft', newValue: reason })
    return { reissued: false, invoiceNo: inv.invoiceNo }
  }

  // The Auditor's adjustment lines are their own judgement, not derived from the booking, so
  // they carry forward onto the new version rather than being silently dropped by the recompute.
  const adjustments = await tx
    .select()
    .from(schema.invoiceLines)
    .where(sql`invoice_id = ${inv.id} AND section = 'adjustment'`)

  const gross = specs.reduce((s, l) => s + l.amountPaise, 0) + adjustments.reduce((s, l) => s + l.amountPaise, 0)
  const { collected, shown } = splitTax([...specs, ...adjustments])
  const discount = await effectiveDiscountPaise(eventId, tx)
  const advances = await advancesPaise(tx, eventId)
  const net = gross - discount + collected
  const now = new Date().toISOString()

  await tx.update(schema.invoices).set({ supersededAt: now }).where(eq(schema.invoices.id, inv.id))

  const invoiceNo = await nextInvoiceNo(tx)
  const [next] = await tx
    .insert(schema.invoices)
    .values({
      eventId,
      invoiceNo,
      version: inv.version + 1,
      supersedesId: inv.id,
      reissueReason: reason,
      grossPaise: gross,
      discountPaise: discount,
      taxPaise: collected,
      shownTaxPaise: shown,
      netPaise: net,
      advancesPaise: advances,
      balancePaise: net - advances,
      // The terms the guest agreed to travel with the booking, not with the revision.
      tncSnapshot: inv.tncSnapshot,
      finalisedAt: now,
      finalisedBy: actor.id,
    })
    .returning({ id: schema.invoices.id })

  const carried = adjustments.map((a) => ({ invoiceId: next!.id, section: a.section, description: a.description, sacHsn: a.sacHsn, qty: a.qty, ratePaise: a.ratePaise, gstRateBp: a.gstRateBp, amountPaise: a.amountPaise, taxPaise: a.taxPaise, functionLabel: a.functionLabel }))
  const fresh = specs.map((l) => ({ invoiceId: next!.id, section: l.section, description: l.description, sacHsn: l.sacHsn ?? null, qty: String(l.qty), ratePaise: l.ratePaise, gstRateBp: l.gstRateBp, amountPaise: l.amountPaise, taxPaise: l.taxPaise, functionLabel: l.functionLabel ?? null }))
  if (fresh.length + carried.length > 0) {
    await tx.insert(schema.invoiceLines).values([...fresh, ...carried])
  }

  await audit(tx, actor, {
    entity: 'invoices',
    entityId: next!.id,
    eventId,
    action: 'update',
    field: 'reissued',
    oldValue: `${inv.invoiceNo} (v${inv.version}, net ${inv.netPaise})`,
    newValue: `${invoiceNo} (v${inv.version + 1}, net ${net}) — ${reason}`,
  })
  return { reissued: true, invoiceNo }
}

/** Finalises: assigns the next invoice number and moves the event to Billed (FR-7.4). */
export async function finaliseInvoice(actor: Actor, eventId: string): Promise<{ invoiceNo: string }> {
  if (actor.roleName !== 'auditor') throw forbidden('Only the Auditor may finalise the invoice.')
  return db.transaction(async (tx) => {
    const [inv] = await tx.select().from(schema.invoices).where(liveInvoice(eventId)).for('update').limit(1)
    if (!inv) throw notFound('No invoice drafted yet.')
    if (inv.finalisedAt) throw conflict(`This invoice is already finalised (${inv.invoiceNo}).`)

    const invoiceNo = await nextInvoiceNo(tx)

    await tx.update(schema.invoices).set({ invoiceNo, finalisedAt: new Date().toISOString(), finalisedBy: actor.id }).where(eq(schema.invoices.id, inv.id))
    await transitionEvent(tx, eventId, 'billed', actor)
    await audit(tx, actor, { entity: 'invoices', entityId: inv.id, eventId, action: 'status', field: 'invoice_no', newValue: invoiceNo })
    return { invoiceNo }
  })
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
  // Printable at any stage (client, 25 Jul 2026): an enquiry prints a provisional Draft, a
  // confirmed booking prints a Draft 2. The venue is priced live off the rate card until the
  // confirm snapshot exists, so the enquiry estimate is complete rather than blocked.

  const specs = await computeBillLines(db, eventId)
  const gross = specs.reduce((s, l) => s + l.amountPaise, 0)
  const { collected, shown } = splitTax(specs)
  const discount = await effectiveDiscountPaise(eventId)
  const advances = await advancesPaise(db, eventId)
  const net = gross - discount + collected

  const [tnc] = (await db.execute(sql`SELECT value FROM settings WHERE key = 'terms_and_conditions'`)) as unknown as { value: string }[]
  const contacts = (await db.execute(sql`SELECT phone, label FROM event_contacts WHERE event_id = ${eventId}`)) as unknown as { phone: string; label: string | null }[]

  const invoice: InvoiceView = {
    id: '',
    invoiceNo: null,
    finalised: false,
    // A proforma is not a document that has been issued, so it can never be a revision of one.
    version: 1,
    supersedesNo: null,
    grossPaise: gross,
    discountPaise: discount,
    taxPaise: collected,
    shownTaxPaise: shown,
    netPaise: net,
    displayTotalPaise: net + shown,
    advancesPaise: advances,
    payments: await paymentTrail(db, eventId),
    balancePaise: net - advances,
    tncSnapshot: tnc?.value ?? '',
    lines: specs.map((l, i) => ({ id: `p${i}`, section: l.section, description: l.description, functionLabel: l.functionLabel ?? null, qty: String(l.qty), ratePaise: l.ratePaise, gstRateBp: l.gstRateBp, amountPaise: l.amountPaise, taxPaise: l.taxPaise })),
  }
  return { event, contacts, invoice, signoffs: [] as { designation: string; signedBy: string; signedAt: string }[], lockedPlus: false, proforma: true }
}
