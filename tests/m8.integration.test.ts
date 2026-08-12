/**
 * M8 acceptance (maintenance + day sheet + change requests — FR-5.x, FR-2.4, FR-1.9):
 *
 *   - maintenance is blocked before In Progress and after lock (and after close);
 *   - the day sheet shows every sub-event of a date with its menu.
 *
 * Plus: change requests move a confirmed sub-event's slot on Higher-Authority approval, clash
 * cleanly (409) when the new slot is taken, need a remark to reject, and are Authority-only
 * (the Banquet Manager approves nothing since 21 Jul 2026).
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { eq, sql } from 'drizzle-orm'

const maint = await import('@/lib/maintenance')
const daysheet = await import('@/lib/daysheet')
const changes = await import('@/lib/change-requests')
const menus = await import('@/lib/menus')
const { createClient } = await import('@/db/client')
const { migrate } = await import('@/db/migrate')
const { seed } = await import('@/db/seed')
const { db, schema } = await import('@/db/drizzle')

const hasDb = Boolean(process.env.TEST_DATABASE_URL)
const d = hasDb ? describe : describe.skip
if (!hasDb) console.warn('\n  ! TEST_DATABASE_URL unset — skipping M8 tests\n')

const bm = { id: '', roleName: 'booking_manager' }
const bq = { id: '', roleName: 'banquet_manager' }
const mt = { id: '', roleName: 'maintenance' }
const ha = { id: '', roleName: 'higher_authority' }

async function userId(role: string): Promise<string> {
  const [u] = await db.select({ id: schema.users.id }).from(schema.users).innerJoin(schema.roles, eq(schema.roles.id, schema.users.roleId)).where(eq(schema.roles.name, role)).limit(1)
  return u!.id
}
async function venueId(name: string): Promise<string> {
  const [v] = await db.select({ id: schema.venues.id }).from(schema.venues).where(eq(schema.venues.name, name)).limit(1)
  return v!.id
}
async function tierId(name: string): Promise<string> {
  const [t] = await db.select({ id: schema.menuTiers.id }).from(schema.menuTiers).where(eq(schema.menuTiers.name, name)).limit(1)
  return t!.id
}
async function makeEvent(status: string): Promise<string> {
  const [{ code }] = (await db.execute(sql`SELECT 'E-' || nextval('event_code_seq') AS code`)) as unknown as { code: string }[]
  const [e] = await db.insert(schema.events).values({ code, guestName: 'M8 Test', eventType: 'engagement', status: status as 'confirmed', createdBy: bm.id }).returning({ id: schema.events.id })
  return e!.id
}
/** A confirmed event with one sub-event and its venue booking (the move/clash fixtures). */
async function makeConfirmedSub(venue: string, date: string, start: string, end: string): Promise<{ eventId: string; subId: string }> {
  const eventId = await makeEvent('confirmed')
  await db.update(schema.events).set({ firstDate: date, lastDate: date }).where(eq(schema.events.id, eventId))
  const vId = await venueId(venue)
  const [sub] = await db.insert(schema.subEvents).values({ eventId, name: 'Function', eventDate: date, startTime: start, endTime: end, venueId: vId, pax: 200 }).returning({ id: schema.subEvents.id })
  await db.execute(sql`
    INSERT INTO venue_bookings (venue_id, sub_event_id, event_id, occupancy)
    VALUES (${vId}, ${sub!.id}, ${eventId}, tsrange((${date}::date + ${start}::time), (${date}::date + ${end}::time), '[)'))
  `)
  return { eventId, subId: sub!.id }
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
  bq.id = await userId('banquet_manager')
  mt.id = await userId('maintenance')
  ha.id = await userId('higher_authority')
}, 90_000)

async function cleanup() {
  await db.delete(schema.venueBookings)
  await db.delete(schema.events)
}
afterEach(async () => { if (hasDb) await cleanup() })
afterAll(async () => { if (hasDb) await cleanup() })

d('maintenance gating (FR-5.1/5.2)', () => {
  const entry = { item: 'Generator (extra hours)', qty: 3, unit: 'hrs', ratePaise: 100_000 }

  it('is blocked before In Progress and after lock', async () => {
    const confirmed = await makeEvent('confirmed')
    await expect(maint.addEntry(mt, confirmed, entry)).rejects.toThrow(/In Progress/)
    const locked = await makeEvent('locked')
    await expect(maint.addEntry(mt, locked, entry)).rejects.toThrow(/In Progress/)
  })

  it('allows entries In Progress and computes the amount, then freezes on close', async () => {
    const e = await makeEvent('in_progress')
    const r = await maint.addEntry(mt, e, entry)
    expect(r.amountPaise).toBe(300_000) // 3 hrs × ₹1,000

    const view = await maint.listEntries(e)
    expect(view.totalPaise).toBe(300_000)
    expect(view.closed).toBe(false)

    await maint.closeMaintenance(mt, e)
    const closed = await maint.listEntries(e)
    expect(closed.closed).toBe(true)
    expect(closed.entries[0]!.isClosed).toBe(true)

    // After close: no new entries, no edits.
    await expect(maint.addEntry(mt, e, entry)).rejects.toThrow(/closed/)
    await expect(maint.updateEntry(mt, closed.entries[0]!.id, { qty: 5 })).rejects.toThrow(/closed/)
  })

  it('only the entry’s author (or Auditor) may edit', async () => {
    const e = await makeEvent('in_progress')
    const r = await maint.addEntry(mt, e, entry)
    await expect(maint.updateEntry(bq, r.id, { qty: 2 })).rejects.toMatchObject({ status: 403 })
  })
})

