/**
 * Everything on a proposal is editable until it is confirmed (client, 15 Aug 2026).
 *
 * `PUT /sub-events/:id` has existed since M3 and NOTHING EVER CALLED IT — the only way to change
 * a function's venue was to delete it and add it back, which threw the menu away with it. Now
 * that the booking page edits in place, the route's behaviour matters, and two things about it
 * are worth pinning:
 *
 *   - IT RECOMPUTES THE PROPOSAL TOTAL. Venue and pax are both priced, so an edit that did not
 *     recompute left the quoted figure stale until something else happened to save a menu.
 *     That was invisible while nothing called it; it would not be now.
 *   - IT REFUSES A CONFIRMED BOOKING. An enquiry holds no venue_bookings, so moving its date or
 *     venue moves nothing. A confirmed function is a held slot and belongs to the change-request
 *     flow — the boundary the client drew ("unless it is confirmed").
 *
 * And the menu must survive the edit, since losing it is the whole reason this exists.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { eq, sql } from 'drizzle-orm'
import { NextRequest } from 'next/server'

// The route handlers read the caller from the iron-session cookie; the same mock the user-admin
// suite uses swaps that for a plain variable, so a test can act as a given user.
const { sessionState } = vi.hoisted(() => ({ sessionState: { userId: undefined as string | undefined } }))
vi.mock('@/lib/session', () => ({
  getSession: async () => ({
    get userId() { return sessionState.userId },
    set userId(v: string | undefined) { sessionState.userId = v },
    save: async () => {},
    destroy: () => { sessionState.userId = undefined },
  }),
}))

const { PUT: putSubEvent } = await import('@/app/api/v1/sub-events/[id]/route')
const { PUT: putEvent } = await import('@/app/api/v1/events/[id]/route')
const menus = await import('@/lib/menus')
const { createClient } = await import('@/db/client')
const { migrate } = await import('@/db/migrate')
const { seed } = await import('@/db/seed')
const { db, schema } = await import('@/db/drizzle')

const hasDb = Boolean(process.env.TEST_DATABASE_URL)
const d = hasDb ? describe : describe.skip
if (!hasDb) console.warn('\n  ! TEST_DATABASE_URL unset — skipping enquiry-edit tests\n')

const bm = { id: '', roleName: 'booking_manager' }
const auditor = { id: '', roleName: 'auditor' }

async function userId(role: string): Promise<string> {
  const [u] = await db
    .select({ id: schema.users.id })
    .from(schema.users)
    .innerJoin(schema.roles, eq(schema.roles.id, schema.users.roleId))
    .where(eq(schema.roles.name, role))
    .limit(1)
  return u!.id
}

function req(body: unknown): NextRequest {
  return new NextRequest('http://test/api/v1/sub-events/x', {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}

/** Calls the route as the Booking Manager. */
function edit(subId: string, body: unknown) {
  sessionState.userId = bm.id
  return putSubEvent(req(body), { params: Promise.resolve({ id: subId }) })
}

/** The same, for the event itself. The event type is the Auditor's, so `as` picks the caller. */
function editEvent(eventId: string, body: unknown, as = auditor) {
  sessionState.userId = as.id
  return putEvent(req(body), { params: Promise.resolve({ id: eventId }) })
}

async function makeEnquiry(): Promise<{ eventId: string; subId: string; venueA: string; venueB: string }> {
  const [{ code }] = (await db.execute(
    sql`SELECT 'E-' || nextval('event_code_seq') AS code`,
  )) as unknown as { code: string }[]
  const [e] = await db
    .insert(schema.events)
    .values({ code, guestName: 'Edit Test', eventType: 'engagement', status: 'enquiry', createdBy: bm.id })
    .returning({ id: schema.events.id })

  // Two venues with different rate cards, so a venue change is visible in the total.
  const venues = (await db.execute(sql`
    SELECT v.id, v.name, rc.rate_paise AS rate
    FROM venues v JOIN venue_rate_cards rc ON rc.venue_id = v.id
    WHERE rc.event_type = 'engagement' AND rc.rate_paise > 0
    ORDER BY rc.rate_paise LIMIT 2
  `)) as unknown as { id: string; name: string; rate: number }[]

  const [sub] = await db
    .insert(schema.subEvents)
    .values({
      eventId: e!.id, name: 'Function', eventDate: '2026-11-01',
      startTime: '11:00', endTime: '15:00', venueId: venues[0]!.id, pax: 100,
    })
    .returning({ id: schema.subEvents.id })
  return { eventId: e!.id, subId: sub!.id, venueA: venues[0]!.id, venueB: venues[1]!.id }
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
  auditor.id = await userId('auditor')
}, 90_000)

