/**
 * Bundled GM approvals (client's lead, 1 Aug 2026) — the acceptance criteria for the change
 * that made the PROPOSAL, not the request, the unit of decision:
 *
 *   - every pending ask on a booking arrives as ONE bundle, and a late arrival joins it;
 *   - the GM settles the whole bundle in one call;
 *   - his edits to the proposal are written through, and an ask he answers BY EDITING is
 *     recorded rather than applied a second time;
 *   - `locked means locked` yields to him, and only to him, and a billed edit re-issues the
 *     guest's document as a new version;
 *   - a rupee discount he gives is uncapped and effective at once;
 *   - what he cannot override: the lodge's physical inventory.
 *
 * Drives the real services against the test database, with the asks raised through the real
 * M4/M5/M7 flows so the payloads are authentic.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { eq, sql } from 'drizzle-orm'

const bundles = await import('@/lib/approval-bundles')
const gm = await import('@/lib/gm-authority')
const menus = await import('@/lib/menus')
const roomsSvc = await import('@/lib/rooms')
const discounts = await import('@/lib/discounts')
const invoice = await import('@/lib/invoice')
const { createClient } = await import('@/db/client')
const { migrate } = await import('@/db/migrate')
const { seed } = await import('@/db/seed')
const { db, schema } = await import('@/db/drizzle')

const hasDb = Boolean(process.env.TEST_DATABASE_URL)
const d = hasDb ? describe : describe.skip
if (!hasDb) console.warn('\n  ! TEST_DATABASE_URL unset — skipping approval-bundle tests\n')

const bm = { id: '', roleName: 'booking_manager' }
const ha = { id: '', roleName: 'higher_authority' }
const auditor = { id: '', roleName: 'auditor' }

async function tierId(name: string): Promise<string> {
  const [t] = await db.select({ id: schema.menuTiers.id }).from(schema.menuTiers).where(eq(schema.menuTiers.name, name)).limit(1)
  return t!.id
}
async function venueId(name: string): Promise<string> {
  const [v] = await db.select({ id: schema.venues.id }).from(schema.venues).where(eq(schema.venues.name, name)).limit(1)
  return v!.id
}
async function userId(role: string): Promise<string> {
  const [u] = await db.select({ id: schema.users.id }).from(schema.users).innerJoin(schema.roles, eq(schema.roles.id, schema.users.roleId)).where(eq(schema.roles.name, role)).limit(1)
  return u!.id
}
async function unitId(name: string): Promise<string> {
  const [u] = await db.select({ id: schema.lodgingUnits.id }).from(schema.lodgingUnits).where(eq(schema.lodgingUnits.name, name)).limit(1)
  return u!.id
}

/**
 * A booking with one function. Always BUILT as confirmed and only then moved to `status`:
 * the lock guard blocks child writes on a locked event, so a fixture that starts locked
 * cannot give itself a function — which is the guard doing its job, not a bug to route around.
 */
async function makeBooking(status = 'confirmed'): Promise<{ eventId: string; subId: string }> {
  const [{ code }] = (await db.execute(sql`SELECT 'E-' || nextval('event_code_seq') AS code`)) as unknown as { code: string }[]
  const [event] = await db
    .insert(schema.events)
    .values({
      code, guestName: 'Bundle Test', eventType: 'engagement', status: 'confirmed',
      createdBy: bm.id, plannedFrom: '2026-09-01', plannedTo: '2026-09-03',
    })
    .returning({ id: schema.events.id })
  const [sub] = await db
    .insert(schema.subEvents)
    .values({ eventId: event!.id, name: 'Reception', eventDate: '2026-09-01', startTime: '19:00', endTime: '23:00', venueId: await venueId('Crystal'), pax: 200 })
    .returning({ id: schema.subEvents.id })
  if (status !== 'confirmed') {
    await db.update(schema.events).set({ status: status as 'locked' }).where(eq(schema.events.id, event!.id))
  }
  return { eventId: event!.id, subId: sub!.id }
}

/**
 * These drive the real M4/M5/M7 services against a remote database, and a single fixture can
 * make thirty-odd sequential round trips. The 45s file default is sized for one flow, not
 * three stacked into one bundle.
 */
