/**
 * M6 acceptance (the approvals queue, FR-6.x):
 *
 *   - approving a menu-increase exception APPLIES the extra pick (extra_picks bumped);
 *   - rejecting reverts (pick unchanged) and surfaces the remark to the booking manager.
 *
 * Plus: only the Authority may decide, reject needs a remark, an already-decided exception
 * can't be re-decided, and approve_modified applies a modified pick. Drives lib/approvals
 * against the test database, with the exceptions created through the real M4 flow so the
 * payloads are authentic.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { eq, sql } from 'drizzle-orm'

const approvals = await import('@/lib/approvals')
const menus = await import('@/lib/menus')
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
