/**
 * Web push for the installed app (11 Aug 2026).
 *
 * The parts worth pinning are not "does a phone buzz" — that needs a real push service — but
 * the three things that would break quietly:
 *
 *   - a device re-subscribing must RE-POINT its row, not add a second one, or a phone that
 *     passes between staff pushes one person's queue to another;
 *   - a push must never throw, because it is called after a committed write and the write
 *     must not be damaged by a notification;
 *   - deleting a user must take their endpoints with them, or the system keeps pushing to a
 *     delivery address for an account that no longer exists.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { eq, sql } from 'drizzle-orm'

const { sessionState } = vi.hoisted(() => ({
  sessionState: { userId: undefined as string | undefined },
}))
vi.mock('@/lib/session', () => ({
  getSession: async () => ({
    get userId() {
      return sessionState.userId
    },
    set userId(v: string | undefined) {
      sessionState.userId = v
    },
    save: async () => {},
    destroy: () => {
      sessionState.userId = undefined
    },
  }),
}))

const push = await import('@/lib/push')
const { db, schema } = await import('@/db/drizzle')
const { createClient } = await import('@/db/client')
const { migrate } = await import('@/db/migrate')
const { seed } = await import('@/db/seed')

const hasDb = Boolean(process.env.TEST_DATABASE_URL)
const d = hasDb ? describe : describe.skip
if (!hasDb) console.warn('\n  ! TEST_DATABASE_URL unset — skipping push tests\n')

let bookingId: string
let chefId: string
const ENDPOINT = 'https://push.example.com/device-abc'

async function userOf(role: string): Promise<string> {
  const [u] = await db
    .select({ id: schema.users.id })
    .from(schema.users)
    .innerJoin(schema.roles, eq(schema.roles.id, schema.users.roleId))
    .where(eq(schema.roles.name, role))
    .limit(1)
  return u!.id
}
async function rowsFor(endpoint: string) {
  return db
    .select({ id: schema.pushSubscriptions.id, userId: schema.pushSubscriptions.userId })
    .from(schema.pushSubscriptions)
    .where(eq(schema.pushSubscriptions.endpoint, endpoint))
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
  bookingId = await userOf('booking_manager')
  chefId = await userOf('chef')
}, 90_000)

afterAll(async () => {
  if (!hasDb) return
  await db.execute(sql`DELETE FROM push_subscriptions`)
})

d('a device, not a person', () => {
  it('re-points an existing endpoint instead of duplicating it', async () => {
    const keys = { p256dh: 'key-one', auth: 'auth-one' }
    await push.saveSubscription(bookingId, { endpoint: ENDPOINT, keys }, 'Pixel')

    let rows = await rowsFor(ENDPOINT)
    expect(rows).toHaveLength(1)
    expect(rows[0]!.userId).toBe(bookingId)

    // The same handset, now signed in as the Chef.
    await push.saveSubscription(chefId, { endpoint: ENDPOINT, keys: { p256dh: 'key-two', auth: 'auth-two' } }, 'Pixel')

    rows = await rowsFor(ENDPOINT)
    expect(rows).toHaveLength(1)
    expect(rows[0]!.userId).toBe(chefId)
  })

  it('removes by endpoint when notifications are turned off', async () => {
    await push.removeSubscription(ENDPOINT)
    expect(await rowsFor(ENDPOINT)).toHaveLength(0)
  })
})

d('delivery never damages the write it announces', () => {
  it('returns 0 rather than throwing when no keys are configured', async () => {
    const pub = process.env.VAPID_PUBLIC_KEY
    const priv = process.env.VAPID_PRIVATE_KEY
    delete process.env.VAPID_PUBLIC_KEY
    delete process.env.VAPID_PRIVATE_KEY
    try {
      await push.saveSubscription(bookingId, { endpoint: ENDPOINT, keys: { p256dh: 'k', auth: 'a' } })
      const sent = await push.pushToUsers([bookingId], { title: 'x', body: 'y', href: '/' })
      expect(sent).toBe(0)
    } finally {
      if (pub) process.env.VAPID_PUBLIC_KEY = pub
      if (priv) process.env.VAPID_PRIVATE_KEY = priv
      await push.removeSubscription(ENDPOINT)
    }
  })

  it('returns 0 for a user with no devices, and for nobody at all', async () => {
    expect(await push.pushToUsers([], { title: 'x', body: 'y', href: '/' })).toBe(0)
    expect(await push.pushToUsers([bookingId], { title: 'x', body: 'y', href: '/' })).toBe(0)
  })

  it('resolves a role to its active users', async () => {
    const chefs = await push.usersInRoles(['chef'])
    expect(chefs).toContain(chefId)
    expect(chefs).not.toContain(bookingId)
    expect(await push.usersInRoles([])).toEqual([])
  })
})

d('an endpoint is a delivery address, not history', () => {
  it('goes with the user when the account is deleted', async () => {
    const [{ code }] = (await db.execute(sql`SELECT 'PT-' || nextval('event_code_seq') AS code`)) as unknown as { code: string }[]
    const [role] = await db.select({ id: schema.roles.id }).from(schema.roles).limit(1)
    const [u] = await db
      .insert(schema.users)
      .values({ fullName: `Push Temp ${code}`, mobile: `9${Date.now().toString().slice(-9)}`, passwordHash: 'x', roleId: role!.id })
      .returning({ id: schema.users.id })

    const endpoint = `https://push.example.com/${code}`
    await push.saveSubscription(u!.id, { endpoint, keys: { p256dh: 'k', auth: 'a' } })
    expect(await rowsFor(endpoint)).toHaveLength(1)

    await db.delete(schema.users).where(eq(schema.users.id, u!.id))
    expect(await rowsFor(endpoint)).toHaveLength(0)
  })
})
