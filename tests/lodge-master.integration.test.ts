/**
 * The lodge master (module `lodge_master`, client 13 Aug 2026).
 *
 * The rule this file exists to defend is that **inventory can never drop below what has been
 * promised**. The hard cap (rule 9) refuses "40 deluxe when 27 exist"; it would be worth
 * nothing if the Auditor could quietly delete the 27th room after a guest was told they had
 * it. So a reduction is measured against the busiest committed NIGHT, and refused with the
 * number that blocks it.
 *
 * The rest is the category bookkeeping: the screen edits {count, rate} while the table holds
 * one row per physical room, and those two must not drift apart.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { sql } from 'drizzle-orm'

const master = await import('@/lib/lodge-master')
const rooms = await import('@/lib/rooms')
const { createClient } = await import('@/db/client')
const { migrate } = await import('@/db/migrate')
const { seed } = await import('@/db/seed')
const { db, schema } = await import('@/db/drizzle')

const hasDb = Boolean(process.env.TEST_DATABASE_URL)
const d = hasDb ? describe : describe.skip
if (!hasDb) console.warn('\n  ! TEST_DATABASE_URL unset — skipping lodge-master tests\n')

const auditor = { id: '', roleName: 'auditor' }
let bmId = ''
let palaceId = ''
/** Palace's rooms exactly as the seed left them, so cleanup can restore rather than guess. */
let seeded: { id: string; ratePaise: number }[] = []

async function catalog() {
  return master.getLodgeCatalog()
}
async function palace() {
  return (await catalog()).find((l) => l.name === 'Palace')!
}
async function category(type: string) {
  return (await palace()).categories.find((c) => c.roomType === type)
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
  const [a] = (await db.execute(sql`
    SELECT u.id FROM users u JOIN roles r ON r.id = u.role_id WHERE r.name = 'auditor' LIMIT 1
  `)) as unknown as { id: string }[]
  auditor.id = a!.id
  const [b] = (await db.execute(sql`
    SELECT u.id FROM users u JOIN roles r ON r.id = u.role_id WHERE r.name = 'booking_manager' LIMIT 1
  `)) as unknown as { id: string }[]
  bmId = b!.id
  const [p] = (await db.execute(sql`SELECT id FROM lodging_units WHERE name = 'Palace'`)) as unknown as { id: string }[]
  palaceId = p!.id
  seeded = (await db.execute(sql`
    SELECT id, rack_rate_paise AS "ratePaise" FROM rooms WHERE unit_id = ${palaceId}
  `)) as unknown as { id: string; ratePaise: number }[]
}, 120_000)

/** A confirmed booking holding `count` rooms of a category over a future range. */
async function commitRooms(count: number, roomType: string, checkIn: string, checkOut: string): Promise<string> {
  const [{ code }] = (await db.execute(sql`SELECT 'E-' || nextval('event_code_seq') AS code`)) as unknown as { code: string }[]
  const [ev] = await db
    .insert(schema.events)
    .values({ code, guestName: 'Lodge Test', eventType: 'other', createdBy: bmId, status: 'confirmed' })
    .returning({ id: schema.events.id })
  await db.execute(sql`
    INSERT INTO room_requirements (event_id, unit_id, room_type, count, check_in, check_out)
    VALUES (${ev!.id}, ${palaceId}, ${roomType}, ${count}, ${checkIn}::date, ${checkOut}::date)
  `)
  return ev!.id
}

/**
 * Restores Palace to exactly what the seed left, by ID.
 *
 * Not by room number: an earlier version guessed at the numbering ("anything above P133") and
 * deleted three seeded SUITES, which then made a later test fail for a reason that had nothing
 * to do with the code under test.
 */
async function cleanup() {
  if (!hasDb || seeded.length === 0) return
  await db.delete(schema.events)
  const ids = sql.join(seeded.map((r) => sql`${r.id}::uuid`), sql`, `)
  await db.execute(sql`DELETE FROM rooms WHERE unit_id = ${palaceId} AND id NOT IN (${ids})`)
  await db.execute(sql`UPDATE rooms SET is_active = true WHERE unit_id = ${palaceId}`)
  for (const r of seeded) {
    await db.execute(sql`UPDATE rooms SET rack_rate_paise = ${r.ratePaise} WHERE id = ${r.id}`)
  }
}
afterEach(cleanup)
afterAll(cleanup)

d('the catalogue reads category-wise', () => {
  it('groups the seeded rooms into categories with one rate each', async () => {
    const deluxe = await category('deluxe')
    expect(deluxe).toMatchObject({ rooms: 33, ratePaise: 500_000, beds: 2 })
    expect((await palace()).categories.map((c) => c.roomType).sort()).toEqual(['deluxe', 'dormitory', 'suite'])
  }, 120_000)
})