const SLOW = 150_000

/** A menu increase that has reached the Authority, over the two free extras. */
async function raiseMenuIncrease(subId: string): Promise<string> {
  const silver = await tierId('Silver')
  await menus.saveSubEventMenu(bm, subId, { tierId: silver, selections: { 'Paneer Main Course': ['Kadai Paneer'] } })
  await menus.increaseCategory(bm, subId, 'Paneer Main Course')
  await menus.saveSubEventMenu(bm, subId, {
    tierId: silver,
    selections: { 'Paneer Main Course': ['Kadai Paneer', 'Handi Paneer', 'Mutter Paneer', 'Paneer Lababdar', 'Paneer Makhani'] },
  })
  const { exceptionId } = await menus.submitIncreases(bm, subId)
  if (!exceptionId) throw new Error('expected an increase awaiting approval')
  return exceptionId
}

/**
 * A room booking over the 35 threshold, which raises its own request. Split across two
 * categories because Regency holds only 27 deluxe — the 35+ rule is an approval, but the
 * inventory cap in front of it is real, and a fixture that ignores it tests nothing.
 */
async function raiseRoomRequest(eventId: string): Promise<void> {
  const regency = await unitId('Regency')
  await roomsSvc.saveRoomRequirements(bm, eventId, [
    { unitId: regency, roomType: 'deluxe', count: 27, checkIn: '2026-09-01', checkOut: '2026-09-03' },
    { unitId: regency, roomType: 'semi_deluxe', count: 9, checkIn: '2026-09-01', checkOut: '2026-09-03' },
  ])
}

beforeAll(async () => {
  if (!hasDb) return
  const setup = createClient('TEST_DATABASE_URL')
  try {
    await migrate(setup, () => {})
    await seed(setup, { reset: true, force: true, password: 'test-only' }, () => {})
  } finally {
    await setup.end()
  }
  bm.id = await userId('booking_manager')
  ha.id = await userId('higher_authority')
  auditor.id = await userId('auditor')
}, 90_000)

async function cleanup() {
  await db.delete(schema.invoices)
  await db.delete(schema.venueBookings)
  await db.delete(schema.events)
}
afterEach(async () => { if (hasDb) await cleanup() })
afterAll(async () => { if (hasDb) await cleanup() })

d('bundling (acceptance)', () => {
  it('collects every ask on one booking into a SINGLE bundle', async () => {
    const { eventId, subId } = await makeBooking()
    await raiseMenuIncrease(subId)
    await raiseRoomRequest(eventId)
    await discounts.addDiscount(bm, eventId, { head: 'overall', percentBp: 5000, remark: 'Owner’s friend' })

    const list = await bundles.listBundles()
    const mine = list.filter((b) => b.eventId === eventId)
    // Three separate requests, ONE row for the GM — the whole point of the change.
    expect(mine).toHaveLength(1)
    expect(mine[0]!.pendingCount).toBe(3)
    expect(new Set(mine[0]!.bySection.map((s) => s.section))).toEqual(new Set(['food', 'rooms', 'discount']))
  }, SLOW)

  it('a LATE ask joins the bundle it belongs to, after part of it was decided', async () => {
    const { eventId, subId } = await makeBooking()
    const menuExc = await raiseMenuIncrease(subId)

    await bundles.decideBundle(ha, eventId, {
      decisions: [{ id: menuExc, source: 'exception', action: 'approve' }],
    })
    expect((await bundles.listBundles()).filter((b) => b.eventId === eventId)).toHaveLength(0)

    // The Booking Manager comes back days later with rooms. It must reopen the same bundle,
    // not start a queue of its own — the edge case the lead asked about explicitly.
    await raiseRoomRequest(eventId)
    const reopened = (await bundles.listBundles()).filter((b) => b.eventId === eventId)
    expect(reopened).toHaveLength(1)
    expect(reopened[0]!.pendingCount).toBe(1)

    // And the detail still shows the settled decision beside the new ask.
    const detail = await bundles.bundleDetail(eventId, { includeSettled: true })
    expect(detail.asks).toHaveLength(2)
    expect(detail.asks.filter((a) => a.status === 'pending')).toHaveLength(1)
  }, SLOW)

  it('settles the whole bundle in ONE call', async () => {
    const { eventId, subId } = await makeBooking()
    const menuExc = await raiseMenuIncrease(subId)
    await raiseRoomRequest(eventId)
    const roomExc = (await bundles.bundleDetail(eventId)).asks.find((a) => a.kind === 'room_allocation_35plus')!

    const res = await bundles.decideBundle(ha, eventId, {
      decisions: [
        { id: menuExc, source: 'exception', action: 'approve' },
        { id: roomExc.id, source: 'exception', action: 'reject', remark: 'Regency is full that week' },
      ],
    })
    expect(res.settled).toHaveLength(2)
    expect(res.remaining).toBe(0)
  }, SLOW)

  it('refuses a decider who is not the Authority', async () => {
    const { eventId, subId } = await makeBooking()
    const excId = await raiseMenuIncrease(subId)
    await expect(
      bundles.decideBundle(bm, eventId, { decisions: [{ id: excId, source: 'exception', action: 'approve' }] }),
    ).rejects.toMatchObject({ status: 403 })
  }, SLOW)
})

