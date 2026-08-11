/**
 * M1 acceptance: permission enforcement is server-side and live.
 *
 * Route handlers are driven directly (no HTTP server) against the throwaway test
 * database. The session is mocked so a test can "act as" any user by id; every
 * permission decision still comes from role_permissions in the real database, which is
 * the whole point — that is what the acceptance criteria exercise.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { and, eq } from 'drizzle-orm'
import { NextRequest } from 'next/server'

// Mock the session before importing anything that reads it. `sessionState.userId` is the
// signed-in user; setting it directly is "act as", with no cookie and no re-login.
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
const { POST: loginPOST } = await import('@/app/api/v1/auth/login/route')
const { GET: meGET } = await import('@/app/api/v1/auth/me/route')
const { GET: rolesGET, POST: rolesPOST } = await import('@/app/api/v1/roles/route')
const { PUT: permsPUT } = await import('@/app/api/v1/roles/[id]/permissions/route')

const hasDb = Boolean(process.env.TEST_DATABASE_URL)
const d = hasDb ? describe : describe.skip
if (!hasDb) console.warn('\n  ! TEST_DATABASE_URL unset — skipping auth integration tests\n')

const SEED_PW = 'test-only'
let bookingUserId: string
let bookingLoginId: string
let bookingRoleId: string
let auditorId: string

function jsonReq(url: string, method: string, body?: unknown): NextRequest {
  return new NextRequest(url, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
}

async function permsOf(roleId: string): Promise<{ module: string; action: string }[]> {
  const rows = await db
    .select({ module: schema.rolePermissions.moduleCode, action: schema.rolePermissions.action })
    .from(schema.rolePermissions)
    .where(eq(schema.rolePermissions.roleId, roleId))
  return rows
}

async function setPermsAsAuditor(roleId: string, perms: { module: string; action: string }[]) {
  sessionState.userId = auditorId
  const res = await permsPUT(
    jsonReq(`http://localhost/api/v1/roles/${roleId}/permissions`, 'PUT', { permissions: perms }),
    { params: Promise.resolve({ id: roleId }) },
  )
  expect(res.status).toBe(200)
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

  const [booking] = await db
    .select({
      id: schema.users.id,
      loginId: schema.users.loginId,
      roleId: schema.users.roleId,
    })
    .from(schema.users)
    .innerJoin(schema.roles, eq(schema.roles.id, schema.users.roleId))
    .where(eq(schema.roles.name, 'booking_manager'))
    .limit(1)
  bookingUserId = booking!.id
  bookingLoginId = booking!.loginId
  bookingRoleId = booking!.roleId

  const [auditor] = await db
    .select({ id: schema.users.id })
    .from(schema.users)
    .innerJoin(schema.roles, eq(schema.roles.id, schema.users.roleId))
    .where(eq(schema.roles.name, 'auditor'))
    .limit(1)
  auditorId = auditor!.id
}, 90_000)

afterAll(async () => {
  if (!hasDb) return
  await db.delete(schema.roles).where(eq(schema.roles.isSystem, false))
})

beforeEach(() => {
  sessionState.userId = undefined
})

d('authentication', () => {
  it('rejects /auth/me when not signed in (401)', async () => {
    const res = await meGET()
    expect(res.status).toBe(401)
  })

  it('rejects login with a wrong password (401), same message as unknown user', async () => {
    const res = await loginPOST(
      jsonReq('http://localhost/api/v1/auth/login', 'POST', {
        login_id: bookingLoginId,
        password: 'wrong-password',
      }),
    )
    expect(res.status).toBe(401)
    const body = await res.json()
    expect(body.error.message).toMatch(/invalid/i)
  })

  it('logs a valid user in and returns their live permission matrix', async () => {
    const res = await loginPOST(
      jsonReq('http://localhost/api/v1/auth/login', 'POST', {
        login_id: bookingLoginId,
        password: SEED_PW,
      }),
    )
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.role.name).toBe('booking_manager')
    // Booking Manager: Create/Edit on Bookings (PRD §2.1) => view + create_edit.
    expect(body.permissions).toEqual(
      expect.arrayContaining([{ module: 'bookings', action: 'create_edit' }]),
    )
  })

  // Uniqueness is on lower(login_id) (migration 0027), so the lookup must lower() both
  // sides. If it ever goes back to an exact match, a user typed in with any capital letter
  // becomes unreachable — and the failure looks like a wrong password, not a bug.
  it('accepts the ID in any case', async () => {
    for (const typed of [bookingLoginId.toUpperCase(), bookingLoginId.toLowerCase()]) {
      const res = await loginPOST(
        jsonReq('http://localhost/api/v1/auth/login', 'POST', { login_id: typed, password: SEED_PW }),
      )
      expect(res.status, `signing in as "${typed}"`).toBe(200)
    }
  })
})

d('server-side permission enforcement (NFR-3, CLAUDE.md rule 2)', () => {
  it('gives a booking manager 403 on POST /roles', async () => {
    sessionState.userId = bookingUserId
    const res = await rolesPOST(
      jsonReq('http://localhost/api/v1/roles', 'POST', { name: 'Should Not Exist' }),
    )
    expect(res.status).toBe(403)
    const body = await res.json()
    expect(body.error.code).toBe('forbidden')
  })

  it('lets the auditor create a role (201)', async () => {
    sessionState.userId = auditorId
    const res = await rolesPOST(
      jsonReq('http://localhost/api/v1/roles', 'POST', { name: 'Front Desk' }),
    )
    expect(res.status).toBe(201)
    const body = await res.json()
    expect(body.role.name).toBe('Front Desk')
    expect(body.role.isSystem).toBe(false)
  })

  it('gives an unauthenticated POST /roles 401, not 403', async () => {
    const res = await rolesPOST(
      jsonReq('http://localhost/api/v1/roles', 'POST', { name: 'Nope' }),
    )
    expect(res.status).toBe(401)
  })
})

d('a matrix edit takes effect without re-login', () => {
  it('flips a booking manager from 403 to 201 on POST /roles after the grant', async () => {
    const original = await permsOf(bookingRoleId)

    // 1. Denied to begin with.
    sessionState.userId = bookingUserId
    const before = await rolesPOST(
      jsonReq('http://localhost/api/v1/roles', 'POST', { name: 'Made By Booking A' }),
    )
    expect(before.status).toBe(403)

    // 2. Auditor grants booking_manager create_edit on roles_users. This is a data
    //    change only — the booking manager's session is never touched.
    await setPermsAsAuditor(bookingRoleId, [
      ...original,
      { module: 'roles_users', action: 'view' },
      { module: 'roles_users', action: 'create_edit' },
    ])

    // 3. SAME session, no new login: now allowed, because requirePermission reads
    //    role_permissions live rather than trusting a cached cookie.
    sessionState.userId = bookingUserId
    const after = await rolesPOST(
      jsonReq('http://localhost/api/v1/roles', 'POST', { name: 'Made By Booking B' }),
    )
    expect(after.status).toBe(201)

    // 4. Revoke and confirm the door closes again — still no re-login involved.
    await setPermsAsAuditor(bookingRoleId, original)
    sessionState.userId = bookingUserId
    const revoked = await rolesPOST(
      jsonReq('http://localhost/api/v1/roles', 'POST', { name: 'Made By Booking C' }),
    )
    expect(revoked.status).toBe(403)

    expect(await permsOf(bookingRoleId)).toEqual(expect.arrayContaining(original))
    expect(await permsOf(bookingRoleId)).toHaveLength(original.length)
  })

  it('writes an audit row for the permission change (CLAUDE.md rule 5)', async () => {
    await setPermsAsAuditor(bookingRoleId, [
      ...(await permsOf(bookingRoleId)),
      { module: 'audit', action: 'view' },
    ])
    const [row] = await db
      .select({ action: schema.auditLog.action, field: schema.auditLog.field })
      .from(schema.auditLog)
      .where(
        and(eq(schema.auditLog.entity, 'role_permissions'), eq(schema.auditLog.entityId, bookingRoleId)),
      )
      .orderBy(schema.auditLog.seq)
      .limit(1)
    expect(row).toBeDefined()

    // restore
    const restored = (await permsOf(bookingRoleId)).filter((p) => p.module !== 'audit')
    await setPermsAsAuditor(bookingRoleId, restored)
  })
})

d('roles listing', () => {
  it('returns roles, modules, and actions for the matrix screen', async () => {
    sessionState.userId = auditorId
    const res = await rolesGET()
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.roles.length).toBeGreaterThanOrEqual(6)
    expect(body.modules).toContain('roles_users')
    expect(body.actions).toEqual(['view', 'create_edit', 'delete'])
    const auditorRole = body.roles.find((r: { name: string }) => r.name === 'auditor')
    expect(auditorRole.permissions).toEqual(
      expect.arrayContaining([{ module: 'roles_users', action: 'delete' }]),
    )
  })
})
