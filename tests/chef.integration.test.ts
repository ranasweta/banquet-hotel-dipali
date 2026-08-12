/**
 * Chef delicacy requests (client, 19 Jul 2026): an off-menu ask that only the Chef prices,
 * charged PER PLATE so it joins the tier rate + wedding surcharge in the food line.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { eq, sql } from 'drizzle-orm'

const chef = await import('@/lib/chef')
const daysheet = await import('@/lib/daysheet')
const menus = await import('@/lib/menus')
const invoice = await import('@/lib/invoice')
const pricing = await import('@/lib/pricing')
const { createClient } = await import('@/db/client')
const { migrate } = await import('@/db/migrate')
const { seed } = await import('@/db/seed')
const { db, schema } = await import('@/db/drizzle')

const hasDb = Boolean(process.env.TEST_DATABASE_URL)
const d = hasDb ? describe : describe.skip
if (!hasDb) console.warn('\n  ! TEST_DATABASE_URL unset — skipping chef tests\n')

const bm = { id: '', roleName: 'booking_manager' }
const theChef = { id: '', roleName: 'chef' }

async function userOf(role: string): Promise<string> {
  const [u] = await db
    .select({ id: schema.users.id })
    .from(schema.users)
    .innerJoin(schema.roles, eq(schema.roles.id, schema.users.roleId))
    .where(eq(schema.roles.name, role))
    .limit(1)
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
/** An enquiry with one 100-pax function; returns { eventId, subId }. */
async function makeSub(): Promise<{ eventId: string; subId: string }> {
  const [{ code }] = (await db.execute(sql`SELECT 'E-' || nextval('event_code_seq') AS code`)) as unknown as { code: string }[]
  const [event] = await db
    .insert(schema.events)
    .values({ code, guestName: 'Chef Test', eventType: 'engagement', createdBy: bm.id })
    .returning({ id: schema.events.id })
  const [sub] = await db
    .insert(schema.subEvents)
    .values({ eventId: event!.id, name: 'Dinner', eventDate: '2026-09-01', startTime: '19:00', endTime: '23:00', venueId: await venueId('Crystal'), pax: 100 })
    .returning({ id: schema.subEvents.id })
  return { eventId: event!.id, subId: sub!.id }
}
async function proposalTotal(eventId: string): Promise<number> {
  const [e] = await db.select({ t: schema.events.proposalTotalPaise }).from(schema.events).where(eq(schema.events.id, eventId)).limit(1)
  return e!.t
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
  bm.id = await userOf('booking_manager')
  theChef.id = await userOf('chef')
}, 90_000)

async function cleanup() {
  await db.delete(schema.venueBookings)
  await db.delete(schema.events)
}
afterEach(async () => { if (hasDb) await cleanup() })
afterAll(async () => { if (hasDb) await cleanup() })

