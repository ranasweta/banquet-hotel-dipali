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
async function regencyRooms(n: number): Promise<string[]> {
  const rows = (await db.execute(sql`
    SELECT r.id FROM rooms r JOIN lodging_units u ON u.id = r.unit_id
    WHERE u.name = 'Regency' AND r.is_active ORDER BY r.room_no LIMIT ${n}
  `)) as unknown as { id: string }[]
  return rows.map((r) => r.id)
}

async function makeSubEvent(): Promise<{ eventId: string; subId: string }> {
  const [{ code }] = (await db.execute(sql`SELECT 'E-' || nextval('event_code_seq') AS code`)) as unknown as { code: string }[]
  const [event] = await db.insert(schema.events).values({ code, guestName: 'Approvals Test', eventType: 'engagement', status: 'confirmed', createdBy: bm.id }).returning({ id: schema.events.id })
  const [sub] = await db.insert(schema.subEvents).values({ eventId: event!.id, name: 'Function', eventDate: '2026-09-01', startTime: '19:00', endTime: '23:00', venueId: await venueId('Crystal'), pax: 200 }).returning({ id: schema.subEvents.id })
  return { eventId: event!.id, subId: sub!.id }
}
/** A saved menu with a pending increase exception on an ineligible category (paneer). */
async function menuIncreaseException(): Promise<{ subId: string; excId: string }> {
  const { subId } = await makeSubEvent()
  await menus.saveSubEventMenu(bm, subId, { tierId: await tierId('Silver'), selections: { 'Paneer Main Course': ['Kadai Paneer'] } })
  const res = await menus.increaseCategory(bm, subId, 'Paneer Main Course')
  if (res.applied !== 'exception') throw new Error('expected an exception')
  return { subId, excId: res.exceptionId }
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
  it('APPROVING applies the extra pick', async () => {
    const { subId, excId } = await menuIncreaseException()
    expect((await paneerPick(subId)).extraPicks).toBe(0) // deferred, not yet applied
    expect((await paneerPick(subId)).exceptionPending).toBe(true)

    const res = await approvals.decideException(ha, excId, { action: 'approve' })
    expect(res.status).toBe('approved')

    const cat = await paneerPick(subId)
    expect(cat.extraPicks).toBe(1) // the pick is now applied
    expect(cat.effectivePick).toBe(2) // base 1 + 1
    expect(cat.exceptionPending).toBe(false)
  })

  it('REJECTING leaves the pick untouched and surfaces the remark to the booking manager', async () => {
    const { subId, excId } = await menuIncreaseException()
    const res = await approvals.decideException(ha, excId, { action: 'reject', remark: 'Kitchen cannot support a fifth paneer' })
    expect(res.status).toBe('rejected')

    const cat = await paneerPick(subId)
    expect(cat.extraPicks).toBe(0) // reverted / never applied
    expect(cat.effectivePick).toBe(1)
    expect(cat.exceptionPending).toBe(false)
    expect(cat.exceptionStatus).toBe('rejected')
    expect(cat.exceptionRemark).toBe('Kitchen cannot support a fifth paneer')
  })

  it('APPROVE_MODIFIED applies a modified pick delta', async () => {
    const { subId, excId } = await menuIncreaseException()
    const res = await approvals.decideException(ha, excId, { action: 'approve_modified', remark: 'Two extra, not one', modified: { extraPicks: 2 } })
    expect(res.status).toBe('approved_modified')
    expect((await paneerPick(subId)).extraPicks).toBe(2)
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
  it('approving a 35+ exception inserts the held rooms', async () => {
    const [{ code }] = (await db.execute(sql`SELECT 'E-' || nextval('event_code_seq') AS code`)) as unknown as { code: string }[]
    const [event] = await db.insert(schema.events).values({ code, guestName: 'Big Wedding', eventType: 'engagement', status: 'confirmed', createdBy: bm.id }).returning({ id: schema.events.id })
    const ids = await regencyRooms(35)
    const res = await roomsSvc.allocateRooms(lm, event!.id, ids.map((roomId) => ({ roomId, checkIn: '2026-10-01', checkOut: '2026-10-03' })))
    expect(res.deferred).toBe(true)
    const excId = (res as { exceptionId: string }).exceptionId

    // Nothing committed yet.
    const [{ before }] = (await db.execute(sql`SELECT count(*)::int AS before FROM room_allocations WHERE event_id = ${event!.id}`)) as unknown as { before: number }[]
    expect(before).toBe(0)

    const decision = await approvals.decideException(ha, excId, { action: 'approve' })
    expect(decision.applied).toMatch(/35 room/)
    const [{ after }] = (await db.execute(sql`SELECT count(*)::int AS after FROM room_allocations WHERE event_id = ${event!.id}`)) as unknown as { after: number }[]
    expect(after).toBe(35)
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