d('deciding by editing', () => {
  it('unticking a requested dish refuses it, and the ask is NOT applied twice', async () => {
    const { eventId, subId } = await makeBooking()
    const excId = await raiseMenuIncrease(subId)

    // The GM's real answer: he leaves three of the five ticked and settles the ask alongside.
    const res = await bundles.decideBundle(ha, eventId, {
      decisions: [{ id: excId, source: 'exception', action: 'approve' }],
      edits: {
        menus: [{ subEventId: subId, categoryName: 'Paneer Main Course', dishes: ['Kadai Paneer', 'Handi Paneer', 'Mutter Paneer'] }],
      },
    })

    expect(res.settled[0]!.applied).toMatch(/own edit/)
    const cat = (await menus.getSubEventMenu(subId)).menu!.categories.find((c) => c.categoryName === 'Paneer Main Course')!
    // Three dishes on a base of one: two extras stand, and they are sanctioned, not pending.
    expect(cat.extraPicks).toBe(2)
    expect(cat.effectivePick).toBe(3)
    expect(cat.exceptionPending).toBe(false)
  }, SLOW)

  it('writes the edits through to the booking itself', async () => {
    const { eventId, subId } = await makeBooking()
    await bundles.decideBundle(ha, eventId, {
      edits: { functions: [{ id: subId, pax: 275, name: 'Grand Reception' }] },
    })
    const [row] = await db.select({ pax: schema.subEvents.pax, name: schema.subEvents.name }).from(schema.subEvents).where(eq(schema.subEvents.id, subId)).limit(1)
    expect(row!.pax).toBe(275)
    expect(row!.name).toBe('Grand Reception')
  })

  it('records a summary audit row the Booking Manager can be told about', async () => {
    const { eventId, subId } = await makeBooking()
    await bundles.decideBundle(ha, eventId, { edits: { functions: [{ id: subId, pax: 250 }] } })
    const rows = (await db.execute(sql`
      SELECT field, new_value AS "newValue" FROM audit_log
       WHERE event_id = ${eventId} AND field IN ('authority_edit', 'authority_override')
    `)) as unknown as { field: string; newValue: string }[]
    expect(rows).toHaveLength(1)
    expect(rows[0]!.field).toBe('authority_edit')
    expect(rows[0]!.newValue).toMatch(/pax 200 → 250/)
  })
})

