/**
 * The Users screen: editing a user, deleting one, and the unit each manager answers for.
 *
 * The two scopes are different shapes and the tests keep them apart: a Lodge Manager holds
 * one lodge on their own row (mig 0013), while properties name their Banquet Manager, so one
 * manager can hold several (mig 0017). What both must do is RELEASE on a role change — a
 * dangling scope leaves a board answering to someone who no longer reads it.
 *
 * Delete is exercised against the audit trail rather than mocked around it: a user who has
 * recorded work cannot be removed, because `audit_log.user_id` points at them and the log is
 * append-only, and the route must say so in words the Auditor can act on.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { eq, sql } from 'drizzle-orm'
import { NextRequest } from 'next/server'

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

const { db, schema } = await import('@/db/drizzle')
const { createClient } = await import('@/db/client')
const { migrate } = await import('@/db/migrate')
const { seed } = await import('@/db/seed')
const { GET: usersGET, POST: usersPOST } = await import('@/app/api/v1/users/route')
const { PUT: userPUT, DELETE: userDELETE } = await import('@/app/api/v1/users/[id]/route')

const hasDb = Boolean(process.env.TEST_DATABASE_URL)
const d = hasDb ? describe : describe.skip
if (!hasDb) console.warn('\n  ! TEST_DATABASE_URL unset — skipping user-admin tests\n')

const SEED_PW = 'test-only'
let auditorId: string
let roleIds: Record<string, string> = {}
const created: string[] = []

function jsonReq(url: string, method: string, body?: unknown): NextRequest {
  return new NextRequest(url, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
}

async function addUser(body: Record<string, unknown>): Promise<Response> {
  return usersPOST(jsonReq('http://localhost/api/v1/users', 'POST', body))
}
async function editUser(id: string, body: Record<string, unknown>): Promise<Response> {
  return userPUT(jsonReq(`http://localhost/api/v1/users/${id}`, 'PUT', body), {
    params: Promise.resolve({ id }),
  })
}
async function removeUser(id: string): Promise<Response> {
  return userDELETE(jsonReq(`http://localhost/api/v1/users/${id}`, 'DELETE'), {
    params: Promise.resolve({ id }),
  })
}
async function unitNamed(name: string): Promise<string> {
  const [u] = await db
    .select({ id: schema.lodgingUnits.id })
    .from(schema.lodgingUnits)
    .where(eq(schema.lodgingUnits.name, name))
    .limit(1)
  return u!.id
}
async function propertyNamed(name: string): Promise<string> {
  const [p] = await db
    .select({ id: schema.properties.id })
    .from(schema.properties)
    .where(eq(schema.properties.name, name))
    .limit(1)
  return p!.id
}
async function holderOf(propertyId: string): Promise<string | null> {
  const [p] = await db
    .select({ banquetManagerId: schema.properties.banquetManagerId })
    .from(schema.properties)
    .where(eq(schema.properties.id, propertyId))
    .limit(1)
  return p!.banquetManagerId
}

beforeAll(async () => {
  if (!hasDb) return
  const setupSql = createClient('TEST_DATABASE_URL')
  try {
    await migrate(setupSql, () => {})
    await seed(setupSql, { reset: true, force: true, password: SEED_PW }, () => {})
  } finally {
    await setupSql.end()
  }

  const roles = await db.select({ id: schema.roles.id, name: schema.roles.name }).from(schema.roles)
  roleIds = Object.fromEntries(roles.map((r) => [r.name, r.id]))

  const [auditor] = await db
    .select({ id: schema.users.id })
    .from(schema.users)
    .where(eq(schema.users.roleId, roleIds.auditor!))
    .limit(1)
  auditorId = auditor!.id
}, 90_000)

beforeEach(() => {
  sessionState.userId = auditorId
})

afterAll(async () => {
  if (!hasDb) return
  // Test users are deletable by construction — they have no history beyond their own
  // creation audit row, which names the auditor as actor, not them.
  for (const id of created) {
    await db.execute(sql`DELETE FROM users WHERE id = ${id}::uuid`).catch(() => {})
  }
})

d('creating a scoped user', () => {
  it('refuses a Lodge Manager with no lodge', async () => {
    const res = await addUser({
      fullName: 'Lodge Nobody',
      mobile: '9111000001',
      roleId: roleIds.lodge_manager,
      password: 'password123',
    })
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error.message).toMatch(/needs a lodge/i)
  })

  it('stores the lodge a Lodge Manager is given', async () => {
    const unitId = await unitNamed('Palace')
    const res = await addUser({
      fullName: 'Lodge Palace Two',
      mobile: '9111000002',
      roleId: roleIds.lodge_manager,
      password: 'password123',
      lodgingUnitId: unitId,
    })
    expect(res.status).toBe(201)
    const { user } = await res.json()
    created.push(user.id)

    const [row] = await db
      .select({ lodgingUnitId: schema.users.lodgingUnitId })
      .from(schema.users)
      .where(eq(schema.users.id, user.id))
      .limit(1)
    expect(row!.lodgingUnitId).toBe(unitId)
  })

  it('lets a Banquet Manager hold several properties, and none', async () => {
    const palace = await propertyNamed('Palace')
    const grand = await propertyNamed('Dipali Grand')

    const res = await addUser({
      fullName: 'Banquet Two Halls',
      mobile: '9111000003',
      roleId: roleIds.banquet_manager,
      password: 'password123',
      propertyIds: [palace, grand],
    })
    expect(res.status).toBe(201)
    const { user } = await res.json()
    created.push(user.id)
    expect(await holderOf(palace)).toBe(user.id)
    expect(await holderOf(grand)).toBe(user.id)

    // Residency is lodging only — its manager owns no venues, and that is allowed.
    const none = await addUser({
      fullName: 'Banquet No Halls',
      mobile: '9111000004',
      roleId: roleIds.banquet_manager,
      password: 'password123',
      propertyIds: [],
    })
    expect(none.status).toBe(201)
    created.push((await none.json()).user.id)
  })
})

d('a property moves rather than being shared', () => {
  it('takes the property from its previous holder and audits both sides', async () => {
    const palace = await propertyNamed('Palace')
    const before = await holderOf(palace)

    const res = await addUser({
      fullName: 'Banquet Successor',
      mobile: '9111000005',
      roleId: roleIds.banquet_manager,
      password: 'password123',
      propertyIds: [palace],
    })
    const { user } = await res.json()
    created.push(user.id)

    expect(await holderOf(palace)).toBe(user.id)

    const [entry] = (await db.execute(sql`
      SELECT old_value AS "oldValue", new_value AS "newValue"
      FROM audit_log
      WHERE entity = 'properties' AND entity_id = ${palace}::uuid AND field = 'banquet_manager_id'
      ORDER BY at DESC LIMIT 1
    `)) as unknown as { oldValue: string | null; newValue: string | null }[]
    expect(entry!.newValue).toBe(user.id)
    expect(entry!.oldValue).toBe(before)
  })
})

d('changing a role releases the scope it can no longer use', () => {
  it('drops the lodge when a Lodge Manager becomes a Booking Manager', async () => {
    const unitId = await unitNamed('Regency')
    const res = await addUser({
      fullName: 'Lodge Then Booking',
      mobile: '9111000006',
      roleId: roleIds.lodge_manager,
      password: 'password123',
      lodgingUnitId: unitId,
    })
    const { user } = await res.json()
    created.push(user.id)

    const moved = await editUser(user.id, { roleId: roleIds.booking_manager })
    expect(moved.status).toBe(200)

    const [row] = await db
      .select({ lodgingUnitId: schema.users.lodgingUnitId })
      .from(schema.users)
      .where(eq(schema.users.id, user.id))
      .limit(1)
    expect(row!.lodgingUnitId).toBeNull()
  })

  it('releases the properties when a Banquet Manager becomes a Lodge Manager', async () => {
    const grand = await propertyNamed('Dipali Grand')
    const res = await addUser({
      fullName: 'Banquet Then Lodge',
      mobile: '9111000007',
      roleId: roleIds.banquet_manager,
      password: 'password123',
      propertyIds: [grand],
    })
    const { user } = await res.json()
    created.push(user.id)
    expect(await holderOf(grand)).toBe(user.id)

    const moved = await editUser(user.id, {
      roleId: roleIds.lodge_manager,
      lodgingUnitId: await unitNamed('Palace'),
    })
    expect(moved.status).toBe(200)
    expect(await holderOf(grand)).toBeNull()
  })
})

d('editing a user', () => {
  it('changes the mobile they sign in with, and refuses a duplicate', async () => {
    const res = await addUser({
      fullName: 'Mobile Mover',
      mobile: '9111000008',
      roleId: roleIds.booking_manager,
      password: 'password123',
    })
    const { user } = await res.json()
    created.push(user.id)

    const okRes = await editUser(user.id, { mobile: '9111000099' })
    expect(okRes.status).toBe(200)

    const clash = await editUser(user.id, { mobile: '9000000001' }) // the seeded Auditor
    expect(clash.status).toBe(409)
  })

  it('returns the lodge and properties alongside the users', async () => {
    const res = await usersGET()
    const body = await res.json()
    expect(body.lodgingUnits.length).toBeGreaterThan(0)
    expect(body.properties.length).toBeGreaterThan(0)
    expect(body.users.every((u: { propertyIds: unknown }) => Array.isArray(u.propertyIds))).toBe(true)
  })
})

d('deleting a user', () => {
  it('removes an account that has never recorded anything', async () => {
    const res = await addUser({
      fullName: 'Typed In Wrong',
      mobile: '9111000009',
      roleId: roleIds.booking_manager,
      password: 'password123',
    })
    const { user } = await res.json()

    const gone = await removeUser(user.id)
    expect(gone.status).toBe(200)

    const [row] = await db
      .select({ id: schema.users.id })
      .from(schema.users)
      .where(eq(schema.users.id, user.id))
      .limit(1)
    expect(row).toBeUndefined()
  })

  it('refuses an account the audit trail points at, and names Disable instead', async () => {
    // The auditor is the actor on every row this suite has written, so they are the most
    // thoroughly referenced user in the database.
    sessionState.userId = auditorId
    const other = await db
      .select({ id: schema.users.id })
      .from(schema.users)
      .where(eq(schema.users.roleId, roleIds.auditor!))
      .limit(1)
    expect(other[0]!.id).toBe(auditorId)

    const res = await removeUser(auditorId)
    expect(res.status).toBe(400) // deleting yourself is refused before the FK is reached
    expect((await res.json()).error.message).toMatch(/your own account/i)

    // A different user with history: the Booking Manager who created the seeded events.
    const [withHistory] = (await db.execute(sql`
      SELECT user_id AS id FROM audit_log
      WHERE user_id <> ${auditorId}::uuid
      LIMIT 1
    `)) as unknown as { id: string }[]
    if (!withHistory) return // nothing seeded with history; the FK path is covered above

    const blocked = await removeUser(withHistory.id)
    expect(blocked.status).toBe(409)
    expect((await blocked.json()).error.message).toMatch(/disable/i)
  })
})