d('chef delicacy', () => {
  it('is priced only by the Chef, per plate, and moves the proposal total', async () => {
    const { eventId, subId } = await makeSub()
    await menus.saveSubEventMenu(bm, subId, { tierId: await tierId('Silver'), selections: {} })
    const before = await proposalTotal(eventId)

    const { id } = await chef.requestDelicacy(bm, subId, 'Sushi counter for the head table')

    // A Booking Manager cannot put a price on it.
    await expect(chef.priceDelicacy(bm, id, { chargePaise: 12_000 })).rejects.toMatchObject({ status: 403 })

    // The Chef can. Rs. 120 per plate on a 100-pax function = Rs. 12,000 more.
    await chef.priceDelicacy(theChef, id, { chargePaise: 12_000, remark: 'imported fish' })
    expect(await proposalTotal(eventId)).toBe(before + 12_000 * 100)

    // It shows on the function's per-plate rate: Silver 650 + 120 = 770.
    const snap = await menus.getSubEventMenu(subId)
    expect(snap.menu!.perPlatePaise + (await chef.delicacyChargePaise(db, subId))).toBe(65_000 + 12_000)

    // Pricing twice is refused.
    await expect(chef.priceDelicacy(theChef, id, { chargePaise: 999 })).rejects.toMatchObject({ status: 409 })
  })

  it('declining costs nothing and leaves no charge', async () => {
    const { eventId, subId } = await makeSub()
    await menus.saveSubEventMenu(bm, subId, { tierId: await tierId('Silver'), selections: {} })
    const before = await proposalTotal(eventId)

    const { id } = await chef.requestDelicacy(bm, subId, 'Live teppanyaki')
    await chef.priceDelicacy(theChef, id, { decline: true, remark: 'no equipment' })

    expect(await proposalTotal(eventId)).toBe(before)
    expect(await chef.delicacyChargePaise(db, subId)).toBe(0)
    const list = await chef.listForSubEvent(subId)
    expect(list[0]!.status).toBe('declined')
    expect(list[0]!.chargePaise).toBeNull()
  })

  it('rejects an empty description', async () => {
    const { subId } = await makeSub()
    await expect(chef.requestDelicacy(bm, subId, '   ')).rejects.toThrow(/Describe/)
  })

  /**
   * The bill lines and the payment schedule read the same booking, so they must reach the
   * same food figure. They did not: `foodAndAddonTotal` counted a priced delicacy and
   * `computeBillLines` did not, so the Draft the guest holds was pax × the charge cheaper
   * than the balance the payment review was asking them for.
   */
  it('appears on the Draft, and the Draft agrees with the payment review', async () => {
    const { eventId, subId } = await makeSub()
    await menus.saveSubEventMenu(bm, subId, { tierId: await tierId('Silver'), selections: {} })

    const { id } = await chef.requestDelicacy(bm, subId, 'Meethi sewai')
    await chef.priceDelicacy(theChef, id, { chargePaise: 9_000 })

    const lines = await invoice.computeBillLines(db, eventId)
    const delicacyLine = lines.find((l) => l.description.includes('Meethi sewai'))
    expect(delicacyLine).toBeDefined()
    expect(delicacyLine!.section).toBe('food')
    expect(delicacyLine!.amountPaise).toBe(9_000 * 100)

    const billedFood = lines.filter((l) => l.section === 'food').reduce((s, l) => s + l.amountPaise, 0)
    const { foodPaise, addonPaise } = await pricing.foodAndAddonTotal(eventId)
    expect(billedFood).toBe(foodPaise + addonPaise)
  })

  it('leaves a declined or unpriced delicacy off the Draft entirely', async () => {
    const { eventId, subId } = await makeSub()
    await menus.saveSubEventMenu(bm, subId, { tierId: await tierId('Silver'), selections: {} })

    const declined = await chef.requestDelicacy(bm, subId, 'Live teppanyaki')
    await chef.priceDelicacy(theChef, declined.id, { decline: true, remark: 'no equipment' })
    await chef.requestDelicacy(bm, subId, 'Still being thought about')

    const lines = await invoice.computeBillLines(db, eventId)
    expect(lines.some((l) => l.description.startsWith('Chef delicacy:'))).toBe(false)

    const billedFood = lines.filter((l) => l.section === 'food').reduce((s, l) => s + l.amountPaise, 0)
    const { foodPaise, addonPaise } = await pricing.foodAndAddonTotal(eventId)
    expect(billedFood).toBe(foodPaise + addonPaise)
  })

  /**
   * The kitchen's own list, on both screens that carry it. A priced delicacy is part of what
   * goes out; one still with the Chef is not agreed, and the floor has to tell the two apart
   * before it plans around the dish. A declined ask is on neither — nobody cooks it.
   */
  it('reaches the board and the day sheet, with an unpriced ask marked pending', async () => {
    const { eventId, subId } = await makeSub()
    // Operations sees confirmed bookings and beyond; an enquiry never reaches the kitchen.
    await db.update(schema.events).set({ status: 'confirmed' }).where(eq(schema.events.id, eventId))
    await menus.saveSubEventMenu(bm, subId, { tierId: await tierId('Silver'), selections: {} })

    const priced = await chef.requestDelicacy(bm, subId, 'Live sushi counter')
    await chef.priceDelicacy(theChef, priced.id, { chargePaise: 12_000 })
    await chef.requestDelicacy(bm, subId, 'Teppanyaki, still being thought about')
    const declined = await chef.requestDelicacy(bm, subId, 'Live oysters')
    await chef.priceDelicacy(theChef, declined.id, { decline: true, remark: 'no supplier' })

    const board = await daysheet.getOperationsHorizon('2026-09-01', 1, '2026-09-01')
    const fn = board.days[0]!.functions.find((f) => f.subEventId === subId)!
    expect(fn.chefDishes).toHaveLength(2) // the declined ask is not one of them
    expect(fn.chefDishes).toContainEqual({ description: 'Live sushi counter', pending: false })
    expect(fn.chefDishes).toContainEqual({ description: 'Teppanyaki, still being thought about', pending: true })

    const sheet = await daysheet.getDaySheet('2026-09-01')
    expect(sheet.functions.find((f) => f.subEventId === subId)!.chefDishes).toEqual(fn.chefDishes)
  })
})