d('day sheet (FR-2.4)', () => {
  it('shows every sub-event of a date with its menu', async () => {
    const { subId } = await makeConfirmedSub('Crystal', '2026-10-05', '19:00', '23:00')
    await menus.saveSubEventMenu(bm, subId, { tierId: await tierId('Silver'), selections: { Soup: ['Hot & Sour Soup'] } })

    const sheet = await daysheet.getDaySheet('2026-10-05')
    expect(sheet.functions.length).toBeGreaterThanOrEqual(1)
    const fn = sheet.functions.find((f) => f.subEventId === subId)!
    expect(fn.venueName).toBe('Crystal')
    expect(fn.pax).toBe(200)
    expect(fn.menu?.tierName).toBe('Silver')
    const soup = fn.menu?.categories.find((c) => c.name === 'Soup')
    expect(soup?.items).toContain('Hot & Sour Soup')

    // Not one rupee in the payload. The route is gated on `calendar:view`, which the Banquet
    // Manager and the Chef hold and which grants nothing in billing, so money is dropped at
    // the query — the same rule the operations board is held to.
    expect(JSON.stringify(sheet)).not.toMatch(/[Pp]aise|perPlate/)

    // A different date shows nothing of this event.
    expect((await daysheet.getDaySheet('2026-10-06')).functions.some((f) => f.subEventId === subId)).toBe(false)
  })
})

d('change requests (FR-1.9)', () => {
  it('moves a confirmed sub-event on Higher-Authority approval and re-books the slot', async () => {
    const { subId, eventId } = await makeConfirmedSub('Crystal', '2026-11-01', '10:00', '14:00')
    const cr = await changes.requestChange(bm, subId, { payload: { eventDate: '2026-11-03' }, reason: 'guest asked' })
    const res = await changes.decideChange(ha, cr.id, { action: 'approve' })
    expect(res.status).toBe('approved')

    const [se] = await db.select({ eventDate: schema.subEvents.eventDate }).from(schema.subEvents).where(eq(schema.subEvents.id, subId))
    expect(se!.eventDate).toBe('2026-11-03')
    // The venue booking moved with it.
    const [{ n }] = (await db.execute(sql`SELECT count(*)::int AS n FROM venue_bookings WHERE sub_event_id = ${subId} AND lower(occupancy)::date = '2026-11-03'`)) as unknown as { n: number }[]
    expect(n).toBe(1)
    const [ev] = await db.select({ firstDate: schema.events.firstDate }).from(schema.events).where(eq(schema.events.id, eventId))
    expect(ev!.firstDate).toBe('2026-11-03')
  })

  it('clashes cleanly (409) when the requested slot is already taken', async () => {
    const a = await makeConfirmedSub('Signature', '2026-11-10', '10:00', '14:00')
    await makeConfirmedSub('Signature', '2026-11-11', '10:00', '14:00') // occupies the target
    const cr = await changes.requestChange(bm, a.subId, { payload: { eventDate: '2026-11-11' } })
    await expect(changes.decideChange(ha, cr.id, { action: 'approve' })).rejects.toMatchObject({ status: 409 })
    // The original booking is untouched (still on the 10th).
    const [se] = await db.select({ eventDate: schema.subEvents.eventDate }).from(schema.subEvents).where(eq(schema.subEvents.id, a.subId))
    expect(se!.eventDate).toBe('2026-11-10')
  })

  it('needs a remark to reject and is Higher-Authority only', async () => {
    const { subId } = await makeConfirmedSub('Kohinoor', '2026-11-20', '10:00', '14:00')
    const cr = await changes.requestChange(bm, subId, { payload: { startTime: '11:00', endTime: '15:00' } })
    await expect(changes.decideChange(ha, cr.id, { action: 'reject' })).rejects.toMatchObject({ status: 400 })
    // The Banquet Manager no longer decides venue/timing moves (client, 21 Jul 2026).
    await expect(changes.decideChange(bq, cr.id, { action: 'approve' })).rejects.toMatchObject({ status: 403 })
  })

  it('applies a pax change directly (no approval)', async () => {
    const { subId } = await makeConfirmedSub('Crystal', '2026-11-25', '10:00', '14:00')
    await changes.changePax(bm, subId, 275)
    const [se] = await db.select({ pax: schema.subEvents.pax }).from(schema.subEvents).where(eq(schema.subEvents.id, subId))
    expect(se!.pax).toBe(275)
  })
})
