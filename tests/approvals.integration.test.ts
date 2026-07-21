/**
 * M6 acceptance (the approvals queue, FR-6.x):
 *
 *   - approving a menu-increase exception APPLIES the extra pick (extra_picks bumped);
 *   - rejecting reverts (pick unchanged) and surfaces the remark to the booking manager.
 *
 * Plus: only the Authority may decide, reject needs a remark, an already-decided exception
 * can't be re-decided, approve_modified applies a modified pick, and approving a 35+ room
 * exception inserts the held rooms. Drives lib/approvals against the test database, with the
 * exceptions created through the real M4/M5 flows so the payloads are authentic.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { eq, sql } from 'drizzle-orm'

const approvals = await import('@/lib/approvals')
const menus = await import('@/lib/menus')
const roomsSvc = await import('@/lib/rooms')
const { createClient } = await import('@/db/client')
const { migrate } = await import('@/db/migrate')
const { seed } = await import('@/db/seed')
const { db, schema } = await import('@/db/drizzle')

const hasDb = Boolean(process.env.TEST_DATABASE_URL)
const d = hasDb ? describe : describe.skip
if (!hasDb) console.warn('\n  ! TEST_DATABASE_URL unset — skipping approvals tests\n')

const bm = { id: '', roleName: 'booking_manager' }
const lm = { id: '', roleName: 'lodge_manager' }
const ha = { id: '', roleName: 'higher_authority' }

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

async function makeSubEvent(): Promise<{ eventId: string; subId: string }> {
  const [{ code }] = (await db.execute(sql`SELECT 'E-' || nextval('event_code_seq') AS code`)) as unknown as { code: string }[]
  const [event] = await db.insert(schema.events).values({ code, guestName: 'Approvals Test', eventType: 'engagement', status: 'confirmed', createdBy: bm.id }).returning({ id: schema.events.id })
  const [sub] = await db.insert(schema.subEvents).values({ eventId: event!.id, name: 'Function', eventDate: '2026-09-01', startTime: '19:00', endTime: '23:00', venueId: await venueId('Crystal'), pax: 200 }).returning({ id: schema.subEvents.id })
  return { eventId: event!.id, subId: sub!.id }
}
/**
 * A proposal whose menu increases have been submitted for approval. Increases unlock a
 * segment for unlimited picking (21 Jul 2026) and reach the Authority when the function's
 * submit button is pressed, so the fixture drives the real path: unlock, over-pick past
 * the free two, submit.
 */
async function menuIncreaseException(): Promise<{ subId: string; excId: string }> {
  const { subId } = await makeSubEvent()
  const silver = await tierId('Silver')
  await menus.saveSubEventMenu(bm, subId, { tierId: silver, selections: { 'Paneer Main Course': ['Kadai Paneer'] } })
  await menus.increaseCategory(bm, subId, 'Paneer Main Course')
  // Five on a base of one: four extras, two of them free, so TWO reach the Authority and a
  // partial approval has something to roll out.
  await menus.saveSubEventMenu(bm, subId, {
    tierId: silver,
    selections: { 'Paneer Main Course': ['Kadai Paneer', 'Handi Paneer', 'Mutter Paneer', 'Paneer Lababdar', 'Paneer Makhani'] },
  })

  const { exceptionId } = await menus.submitIncreases(bm, subId)
  if (!exceptionId) throw new Error('expected an increase awaiting approval')
  return { subId, excId: exceptionId }
}
function paneerPick(subId: string) {
  return menus.getSubEventMenu(subId).then((m) => m.menu!.categories.find((c) => c.categoryName === 'Paneer Main Course')!)
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
  lm.id = await userId('lodge_manager')
  ha.id = await userId('higher_authority')
}, 90_000)

async function cleanup() {
  await db.delete(schema.venueBookings)
  await db.delete(schema.events)
}
afterEach(async () => { if (hasDb) await cleanup() })
afterAll(async () => { if (hasDb) await cleanup() })

d('menu-increase decisions (acceptance)', () => {
  it('APPROVING sanctions picks the manager is already using', async () => {
    // The picks were applied when they were chosen, days earlier. Approval confirms them.
    const { subId, excId } = await menuIncreaseException()
    const before = await paneerPick(subId)
    expect(before.extraPicks).toBe(4) // already in use: 2 free + 2 submitted
    expect(before.exceptionPending).toBe(true)

    const res = await approvals.decideException(ha, excId, { action: 'approve' })
    expect(res.status).toBe('approved')

    const cat = await paneerPick(subId)
    expect(cat.extraPicks).toBe(4) // unchanged — nothing was being withheld
    expect(cat.effectivePick).toBe(5) // base 1 + 4
    expect(cat.exceptionPending).toBe(false)
  })

  it('REJECTING drops the submitted dishes but leaves the free two alone', async () => {
    // A rejection has something real to undo, because the picks were already applied — but
    // the free allowance was never the Authority's to refuse.
    const { subId, excId } = await menuIncreaseException()
    const res = await approvals.decideException(ha, excId, { action: 'reject', remark: 'Kitchen cannot support a fifth paneer' })
    expect(res.status).toBe('rejected')

    const cat = await paneerPick(subId)
    expect(cat.extraPicks).toBe(2) // the two submitted went; the two free stayed
    expect(cat.effectivePick).toBe(3)
    expect(cat.exceptionPending).toBe(false)
    expect(cat.exceptionStatus).toBe('rejected')
    expect(cat.exceptionRemark).toBe('Kitchen cannot support a fifth paneer')
  })

  it('APPROVE_MODIFIED keeps what was granted and rolls the rest out', async () => {
    // "If he approves partially then that other will roll out" — two were asked for, one
    // is granted, one goes.
    const { subId, excId } = await menuIncreaseException()
    const res = await approvals.decideException(ha, excId, {
      action: 'approve_modified',
      remark: 'One extra only',
      modified: { extraPicks: 1 },
    })
    expect(res.status).toBe('approved_modified')

    const cat = await paneerPick(subId)
    expect(cat.extraPicks).toBe(3) // 2 free + 1 granted; the refused one rolled out
    expect(cat.effectivePick).toBe(4)
  })
})