async function cleanup() {
  // Venue holds first — they reference the event and do not cascade with it.
  await db.delete(schema.venueBookings)
  await db.delete(schema.events)
}
afterEach(async () => { if (hasDb) await cleanup() })
afterAll(async () => { if (hasDb) await cleanup() })

d('editing a function on an enquiry', () => {
  it('changes date, time, venue and pax, and re-prices the proposal', async () => {
    const { eventId, subId, venueB } = await makeEnquiry()
    const before = (await db.select().from(schema.events).where(eq(schema.events.id, eventId)))[0]!

    const res = await edit(subId, {
      name: 'Reception', event_date: '2026-11-03', start_time: '18:00', end_time: '23:00',
      venue_id: venueB, pax: 250,
    })
    expect(res.status).toBe(200)

    const [sub] = await db.select().from(schema.subEvents).where(eq(schema.subEvents.id, subId))
    expect(sub!.name).toBe('Reception')
    expect(sub!.eventDate).toBe('2026-11-03')
    expect(String(sub!.startTime).slice(0, 5)).toBe('18:00')
    expect(sub!.venueId).toBe(venueB)
    expect(sub!.pax).toBe(250)

    // The quoted figure moved with the venue — the thing the old route did not do.
    const after = (await db.select().from(schema.events).where(eq(schema.events.id, eventId)))[0]!
    expect(after.proposalTotalPaise).toBeGreaterThan(Number(before.proposalTotalPaise))
  })

  it('keeps the menu — the reason delete-and-re-add was not good enough', async () => {
    const { subId } = await makeEnquiry()
    const [tier] = await db.select().from(schema.menuTiers).where(eq(schema.menuTiers.name, 'Silver')).limit(1)
    await db.insert(schema.subEventMenus).values({
      subEventId: subId, tierId: tier!.id, tierName: 'Silver', baseRatePaise: 65_000, surchargePaise: 0,
    })

    const [cur] = await db.select().from(schema.subEvents).where(eq(schema.subEvents.id, subId))
    await edit(subId, {
      name: 'Moved', event_date: '2026-11-05', start_time: '12:00', end_time: '16:00',
      pax: 120, venue_id: cur!.venueId!,
    })

    const menus = await db.select().from(schema.subEventMenus).where(eq(schema.subEventMenus.subEventId, subId))
    expect(menus).toHaveLength(1)
    expect(menus[0]!.tierName).toBe('Silver')
  })

  it('records what actually moved, field by field', async () => {
    const { eventId, subId, venueA } = await makeEnquiry()
    await edit(subId, {
      name: 'Function', event_date: '2026-11-01', start_time: '11:00', end_time: '15:00',
      venue_id: venueA, pax: 175,
    })
    const trail = (await db.execute(sql`
      SELECT field, old_value AS "oldValue", new_value AS "newValue" FROM audit_log
      WHERE event_id = ${eventId} AND entity = 'sub_events' ORDER BY seq
    `)) as unknown as { field: string; oldValue: string | null; newValue: string }[]
    // Only pax changed, so only pax is in the trail — not "the function changed".
    expect(trail.map((t) => t.field)).toEqual(['pax'])
    expect(trail[0]!.oldValue).toBe('100')
    expect(trail[0]!.newValue).toBe('175')
  })

  it('refuses once the booking is confirmed — that is the change-request flow', async () => {
    const { eventId, subId, venueB } = await makeEnquiry()
    await db.update(schema.events).set({ status: 'confirmed' }).where(eq(schema.events.id, eventId))

    const res = await edit(subId, {
      name: 'Function', event_date: '2026-11-01', start_time: '11:00', end_time: '15:00',
      venue_id: venueB, pax: 100,
    })
    expect(res.status).toBe(409)
    expect((await res.json()).error.message).toMatch(/change request/i)
  })

  /**
   * … but not for the Auditor (client, 8 Sep 2026: "an auditor can edit any confirmed booking
   * same as enquiry"). Same route, same screen — a different WRITE underneath, because a
   * confirmed function is a held slot: the move has to release the old venue window and take
   * the new one under the GiST exclusion, which is what `applyGmProposalEdits` does.
   */
  it('lets the Auditor move a CONFIRMED function, and the venue hold moves with it', async () => {
    const { eventId, subId, venueB } = await makeEnquiry()
    // Hold the original window, the way confirm does.
    await db.execute(sql`
      INSERT INTO venue_bookings (event_id, sub_event_id, venue_id, occupancy)
      SELECT ${eventId}, ${subId}, se.venue_id,
             tsrange((se.event_date + se.start_time)::timestamp, (se.event_date + se.end_time)::timestamp, '[)')
        FROM sub_events se WHERE se.id = ${subId}
    `)
    await db.update(schema.events).set({ status: 'confirmed' }).where(eq(schema.events.id, eventId))

    sessionState.userId = auditor.id
    const res = await putSubEvent(
      req({ name: 'Moved', event_date: '2026-11-09', start_time: '18:00', end_time: '23:00', venue_id: venueB, pax: 260 }),
      { params: Promise.resolve({ id: subId }) },
    )
    expect(res.status).toBe(200)

    const [sub] = await db.select().from(schema.subEvents).where(eq(schema.subEvents.id, subId))
    expect(sub!.name).toBe('Moved')
    expect(sub!.eventDate).toBe('2026-11-09')
    expect(sub!.venueId).toBe(venueB)
    expect(sub!.pax).toBe(260)

    // The HOLD moved with it — one row, on the new venue and the new day. A plain UPDATE would
    // have left the calendar holding the old window and the booking claiming the new one.
    const holds = (await db.execute(sql`
      SELECT venue_id AS "venueId", lower(occupancy)::text AS "from"
        FROM venue_bookings WHERE sub_event_id = ${subId}
    `)) as unknown as { venueId: string; from: string }[]
    expect(holds).toHaveLength(1)
    expect(holds[0]!.venueId).toBe(venueB)
    expect(holds[0]!.from).toContain('2026-11-09')
  })
})

