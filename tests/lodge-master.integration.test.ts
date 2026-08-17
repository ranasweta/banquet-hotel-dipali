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
/**
 * EVERY lodge's rooms exactly as the seed left them, so cleanup can restore rather than guess.
 *
 * All three lodges, not just Palace: a rename is per-lodge, and one test has to take a category
 * name off Regency and Residency to prove what happens when no lodge answers to it any more.
 * Only Palace's ROWS are added and deleted, so only Palace is reconciled for row membership.
 */
let seeded: { id: string; unitId: string; ratePaise: number; roomType: string }[] = []

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
    SELECT id, unit_id AS "unitId", rack_rate_paise AS "ratePaise", room_type AS "roomType"
    FROM rooms
  `)) as unknown as { id: string; unitId: string; ratePaise: number; roomType: string }[]
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
 *
 * `room_type` is restored as well as the rate. A rename moves it, and a category left under
 * its new name leaks into the next test as a category that has simply vanished.
 */
async function cleanup() {
  if (!hasDb || seeded.length === 0) return
  // Invoices first: `invoices.event_id` does not cascade, so an event that has been drafted
  // cannot be deleted until its document is. One test here drafts one.
  await db.delete(schema.invoices)
  await db.delete(schema.events)
  const palaceIds = sql.join(
    seeded.filter((r) => r.unitId === palaceId).map((r) => sql`${r.id}::uuid`),
    sql`, `,
  )
  await db.execute(sql`DELETE FROM rooms WHERE unit_id = ${palaceId} AND id NOT IN (${palaceIds})`)
  await db.execute(sql`UPDATE rooms SET is_active = true WHERE unit_id = ${palaceId}`)
  // One statement rather than a round trip per room: this runs after every test.
  const rows = sql.join(
    seeded.map((r) => sql`(${r.id}::uuid, ${r.ratePaise}::bigint, ${r.roomType}::text)`),
    sql`, `,
  )
  await db.execute(sql`
    UPDATE rooms r SET rack_rate_paise = s.rate, room_type = s.room_type
      FROM (VALUES ${rows}) AS s(id, rate, room_type)
     WHERE r.id = s.id
  `)
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

d('renaming a category', () => {
  it('carries the rooms and every booking that names them across', async () => {
    const eventId = await commitRooms(2, 'suite', '2027-11-01', '2027-11-03')

    await master.renameCategory(auditor, palaceId, 'suite', 'Garden Suite')

    // Normalised, like every other category name.
    expect(await category('suite')).toBeUndefined()
    expect(await category('garden_suite')).toMatchObject({ rooms: 3, ratePaise: 800_000 })

    // THE POINT OF THE TEST: the booking followed. If `room_requirements` had been left behind,
    // the rate lookup would find nothing and an enquiry would silently re-price to zero.
    const [req] = (await db.execute(sql`
      SELECT room_type AS "roomType" FROM room_requirements WHERE event_id = ${eventId}
    `)) as unknown as { roomType: string }[]
    expect(req!.roomType).toBe('garden_suite')
    expect((await category('garden_suite'))!.committedPeak).toBe(2)

    const { roomEstimatePaise } = await import('@/lib/pricing')
    expect((await roomEstimatePaise(eventId)).roomsPaise).toBe(2 * 2 * 800_000)

    // AND THE PROPOSAL ALREADY MADE READS BACK UNDER THE NEW NAME. The printed document is
    // rebuilt from `room_requirements` every time it is opened, so an existing booking shows
    // the rename rather than a category the lodge no longer has.
    const { proposalDocument } = await import('@/lib/proposal')
    const doc = await proposalDocument(eventId)
    expect(doc.lodges[0]!.lines[0]!.roomType).toBe('garden_suite')
    expect(doc.totals.roomsPaise).toBe(2 * 2 * 800_000)
  }, 120_000)

  /**
   * The other half of the answer: what is FROZEN does not move. A numbered document the guest
   * holds keeps the words it was issued with — `invoice_lines.description` is a snapshot, not
   * a view — and so does the audit trail. Redrafting rebuilds from the booking and picks the
   * new name up.
   */
  it('leaves an issued document saying what it said, and updates it on a redraft', async () => {
    const invoiceLib = await import('@/lib/invoice')
    const eventId = await commitRooms(1, 'suite', '2027-11-01', '2027-11-03')
    await db.transaction(async (tx) => invoiceLib.draftInvoice(tx, auditor, eventId))

    const before = await invoiceLib.getInvoice(eventId)
    expect(before!.lines.some((l) => l.description.includes('suite'))).toBe(true)

    await master.renameCategory(auditor, palaceId, 'suite', 'garden_suite')

    // The stored lines are untouched — nobody rewrote a document that had been drawn up.
    const after = await invoiceLib.getInvoice(eventId)
    expect(after!.lines.map((l) => l.description)).toEqual(before!.lines.map((l) => l.description))

    // A redraft reads the booking again, so from here it says the new name.
    await db.transaction(async (tx) => invoiceLib.reissueInvoice(tx, auditor, eventId, 'category renamed'))
    const redrafted = await invoiceLib.getInvoice(eventId)
    expect(redrafted!.lines.some((l) => l.description.includes('garden suite'))).toBe(true)
  }, 120_000)

  it('renames retired rooms too, so the old name cannot come back', async () => {
    // Shrink 3 suites to 1 — two rows go inactive — then rename.
    await master.setCategoryCount(auditor, palaceId, 'suite', 1)
    await master.renameCategory(auditor, palaceId, 'suite', 'garden_suite')
    const [{ n }] = (await db.execute(sql`
      SELECT count(*)::int AS n FROM rooms WHERE unit_id = ${palaceId} AND room_type = 'suite'
    `)) as unknown as { n: number }[]
    expect(n).toBe(0)
  }, 120_000)

  it('moves rooms handed over on the day as well as the booking', async () => {
    const eventId = await commitRooms(1, 'suite', '2027-11-01', '2027-11-03')
    await db.execute(sql`
      INSERT INTO additional_rooms (event_id, unit_id, room_type, count, nights, rate_paise, amount_paise, created_by)
      VALUES (${eventId}, ${palaceId}, 'suite', 1, 1, 800000, 800000, ${bmId})
    `)

    await master.renameCategory(auditor, palaceId, 'suite', 'garden_suite')

    const [extra] = (await db.execute(sql`
      SELECT room_type AS "roomType" FROM additional_rooms WHERE event_id = ${eventId}
    `)) as unknown as { roomType: string }[]
    expect(extra!.roomType).toBe('garden_suite')
  }, 120_000)

  /**
   * `room_requirements.unit_id` is nullable (migration 0009) and those rows price off
   * `min(rack_rate_paise)` across every lodge carrying the name. They must not follow a rename
   * while another lodge still answers to the old name — but they MUST once none does, or they
   * resolve to nothing and price at zero, which is the failure the whole cascade exists for.
   */
  it('leaves lodge-less rows alone while another lodge keeps the name, and moves them once none does', async () => {
    const [{ code }] = (await db.execute(sql`SELECT 'E-' || nextval('event_code_seq') AS code`)) as unknown as { code: string }[]
    const [ev] = await db
      .insert(schema.events)
      .values({ code, guestName: 'Legacy', eventType: 'other', createdBy: bmId })
      .returning({ id: schema.events.id })
    // A pre-migration-0009 row: a category, no lodge.
    await db.execute(sql`
      INSERT INTO room_requirements (event_id, unit_id, room_type, count, check_in, check_out)
      VALUES (${ev!.id}, NULL, 'deluxe', 1, '2027-11-01'::date, '2027-11-03'::date)
    `)
    const nameOf = async () => {
      const [r] = (await db.execute(sql`
        SELECT room_type AS "roomType" FROM room_requirements WHERE event_id = ${ev!.id}
      `)) as unknown as { roomType: string }[]
      return r!.roomType
    }

    // Regency and Residency still have deluxe, so the row may well have meant one of those.
    await master.renameCategory(auditor, palaceId, 'deluxe', 'palace_deluxe')
    expect(await nameOf()).toBe('deluxe')

    // Take the name off every other lodge and it has nowhere left to resolve — so it follows.
    const others = (await db.execute(sql`
      SELECT DISTINCT unit_id AS "unitId" FROM rooms WHERE room_type = 'deluxe'
    `)) as unknown as { unitId: string }[]
    for (const o of others) await master.renameCategory(auditor, o.unitId, 'deluxe', 'standard')
    expect(await nameOf()).toBe('standard')

    const { roomEstimatePaise } = await import('@/lib/pricing')
    // The point of all of it: it still prices, rather than falling to a silent zero.
    expect((await roomEstimatePaise(ev!.id)).roomsPaise).toBeGreaterThan(0)
  }, 120_000)

  it('refuses a name the lodge already uses, retired rooms included', async () => {
    await expect(
      master.renameCategory(auditor, palaceId, 'suite', 'deluxe'),
    ).rejects.toMatchObject({ status: 409 })

    // Retire deluxe entirely, and it still blocks — merging two categories is not a rename.
    await master.removeCategory(auditor, palaceId, 'deluxe')
    await expect(
      master.renameCategory(auditor, palaceId, 'suite', 'deluxe'),
    ).rejects.toMatchObject({ status: 409 })
  }, 120_000)

  it('refuses a category that is not in this lodge, and shrugs at a no-op', async () => {
    await expect(
      master.renameCategory(auditor, palaceId, 'presidential_suite', 'penthouse'),
    ).rejects.toMatchObject({ status: 404 })
    // Same name in, same name out — nothing to audit, nothing to move.
    expect(await master.renameCategory(auditor, palaceId, 'suite', 'Suite')).toBe('suite')
    expect((await category('suite'))!.rooms).toBe(3)
  }, 120_000)
})

d('a confirmed booking keeps the rate it was confirmed at', () => {
  it('freezes the nightly rate, so re-pricing the category never moves it', async () => {
    const confirm = await import('@/lib/pricing')
    const eventId = await commitRooms(4, 'deluxe', '2027-11-01', '2027-11-03')
    // commitRooms writes the requirement directly, so freeze it the way confirmEvent does.
    const roomsLib = await import('@/lib/rooms')
    await db.transaction(async (tx) => roomsLib.freezeRoomRates(tx, eventId))

    const before = await confirm.roomEstimatePaise(eventId)
    expect(before.roomsPaise).toBe(4 * 2 * 500_000) // 4 rooms × 2 nights × ₹5,000

    // The Auditor puts deluxe up by 40%.
    await master.setCategoryRate(auditor, palaceId, 'deluxe', 700_000)

    const after = await confirm.roomEstimatePaise(eventId)
    expect(after.roomsPaise).toBe(before.roomsPaise) // the guest keeps what they were quoted
  }, 120_000)

  it('leaves an enquiry pricing live — a draft is not a promise', async () => {
    const confirm = await import('@/lib/pricing')
    const [{ code }] = (await db.execute(sql`SELECT 'E-' || nextval('event_code_seq') AS code`)) as unknown as { code: string }[]
    const [ev] = await db
      .insert(schema.events)
      .values({ code, guestName: 'Draft', eventType: 'other', createdBy: bmId })
      .returning({ id: schema.events.id })
    await db.execute(sql`
      INSERT INTO room_requirements (event_id, unit_id, room_type, count, check_in, check_out)
      VALUES (${ev!.id}, ${palaceId}, 'deluxe', 2, '2027-11-01'::date, '2027-11-03'::date)
    `)
    // freezeRoomRates only touches committed bookings, so this stays NULL…
    await db.transaction(async (tx) => (await import('@/lib/rooms')).freezeRoomRates(tx, ev!.id))
    const [row] = (await db.execute(sql`
      SELECT rate_paise AS "ratePaise" FROM room_requirements WHERE event_id = ${ev!.id}
    `)) as unknown as { ratePaise: number | null }[]
    expect(row!.ratePaise).toBeNull()

    // …and it follows the catalogue, exactly as it did before the freeze existed.
    await master.setCategoryRate(auditor, palaceId, 'deluxe', 700_000)
    expect((await confirm.roomEstimatePaise(ev!.id)).roomsPaise).toBe(2 * 2 * 700_000)
  }, 120_000)
})