d('older menu requests still in live data', () => {
  /**
   * Production holds `menu_increase` rows written by an earlier version, shaped
   * `{items:[{menuId, categoryName, currentPick, requestedPick, reason}]}` — menuId inside the
   * item, the increment as a before/after pair, and no dish names. `applyDeferred` read only
   * the current shape and threw "This request carries no increments to apply", which failed the
   * GM's ENTIRE save: the rooms and discount decisions beside it were rolled back too.
   */
  async function legacyIncrease(eventId: string, subId: string): Promise<string> {
    // One dish on a base pick of one — the request is precisely what would allow a second.
    await menus.saveSubEventMenu(bm, subId, {
      tierId: await tierId('Silver'),
      selections: { 'Paneer Main Course': ['Kadai Paneer'] },
    })
    const [m] = (await db.execute(sql`
      SELECT id FROM sub_event_menus WHERE sub_event_id = ${subId}
    `)) as unknown as { id: string }[]
    const [exc] = await db
      .insert(schema.exceptions)
      .values({
        eventId, kind: 'menu_increase', status: 'pending',
        payload: {
          items: [{
            menuId: m!.id, subEventId: subId, subEventName: 'Reception',
            categoryName: 'Paneer Main Course', currentPick: 1, requestedPick: 2,
            reason: 'category_not_free_eligible',
          }],
        },
        raisedBy: bm.id,
      })
      .returning({ id: schema.exceptions.id })
    return exc!.id
  }

  it('approves one, applying the increment it states', async () => {
    const { eventId, subId } = await makeBooking()
    const excId = await legacyIncrease(eventId, subId)

    const res = await bundles.decideBundle(ha, eventId, {
      decisions: [{ id: excId, source: 'exception', action: 'approve' }],
    })
    expect(res.settled[0]!.status).toBe('approved')

    // requestedPick 2 − currentPick 1 = one extra pick, now sanctioned.
    const [cat] = (await db.execute(sql`
      SELECT approved_extra_picks AS "approved" FROM sub_event_menu_categories c
        JOIN sub_event_menus m ON m.id = c.menu_id
       WHERE m.sub_event_id = ${subId} AND c.category_name = 'Paneer Main Course'
    `)) as unknown as { approved: number }[]
    expect(cat!.approved).toBe(1)
  }, SLOW)

  it('reads as a sentence, not "+undefined"', async () => {
    const { eventId, subId } = await makeBooking()
    await legacyIncrease(eventId, subId)
    const detail = await bundles.bundleDetail(eventId)
    const ask = detail.asks.find((a) => a.kind === 'menu_increase')!
    expect(ask.summary).toContain('Paneer Main Course +1')
    expect(ask.summary).not.toContain('undefined')
  }, SLOW)

  it('does not sink the rest of the bundle', async () => {
    // The regression that matters: one request the system cannot act on must not stop the GM
    // deciding the ones it can.
    const { eventId, subId } = await makeBooking()
    const excId = await legacyIncrease(eventId, subId)
    await raiseRoomRequest(eventId)
    const roomAsk = (await bundles.bundleDetail(eventId)).asks.find((a) => a.kind === 'room_allocation_35plus')!

    const res = await bundles.decideBundle(ha, eventId, {
      decisions: [
        { id: excId, source: 'exception', action: 'approve' },
        { id: roomAsk.id, source: 'exception', action: 'approve' },
      ],
    })
    expect(res.settled).toHaveLength(2)
    expect(res.remaining).toBe(0)
  }, SLOW)

  it('records a request that names no increments at all, rather than failing', async () => {
    const { eventId } = await makeBooking()
    const [exc] = await db
      .insert(schema.exceptions)
      .values({ eventId, kind: 'menu_increase', status: 'pending', payload: { items: [] }, raisedBy: bm.id })
      .returning({ id: schema.exceptions.id })

    const res = await bundles.decideBundle(ha, eventId, {
      decisions: [{ id: exc!.id, source: 'exception', action: 'approve' }],
    })
    expect(res.settled[0]!.status).toBe('approved')
    expect(res.settled[0]!.applied).toMatch(/no increments/)
    expect(res.remaining).toBe(0)
  }, SLOW)
})