d('inventory can never drop below what is promised', () => {
  it('refuses a reduction under the busiest committed night, naming the number', async () => {
    // 30 of the 33 deluxe are committed for two nights.
    await commitRooms(30, 'deluxe', '2027-11-01', '2027-11-03')

    await expect(
      master.setCategoryCount(auditor, palaceId, 'deluxe', 29),
    ).rejects.toMatchObject({ status: 409 })
    await expect(
      master.setCategoryCount(auditor, palaceId, 'deluxe', 29),
    ).rejects.toThrow(/cannot go below 30/)

    // Exactly the promised number is allowed — it oversells nobody.
    await master.setCategoryCount(auditor, palaceId, 'deluxe', 30)
    expect((await category('deluxe'))!.rooms).toBe(30)
  }, 120_000)

  it('sums competing bookings on the same night before deciding', async () => {
    // Two events, 20 + 10, overlapping on 2 Nov: the peak is 30, not 20.
    await commitRooms(20, 'deluxe', '2027-11-01', '2027-11-03')
    await commitRooms(10, 'deluxe', '2027-11-02', '2027-11-04')

    expect((await category('deluxe'))!.committedPeak).toBe(30)
    await expect(master.setCategoryCount(auditor, palaceId, 'deluxe', 25)).rejects.toMatchObject({ status: 409 })
    await master.setCategoryCount(auditor, palaceId, 'deluxe', 30)
  }, 120_000)

  it('ignores enquiries — only committed bookings hold inventory', async () => {
    const [{ code }] = (await db.execute(sql`SELECT 'E-' || nextval('event_code_seq') AS code`)) as unknown as { code: string }[]
    const [ev] = await db
      .insert(schema.events)
      .values({ code, guestName: 'Draft', eventType: 'other', createdBy: bmId })
      .returning({ id: schema.events.id })
    await db.execute(sql`
      INSERT INTO room_requirements (event_id, unit_id, room_type, count, check_in, check_out)
      VALUES (${ev!.id}, ${palaceId}, 'deluxe', 33, '2027-11-01'::date, '2027-11-03'::date)
    `)
    // An enquiry holds nothing, so it cannot freeze the Auditor out.
    expect((await category('deluxe'))!.committedPeak).toBe(0)
    await master.setCategoryCount(auditor, palaceId, 'deluxe', 5)
    expect((await category('deluxe'))!.rooms).toBe(5)
  }, 120_000)

  it('refuses to retire a category that is promised, and allows it once it is not', async () => {
    const eventId = await commitRooms(3, 'suite', '2027-11-01', '2027-11-03')
    await expect(master.removeCategory(auditor, palaceId, 'suite')).rejects.toMatchObject({ status: 409 })

    await db.delete(schema.events)
    await master.removeCategory(auditor, palaceId, 'suite')
    expect(await category('suite')).toBeUndefined()
    expect(eventId).toBeTruthy()

    // Retired, not deleted — the rows survive so old bookings still explain themselves.
    const [{ n }] = (await db.execute(sql`
      SELECT count(*)::int AS n FROM rooms WHERE unit_id = ${palaceId} AND room_type = 'suite'
    `)) as unknown as { n: number }[]
    expect(n).toBe(3)
  }, 120_000)
})

d('growing and shrinking keep the room rows honest', () => {
  it('shrinks then grows without leaving a hole in the numbering', async () => {
    await master.setCategoryCount(auditor, palaceId, 'deluxe', 30)
    expect((await category('deluxe'))!.rooms).toBe(30)

    await master.setCategoryCount(auditor, palaceId, 'deluxe', 33)
    expect((await category('deluxe'))!.rooms).toBe(33)

    // Back to the same 33 rows, revived — not 3 brand-new ones alongside 3 retired.
    const [{ n }] = (await db.execute(sql`
      SELECT count(*)::int AS n FROM rooms WHERE unit_id = ${palaceId} AND room_type = 'deluxe'
    `)) as unknown as { n: number }[]
    expect(n).toBe(33)
  }, 120_000)

  it('feeds the hard inventory cap, so a shrunk category refuses a bigger booking', async () => {
    await master.setCategoryCount(auditor, palaceId, 'deluxe', 10)
    const [line] = await rooms.getRoomAvailability([
      { unitId: palaceId, roomType: 'deluxe', count: 12, checkIn: '2027-12-01', checkOut: '2027-12-03' },
    ])
    expect(line!.total).toBe(10) // the cap follows the master, not the seed
    expect(line!.available).toBe(10)
  }, 120_000)
})

d('rates', () => {
  it('re-prices every room of the category at once', async () => {
    await master.setCategoryRate(auditor, palaceId, 'deluxe', 650_000)
    expect((await category('deluxe'))!.ratePaise).toBe(650_000)
    const [{ n }] = (await db.execute(sql`
      SELECT count(*)::int AS n FROM rooms
       WHERE unit_id = ${palaceId} AND room_type = 'deluxe' AND rack_rate_paise <> 650000
    `)) as unknown as { n: number }[]
    expect(n).toBe(0) // no room left on the old rate to be read by min()
  }, 120_000)

  it('refuses a free room', async () => {
    await expect(master.setCategoryRate(auditor, palaceId, 'deluxe', 0)).rejects.toMatchObject({ status: 400 })
  }, 120_000)
})

d('adding categories', () => {
  it('adds one with its own rooms and rate, and refuses a duplicate', async () => {
    await master.addCategory(auditor, palaceId, {
      roomType: 'ZZTest Wing',
      ratePaise: 900_000,
      rooms: 4,
      beds: 3,
    })
    // Normalised to a code, so "ZZTest Wing" and "zztest_wing" are one category.
    const added = await category('zztest_wing')
    expect(added).toMatchObject({ rooms: 4, ratePaise: 900_000, beds: 3 })

    await expect(
      master.addCategory(auditor, palaceId, { roomType: 'zztest_wing', ratePaise: 1, rooms: 1, beds: 1 }),
    ).rejects.toMatchObject({ status: 409 })
  }, 120_000)
})