/**
 * The event TYPE, which is the same rule one level up (client, 8 Sep 2026: "make the event type
 * editable just incase we fill it mistakenly").
 *
 * It was fixed the instant the proposal existed, so a wedding typed as an engagement had to be
 * abandoned and re-entered from scratch. Two things decide whether the correction is safe:
 * every venue rate card is keyed by event type, so the proposal total must move with it; and
 * past confirmation the hall is held at a rate snapshotted from the OLD type, so it must not be
 * changeable there at all.
 */
d('correcting the event type', () => {
  it('re-types an enquiry and re-prices it off the new rate card', async () => {
    const { eventId } = await makeEnquiry()
    const before = (await db.select().from(schema.events).where(eq(schema.events.id, eventId)))[0]!

    const res = await editEvent(eventId, { event_type: 'wedding' })
    expect(res.status).toBe(200)

    const after = (await db.select().from(schema.events).where(eq(schema.events.id, eventId)))[0]!
    expect(after.eventType).toBe('wedding')
    // A wedding is dearer than an engagement in the seed's rate cards, and the quoted figure
    // has to say so — a correction that left the old total is a booking quoting the old type.
    expect(Number(after.proposalTotalPaise)).not.toBe(Number(before.proposalTotalPaise))

    const [row] = (await db.execute(sql`
      SELECT old_value AS "oldValue", new_value AS "newValue" FROM audit_log
       WHERE event_id = ${eventId} AND field = 'event_type' ORDER BY seq DESC LIMIT 1
    `)) as unknown as { oldValue: string; newValue: string }[]
    expect(row!.oldValue).toContain('engagement')
    expect(row!.newValue).toContain('wedding')
  })

  it('does not hold the correction to the new type\u2019s contact rule', async () => {
    // A wedding needs three numbers. Enforcing that HERE would trap a booking mis-typed as an
    // engagement with one contact in the wrong type for ever; `confirmEvent` is where the rule
    // belongs, and it still refuses.
    const { eventId } = await makeEnquiry()
    expect((await editEvent(eventId, { event_type: 'wedding' })).status).toBe(200)
    const [{ n }] = (await db.execute(sql`
      SELECT count(*)::int AS n FROM event_contacts WHERE event_id = ${eventId}
    `)) as unknown as { n: number }[]
    expect(n).toBe(0)
  })

  it('is the Auditor\u2019s alone \u2014 the manager who typed it cannot re-price by correcting it', async () => {
    // Client, 8 Sep 2026: "should be only given to the auditor only \u2026 as he changes the pricing
    // and all gets changed too." The type is the key every venue rate card is filed under, so
    // moving it moves the money \u2014 that is the Auditor's authority, the same as the venue master.
    const { eventId } = await makeEnquiry()
    const res = await editEvent(eventId, { event_type: 'wedding' }, bm)
    expect(res.status).toBe(403)
    const [ev] = await db.select().from(schema.events).where(eq(schema.events.id, eventId))
    expect(ev!.eventType).toBe('engagement')

    // Everything else on the same route is still the Booking Manager's.
    expect((await editEvent(eventId, { guest_name: 'Renamed By BM' }, bm)).status).toBe(200)
  })

  it('refuses an unknown type rather than writing it', async () => {
    const { eventId } = await makeEnquiry()
    expect((await editEvent(eventId, { event_type: 'birthday-party' })).status).toBe(400)
    const [ev] = await db.select().from(schema.events).where(eq(schema.events.id, eventId))
    expect(ev!.eventType).toBe('engagement')
  })

  /**
   * A CONFIRMED booking too (client's lead, 8 Sep 2026, overruling the enquiry-only limit this
   * shipped with). The objection was that a held function's `venue_rate_paise` is frozen from
   * the OLD type's card, so a cosmetic re-type would leave the booking quoting one figure and
   * holding another. These pin the answer: the frozen rates are re-cut, and a type with no card
   * for one of the halls is refused rather than zeroed.
   */
  it('re-cuts the FROZEN venue rates AND the plate surcharge on a confirmed booking', async () => {
    const { eventId, subId } = await makeEnquiry()
    // A saved menu, so both halves of the money the type decides are on this booking.
    const [tier] = await db.select().from(schema.menuTiers).where(eq(schema.menuTiers.name, 'Silver')).limit(1)
    await menus.saveSubEventMenu(bm, subId, { tierId: tier!.id, selections: {} })
    const [tierPrice] = (await db.execute(sql`
      SELECT base_rate_paise AS base, wedding_surcharge_paise AS surcharge FROM menu_tier_prices
       WHERE tier_id = ${tier!.id} ORDER BY effective_from DESC LIMIT 1
    `)) as unknown as { base: number; surcharge: number }[]

    // The seed charges every hall the same for both types, so the difference this test is
    // measuring has to be created: a dearer wedding card, dated after the seed's, for the hall
    // this function is in. Without it "the snapshot moved" could not fail.
    const [sub0] = await db.select({ venueId: schema.subEvents.venueId }).from(schema.subEvents).where(eq(schema.subEvents.id, subId))
    const [rates] = (await db.execute(sql`
      SELECT rate_paise AS rate FROM venue_rate_cards
       WHERE venue_id = ${sub0!.venueId} AND event_type = 'engagement'
       ORDER BY effective_from DESC LIMIT 1
    `)) as unknown as { rate: number }[]
    const engagement = Number(rates!.rate)
    const wedding = engagement + 25_000_00
    // Dated after the seed's card and before the function, since `venueRatePaise` takes the
    // latest effective_from on or before the event date.
    await db.execute(sql`
      INSERT INTO venue_rate_cards (venue_id, event_type, rate_paise, effective_from)
      VALUES (${sub0!.venueId}, 'wedding', ${wedding}, '2026-06-01')
    `)

    try {
      // Freeze the engagement rate on the function, the way confirm does, and hold the booking.
      await db.update(schema.subEvents).set({ venueRatePaise: engagement }).where(eq(schema.subEvents.id, subId))
      await db.update(schema.events).set({ status: 'confirmed' }).where(eq(schema.events.id, eventId))

      const res = await editEvent(eventId, { event_type: 'wedding' })
      expect(res.status).toBe(200)

      const [sub] = await db.select().from(schema.subEvents).where(eq(schema.subEvents.id, subId))
      // The SNAPSHOT moved, which is the whole point — the hall now charges the wedding rate.
      expect(Number(sub!.venueRatePaise)).toBe(wedding)
      expect(Number(sub!.venueRatePaise)).not.toBe(engagement)

      // The PLATE surcharge moved too, on a booking that is already held.
      const [menu] = await db.select().from(schema.subEventMenus).where(eq(schema.subEventMenus.subEventId, subId))
      expect(Number(menu!.surchargePaise)).toBe(Number(tierPrice!.surcharge))
      expect(Number(menu!.baseRatePaise)).toBe(Number(tierPrice!.base)) // untouched, as snapshotted

      const [ev] = await db.select().from(schema.events).where(eq(schema.events.id, eventId))
      expect(ev!.eventType).toBe('wedding')
      // Venue at the wedding card + pax x (base + the wedding surcharge).
      expect(Number(ev!.proposalTotalPaise)).toBe(
        wedding + sub!.pax * (Number(tierPrice!.base) + Number(tierPrice!.surcharge)),
      )

      // The trail carries both totals, so a jump in what the guest owes is traceable to this.
      const [row] = (await db.execute(sql`
        SELECT old_value AS "oldValue", new_value AS "newValue" FROM audit_log
         WHERE event_id = ${eventId} AND field = 'event_type' ORDER BY seq DESC LIMIT 1
      `)) as unknown as { oldValue: string; newValue: string }[]
      expect(row!.oldValue).toContain('engagement')
      expect(row!.newValue).toContain('wedding')

      // AND BACK AGAIN (client, 8 Sep 2026: "same vice versa"). A re-type that only ever added
      // money would be half a feature — correcting a booking wrongly typed as a WEDDING has to
      // take the hall's wedding rate and the plate surcharge back off it.
      expect((await editEvent(eventId, { event_type: 'engagement' })).status).toBe(200)
      const [back] = await db.select().from(schema.subEvents).where(eq(schema.subEvents.id, subId))
      const [backMenu] = await db.select().from(schema.subEventMenus).where(eq(schema.subEventMenus.subEventId, subId))
      expect(Number(back!.venueRatePaise)).toBe(engagement)
      expect(Number(backMenu!.surchargePaise)).toBe(0)
      const [backEv] = await db.select().from(schema.events).where(eq(schema.events.id, eventId))
      expect(backEv!.eventType).toBe('engagement')
      expect(Number(backEv!.proposalTotalPaise)).toBe(engagement + sub!.pax * Number(tierPrice!.base))
    } finally {
      // `afterEach` clears events, not masters. Leaving this card behind re-prices every
      // wedding in every test that runs after this one.
      await db.execute(sql`
        DELETE FROM venue_rate_cards
         WHERE venue_id = ${sub0!.venueId} AND event_type = 'wedding' AND effective_from = '2026-06-01'
      `)
    }
  })

  it('re-cuts the plate surcharge, both ways', async () => {
    // The other half of the money the type decides. `sub_event_menus.surcharge_paise` is
    // snapshotted when the MENU is saved — the wedding surcharge if the event was a wedding,
    // 0 if not — and nothing re-read it, so a type change left every plate carrying the old
    // type's surcharge. Rs. 50 a head on every tier in the seed, in whichever direction the
    // type moved, and invisible on every screen.
    const { eventId, subId } = await makeEnquiry()
    const [tier] = await db.select().from(schema.menuTiers).where(eq(schema.menuTiers.name, 'Silver')).limit(1)
    await menus.saveSubEventMenu(bm, subId, { tierId: tier!.id, selections: {} })

    const surchargeOf = async () =>
      Number(
        (await db.select().from(schema.subEventMenus).where(eq(schema.subEventMenus.subEventId, subId)))[0]!
          .surchargePaise,
      )
    const [price] = (await db.execute(sql`
      SELECT wedding_surcharge_paise AS s FROM menu_tier_prices
       WHERE tier_id = ${tier!.id} ORDER BY effective_from DESC LIMIT 1
    `)) as unknown as { s: number }[]
    expect(Number(price!.s)).toBeGreaterThan(0) // otherwise this test proves nothing

    // Saved as an engagement: no surcharge.
    expect(await surchargeOf()).toBe(0)

    // → wedding: the surcharge appears, and the total carries it (pax x the surcharge).
    const before = Number((await db.select().from(schema.events).where(eq(schema.events.id, eventId)))[0]!.proposalTotalPaise)
    expect((await editEvent(eventId, { event_type: 'wedding' })).status).toBe(200)
    expect(await surchargeOf()).toBe(Number(price!.s))
    const [sub] = await db.select().from(schema.subEvents).where(eq(schema.subEvents.id, subId))
    const after = Number((await db.select().from(schema.events).where(eq(schema.events.id, eventId)))[0]!.proposalTotalPaise)
    expect(after - before).toBe(sub!.pax * Number(price!.s))

    // → back again: it goes, and so does the money.
    expect((await editEvent(eventId, { event_type: 'engagement' })).status).toBe(200)
    expect(await surchargeOf()).toBe(0)
    expect(Number((await db.select().from(schema.events).where(eq(schema.events.id, eventId)))[0]!.proposalTotalPaise)).toBe(before)
  })

  it('refuses a held booking when the new type has no rate card for a hall', async () => {
    // BR-R1: a missing rate is a gate, never a zero — and on a held booking there is no later
    // gate to catch it, because confirm has already happened.
    const { eventId, subId } = await makeEnquiry()
    const [venue] = await db.select({ venueId: schema.subEvents.venueId }).from(schema.subEvents).where(eq(schema.subEvents.id, subId))
    const cards = (await db.execute(sql`
      SELECT event_type AS "eventType", rate_paise AS rate, effective_from::text AS "from"
        FROM venue_rate_cards WHERE venue_id = ${venue!.venueId} AND event_type = 'wedding'
    `)) as unknown as { eventType: string; rate: number; from: string }[]
    await db.execute(sql`DELETE FROM venue_rate_cards WHERE venue_id = ${venue!.venueId} AND event_type = 'wedding'`)
    await db.update(schema.events).set({ status: 'confirmed' }).where(eq(schema.events.id, eventId))

    try {
      const res = await editEvent(eventId, { event_type: 'wedding' })
      expect(res.status).toBe(400)
      expect((await res.json()).error.message).toMatch(/no rate card/i)
      // Nothing was written — the type and the frozen rate are as they were.
      const [ev] = await db.select().from(schema.events).where(eq(schema.events.id, eventId))
      expect(ev!.eventType).toBe('engagement')
    } finally {
      // `afterEach` clears events, not masters. Put the rate cards back, or every test added
      // after this one inherits a hall that cannot host a wedding.
      for (const c of cards) {
        await db.execute(sql`
          INSERT INTO venue_rate_cards (venue_id, event_type, rate_paise, effective_from)
          VALUES (${venue!.venueId}, ${c.eventType}, ${c.rate}, ${c.from}::date)
        `)
      }
    }
  })

  it('refuses once the guest holds a document', async () => {
    const { eventId } = await makeEnquiry()
    await db.update(schema.events).set({ status: 'billed' }).where(eq(schema.events.id, eventId))

    const res = await editEvent(eventId, { event_type: 'wedding' })
    expect(res.status).toBe(409)
    const [ev] = await db.select().from(schema.events).where(eq(schema.events.id, eventId))
    expect(ev!.eventType).toBe('engagement')
  })
})