d('the lock override', () => {
  it('lets the Authority edit a LOCKED booking, and nobody else', async () => {
    const { eventId, subId } = await makeBooking('locked')

    // The Booking Manager still meets the wall, at the service layer AND the trigger.
    await expect(menus.saveSubEventMenu(bm, subId, { tierId: await tierId('Silver'), selections: {} })).rejects.toBeTruthy()

    await gm.editProposalAsAuthority(ha, eventId, { functions: [{ id: subId, pax: 150 }], reason: 'Guest cut the numbers' })
    const [row] = await db.select({ pax: schema.subEvents.pax }).from(schema.subEvents).where(eq(schema.subEvents.id, subId)).limit(1)
    expect(row!.pax).toBe(150)
  })

  it('demands a reason before overriding a lock', async () => {
    const { eventId, subId } = await makeBooking('locked')
    await expect(
      gm.editProposalAsAuthority(ha, eventId, { functions: [{ id: subId, pax: 150 }] }),
    ).rejects.toMatchObject({ status: 400 })
  })

  it('does not leak the override to the next transaction', async () => {
    // SET LOCAL dies with its transaction. If it ever leaked onto a pooled connection, a
    // later ordinary write to a locked event would silently succeed — so prove it does not.
    const { eventId, subId } = await makeBooking('locked')
    await gm.editProposalAsAuthority(ha, eventId, { functions: [{ id: subId, pax: 150 }], reason: 'Guest cut the numbers' })

    // Drizzle wraps the driver error, so the trigger's own words are down the cause chain.
    let message = ''
    try {
      await db.update(schema.subEvents).set({ pax: 999 }).where(eq(schema.subEvents.id, subId))
      throw new Error('the locked guard did not fire — the override leaked')
    } catch (err) {
      for (let cur: unknown = err, i = 0; cur && i < 5; i++) {
        message += (cur as Error).message ?? ''
        cur = (cur as { cause?: unknown }).cause
      }
    }
    expect(message).toMatch(/immutable/)

    const [row] = await db.select({ pax: schema.subEvents.pax }).from(schema.subEvents).where(eq(schema.subEvents.id, subId)).limit(1)
    expect(row!.pax).toBe(150) // the Authority's edit stands; the ordinary write did not
  })

  it('re-issues the guest’s document when a BILLED booking changes', async () => {
    const { eventId, subId } = await makeBooking('confirmed')
    // Draft and finalise an invoice the way the lock does, then bill the event.
    await db.transaction(async (tx) => { await invoice.draftInvoice(tx, auditor, eventId) })
    await db.update(schema.events).set({ status: 'locked' }).where(eq(schema.events.id, eventId))
    const { invoiceNo: first } = await invoice.finaliseInvoice(auditor, eventId)

    const res = await gm.editProposalAsAuthority(ha, eventId, {
      functions: [{ id: subId, pax: 400 }],
      reason: 'Guest added 200 covers after billing',
    })
    expect(res.invoiceReissued).toBe(true)
    expect(res.invoiceNo).not.toBe(first)

    const rows = (await db.execute(sql`
      SELECT version, invoice_no AS "invoiceNo", superseded_at AS "supersededAt"
        FROM invoices WHERE event_id = ${eventId} ORDER BY version
    `)) as unknown as { version: number; invoiceNo: string; supersededAt: string | null }[]
    expect(rows).toHaveLength(2)
    expect(rows[0]!.supersededAt).not.toBeNull() // v1 kept, marked superseded — never erased
    expect(rows[1]!.supersededAt).toBeNull()
    // The live read follows the chain, so the bill and the reports see exactly one document.
    expect((await invoice.getInvoice(eventId))!.invoiceNo).toBe(rows[1]!.invoiceNo)
  }, SLOW)

  it('overrides the MENU guard too, which is a separate trigger', async () => {
    // forbid_locked_menu_write resolves the event through sub_event_id/menu_id rather than a
    // column of its own. It is a second function with its own copy of the check, so proving
    // the sub_events guard yields says nothing about this one.
    const { eventId, subId } = await makeBooking()
    await menus.saveSubEventMenu(bm, subId, { tierId: await tierId('Silver'), selections: { 'Paneer Main Course': ['Kadai Paneer'] } })
    await db.update(schema.events).set({ status: 'locked' }).where(eq(schema.events.id, eventId))

    await gm.editProposalAsAuthority(ha, eventId, {
      menus: [{ subEventId: subId, categoryName: 'Paneer Main Course', dishes: ['Kadai Paneer', 'Handi Paneer'] }],
      reason: 'Guest swapped a dish after the lock',
    })

    const cat = (await menus.getSubEventMenu(subId)).menu!.categories.find((c) => c.categoryName === 'Paneer Main Course')!
    expect([...cat.selected].sort()).toEqual(['Handi Paneer', 'Kadai Paneer'])
  }, SLOW)

  it('treats an unchanged room list as a no-op, burning no document number', async () => {
    const { eventId } = await makeBooking()
    const regency = await unitId('Regency')
    const line = { unitId: regency, roomType: 'deluxe', count: 4, checkIn: '2026-09-01', checkOut: '2026-09-03' }
    await roomsSvc.saveRoomRequirements(bm, eventId, [line])

    // Re-submitting the same rooms must change nothing: the screen posts the whole list
    // whenever it is touched, and a phantom change would re-issue a billed guest's document.
    const res = await gm.editProposalAsAuthority(ha, eventId, { rooms: [line] })
    expect(res.changes).toEqual([])
    expect(res.invoiceReissued).toBe(false)
  }, SLOW)

  it('still cannot conjure rooms the lodge does not have', async () => {
    // The Authority outranks the workflow, not the building.
    const { eventId } = await makeBooking()
    await expect(
      gm.editProposalAsAuthority(ha, eventId, {
        rooms: [{ unitId: await unitId('Regency'), roomType: 'deluxe', count: 9_999, checkIn: '2026-09-01', checkOut: '2026-09-03' }],
      }),
    ).rejects.toMatchObject({ status: 409 })
  }, SLOW)
})

