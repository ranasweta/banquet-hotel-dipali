/**
 * The event lifecycle actually advances (fix, 21 Jul 2026).
 *
 * `transitionEvent` always described eight statuses and eleven legal moves, but only five
 * of those moves had a caller: nothing anywhere wrote `in_progress` or `completed`. Since
 * `lockEvent` requires `completed`, sign-offs require `in_progress`/`completed`, and the
 * maintenance module only lists events in those states, the entire back half of the product
 * was unreachable — an event could be confirmed and then never change again.
 *
 * These tests pin the date-driven advancer that closes the gap, and the reachability it
 * restores: confirmed → in_progress → completed → (lockable).
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { eq, sql } from 'drizzle-orm'

const events = await import('@/lib/events')
const lock = await import('@/lib/lock')
const { createClient } = await import('@/db/client')
const { migrate } = await import('@/db/migrate')
const { seed } = await import('@/db/seed')
const { db, schema } = await import('@/db/drizzle')

const hasDb = Boolean(process.env.TEST_DATABASE_URL)
const d = hasDb ? describe : describe.skip
if (!hasDb) console.warn('\n  ! TEST_DATABASE_URL unset — skipping lifecycle tests\n')

const actor = { id: '', roleName: 'auditor' }

async function venueId(): Promise<string> {
  const [v] = (await db.execute(sql`SELECT id FROM venues WHERE is_active LIMIT 1`)) as unknown as { id: string }[]
  return v!.id
}

/** A confirmed event whose single function sits on `date`. */
async function eventOn(date: string, lastDate = date): Promise<string> {
  const [{ code }] = (await db.execute(sql`SELECT 'E-' || nextval('event_code_seq') AS code`)) as unknown as { code: string }[]
  const [ev] = await db
    .insert(schema.events)
    .values({ code, guestName: 'Lifecycle Test', eventType: 'engagement', status: 'confirmed', createdBy: actor.id })
    .returning({ id: schema.events.id })
  const v = await venueId()
  await db.insert(schema.subEvents).values({ eventId: ev!.id, name: 'Haldi', eventDate: date, startTime: '10:00', endTime: '14:00', venueId: v, pax: 100 })
  if (lastDate !== date) {
    await db.insert(schema.subEvents).values({ eventId: ev!.id, name: 'Reception', eventDate: lastDate, startTime: '19:00', endTime: '23:00', venueId: v, pax: 100 })
  }
  return ev!.id
}

async function statusOf(eventId: string): Promise<string> {
  const [e] = await db.select({ status: schema.events.status }).from(schema.events).where(eq(schema.events.id, eventId)).limit(1)
  return e!.status
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
  const [u] = await db
    .select({ id: schema.users.id })
    .from(schema.users)
    .innerJoin(schema.roles, eq(schema.roles.id, schema.users.roleId))
    .where(eq(schema.roles.name, 'auditor'))
    .limit(1)
  actor.id = u!.id
}, 90_000)

async function cleanup() {
  await db.delete(schema.venueBookings)
  await db.delete(schema.events)
}
afterEach(async () => { if (hasDb) await cleanup() })
afterAll(async () => { if (hasDb) await cleanup() })

d('date-driven advancement', () => {
  it('leaves a confirmed event alone until its first date arrives', async () => {
    const id = await eventOn('2026-12-01')
    await events.advanceEventStatuses(actor, '2026-11-30')
    expect(await statusOf(id)).toBe('confirmed')
  })

  it('starts an event on the day its first function runs', async () => {
    const id = await eventOn('2026-12-01', '2026-12-03')
    const res = await events.advanceEventStatuses(actor, '2026-12-01')
    expect(res.started).toContain(id)
    expect(await statusOf(id)).toBe('in_progress')
  })

  it('holds it in progress while functions remain', async () => {
    const id = await eventOn('2026-12-01', '2026-12-03')
    await events.advanceEventStatuses(actor, '2026-12-01')
    await events.advanceEventStatuses(actor, '2026-12-03')
    expect(await statusOf(id)).toBe('in_progress') // the last function is today
  })

  it('completes it once the last date has passed', async () => {
    const id = await eventOn('2026-12-01', '2026-12-03')
    await events.advanceEventStatuses(actor, '2026-12-01')
    await events.advanceEventStatuses(actor, '2026-12-04')
    expect(await statusOf(id)).toBe('completed')
  })

  it('catches up in one pass when the job has not run for days', async () => {
    // A run that missed a week must not advance one step per invocation.
    const id = await eventOn('2026-12-01', '2026-12-03')
    const res = await events.advanceEventStatuses(actor, '2026-12-10')
    expect(res.started).toContain(id)
    expect(res.finished).toContain(id)
    expect(await statusOf(id)).toBe('completed')
  })

  it('is idempotent — a second run the same day changes nothing', async () => {
    const id = await eventOn('2026-12-01')
    await events.advanceEventStatuses(actor, '2026-12-05')
    const first = await statusOf(id)
    const again = await events.advanceEventStatuses(actor, '2026-12-05')
    expect(again.started).toHaveLength(0)
    expect(again.finished).toHaveLength(0)
    expect(await statusOf(id)).toBe(first)
  })

  it('never touches a cancelled or already-locked event', async () => {
    const cancelled = await eventOn('2026-12-01')
    await db.update(schema.events).set({ status: 'cancelled' }).where(eq(schema.events.id, cancelled))
    const locked = await eventOn('2026-12-01')
    await db.update(schema.events).set({ status: 'locked' }).where(eq(schema.events.id, locked))

    await events.advanceEventStatuses(actor, '2026-12-10')
    expect(await statusOf(cancelled)).toBe('cancelled')
    expect(await statusOf(locked)).toBe('locked')
  })

  it('reads dates from sub_events, not the first_date cache', async () => {
    // first_date is only written at confirm and goes stale when a function moves; the
    // advancer must not strand an event because a cache disagrees with the calendar.
    const id = await eventOn('2026-12-01')
    await db.update(schema.events).set({ firstDate: '2027-06-01', lastDate: '2027-06-01' }).where(eq(schema.events.id, id))
    await events.advanceEventStatuses(actor, '2026-12-01')
    expect(await statusOf(id)).toBe('in_progress')
  })
})

d('what advancement unblocks', () => {
  it('makes sign-off reachable, which it never was before', async () => {
    const id = await eventOn('2026-12-01')
    await events.advanceEventStatuses(actor, '2026-12-01') // → in_progress
    await expect(lock.signoff(actor, id, 'banquet_manager')).resolves.toBeUndefined()
  })

  it('gets an event as far as the lock checklist', async () => {
    const id = await eventOn('2026-12-01')
    await events.advanceEventStatuses(actor, '2026-12-05') // → completed
    const checklist = await lock.lockChecklist(id)
    expect(checklist.status).toBe('completed')
    // Not lockable yet — the remaining blockers are real work, not an unreachable status.
    expect(checklist.canLock).toBe(false)
    expect(checklist.items.some((i) => i.key === 'increases')).toBe(true)
  })
})