d('decision guards', () => {
  it('rejects without a remark → 400', async () => {
    const { excId } = await menuIncreaseException()
    await expect(approvals.decideException(ha, excId, { action: 'reject' })).rejects.toMatchObject({ status: 400 })
  })

  it('only the Authority may decide (a booking manager is forbidden)', async () => {
    const { excId } = await menuIncreaseException()
    await expect(approvals.decideException(bm, excId, { action: 'approve' })).rejects.toMatchObject({ status: 403 })
  })

  it('cannot re-decide an already-decided exception → 409', async () => {
    const { excId } = await menuIncreaseException()
    await approvals.decideException(ha, excId, { action: 'approve' })
    await expect(approvals.decideException(ha, excId, { action: 'reject', remark: 'too late' })).rejects.toMatchObject({ status: 409 })
  })
})

d('room-allocation (BR-L2) decisions', () => {
  /** A confirmed event holding `lines` worth of rooms booked in bulk on the proposal. */
  async function bigBooking() {
    const [{ code }] = (await db.execute(sql`SELECT 'E-' || nextval('event_code_seq') AS code`)) as unknown as { code: string }[]
    const [event] = await db.insert(schema.events).values({ code, guestName: 'Big Wedding', eventType: 'engagement', status: 'confirmed', createdBy: bm.id }).returning({ id: schema.events.id })
    const [palace] = (await db.execute(sql`SELECT id FROM lodging_units WHERE name = 'Palace'`)) as unknown as { id: string }[]
    // 33 deluxe + 3 suite = 36, over the threshold and within Palace's real inventory.
    const res = await roomsSvc.saveRoomRequirements(bm, event!.id, [
      { unitId: palace!.id, roomType: 'deluxe', count: 33, checkIn: '2026-10-01', checkOut: '2026-10-03' },
      { unitId: palace!.id, roomType: 'suite', count: 3, checkIn: '2026-10-01', checkOut: '2026-10-03' },
    ])
    return { eventId: event!.id, res }
  }

  it('raises one request for the whole proposal when it crosses 35', async () => {
    const { eventId, res } = await bigBooking()
    expect(res.deferred).toBe(true)
    expect(res.totalRooms).toBe(36)

    // The rooms ARE saved — the request gates confirm and the lock, it does not hold them.
    const [{ n }] = (await db.execute(sql`SELECT count(*)::int AS n FROM room_requirements WHERE event_id = ${eventId}`)) as unknown as { n: number }[]
    expect(n).toBe(2)
  })

  it('APPROVES a bulk room request instead of dying on an empty allocation list', async () => {
    // The raise path writes `payload.lines`; the decide path used to read
    // `payload.allocations` and throw "No rooms to allocate", so every one of these
    // failed. Nothing is inserted on approval — the requirement already is the booking.
    const { eventId } = await bigBooking()
    const [exc] = await db
      .select({ id: schema.exceptions.id })
      .from(schema.exceptions)
      .where(eq(schema.exceptions.eventId, eventId))
      .limit(1)

    const decision = await approvals.decideException(ha, exc!.id, { action: 'approve' })
    expect(decision.status).toBe('approved')
    expect(decision.applied).toMatch(/36 room/)
  })

  it('summarises the request without NaN', async () => {
    const { eventId } = await bigBooking()
    const rows = await approvals.listExceptions({ status: 'pending' })
    const row = rows.find((r) => r.eventId === eventId)!
    expect(row.summary).toContain('36 room(s)')
    expect(row.summary).not.toContain('NaN')
  })

  it('clears the request when the booking drops back under the threshold', async () => {
    const { eventId } = await bigBooking()
    const [palace] = (await db.execute(sql`SELECT id FROM lodging_units WHERE name = 'Palace'`)) as unknown as { id: string }[]
    const res = await roomsSvc.saveRoomRequirements(bm, eventId, [
      { unitId: palace!.id, roomType: 'deluxe', count: 4, checkIn: '2026-10-01', checkOut: '2026-10-03' },
    ])
    expect(res.deferred).toBe(false)
    const pending = await db.select().from(schema.exceptions).where(eq(schema.exceptions.eventId, eventId))
    expect(pending.filter((p) => p.status === 'pending')).toHaveLength(0)
  })
})

d('queue listing', () => {
  it('lists pending exceptions with event context and a change summary', async () => {
    await menuIncreaseException()
    const pending = await approvals.listExceptions({ status: 'pending' })
    expect(pending.length).toBeGreaterThanOrEqual(1)
    const row = pending[0]!
    expect(row.kind).toBe('menu_increase')
    expect(row.summary).toMatch(/Paneer Main Course/)
    expect(row.eventCode).toMatch(/^E-/)
    expect(row.raisedByName).toBeTruthy()
  })
})