d('the Authority’s own discount', () => {
  it('is uncapped, immediately effective, and needs no approval', async () => {
    const { eventId, subId } = await makeBooking()
    await menus.saveSubEventMenu(bm, subId, { tierId: await tierId('Silver'), selections: { 'Paneer Main Course': ['Kadai Paneer'] } })
    const before = await discounts.effectiveDiscountPaise(eventId)

    // Far over BR-D2's 10%: from anyone else this defers behind an exception.
    await gm.editProposalAsAuthority(ha, eventId, {
      addDiscounts: [{ head: 'overall', amountPaise: 5_000_00, remark: 'Owner’s instruction' }],
    })

    const after = await discounts.effectiveDiscountPaise(eventId)
    expect(after - before).toBe(5_000_00)
    // No exception was raised against himself — he IS the approver.
    const [{ n }] = (await db.execute(sql`
      SELECT count(*)::int AS n FROM exceptions WHERE event_id = ${eventId} AND kind = 'discount_over_cap'
    `)) as unknown as { n: number }[]
    expect(n).toBe(0)
  }, SLOW)

  it('removing an over-cap discount resolves its ask instead of failing the bundle', async () => {
    // The GM's answer to "may we give 50%?" can be "no, take it off". Removing the discount
    // deletes the pending exception with it, so the decision that referred to it has nothing
    // left to settle — it is skipped, not treated as an error that rolls back everything else.
    const { eventId, subId } = await makeBooking()
    await menus.saveSubEventMenu(bm, subId, { tierId: await tierId('Silver'), selections: { 'Paneer Main Course': ['Kadai Paneer'] } })
    const { exceptionId, discountId } = (await discounts.addDiscount(bm, eventId, {
      head: 'overall', percentBp: 5000, remark: 'Owner’s friend',
    })) as { exceptionId: string; discountId: string }
    expect(exceptionId).toBeTruthy()

    const res = await bundles.decideBundle(ha, eventId, {
      decisions: [{ id: exceptionId, source: 'exception', action: 'approve' }],
      edits: { removeDiscountIds: [discountId] },
    })
    expect(res.skipped).toEqual([exceptionId])
    expect(res.remaining).toBe(0)
    expect(await discounts.effectiveDiscountPaise(eventId)).toBe(0)
  }, SLOW)

  it('flows into the bill like any other discount', async () => {
    const { eventId, subId } = await makeBooking()
    await menus.saveSubEventMenu(bm, subId, { tierId: await tierId('Silver'), selections: { 'Paneer Main Course': ['Kadai Paneer'] } })
    await gm.editProposalAsAuthority(ha, eventId, {
      addDiscounts: [{ head: 'overall', amountPaise: 1_000_00, remark: 'Goodwill' }],
    })
    await db.transaction(async (tx) => { await invoice.draftInvoice(tx, auditor, eventId) })
    expect((await invoice.getInvoice(eventId))!.discountPaise).toBe(1_000_00)
  }, SLOW)
})
