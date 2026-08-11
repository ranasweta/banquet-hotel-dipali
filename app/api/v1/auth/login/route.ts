import type { NextRequest } from 'next/server'
import { eq, sql } from 'drizzle-orm'
import bcrypt from 'bcryptjs'
import { z } from 'zod'
import { db, schema } from '@/db/drizzle'
import { getPermissionMatrix } from '@/lib/auth'
import { ApiError, ok, route, unauthorized } from '@/lib/api'
import { getSession } from '@/lib/session'
import { rateLimit } from '@/lib/rate-limit'

const loginSchema = z.object({
  login_id: z.string().trim().min(1),
  password: z.string().min(1),
})

// Login rate limit (M10 hardening): cap attempts per id+IP window to blunt stuffing.
const MAX_ATTEMPTS = 10
const WINDOW_MS = 5 * 60 * 1000

// A valid bcrypt hash to compare against when the id is unknown, so a missing user
// and a wrong password take about the same time (no user-enumeration via timing).
const DUMMY_HASH = '$2b$10$CwTycUXWue0Thq9StjUM0uJ8DvKqkSV6bJ8m3jK7uJ8m3jK7uJ8m'

export const POST = route(async (req: NextRequest) => {
  const { login_id: loginId, password } = loginSchema.parse(await req.json())

  const ip = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || 'local'
  // Keyed on the lowered id, or 'Admin' and 'admin' would get a fresh budget of attempts
  // each — the same account behind two spellings.
  const key = loginId.toLowerCase()
  const limit = rateLimit(`login:${ip}:${key}`, MAX_ATTEMPTS, WINDOW_MS)
  if (!limit.allowed) {
    throw new ApiError(429, 'rate_limited', `Too many attempts. Try again in ${limit.retryAfterSec}s.`)
  }

  const [user] = await db
    .select({
      id: schema.users.id,
      fullName: schema.users.fullName,
      loginId: schema.users.loginId,
      mobile: schema.users.mobile,
      email: schema.users.email,
      passwordHash: schema.users.passwordHash,
      isActive: schema.users.isActive,
      roleId: schema.users.roleId,
      roleName: schema.roles.name,
    })
    .from(schema.users)
    .innerJoin(schema.roles, eq(schema.roles.id, schema.users.roleId))
    // Matched case-insensitively, the same way the unique index is built (migration 0027).
    .where(sql`lower(${schema.users.loginId}) = ${key}`)
    .limit(1)

  const passwordOk = await bcrypt.compare(password, user?.passwordHash ?? DUMMY_HASH)

  // One message for every failure — never reveal whether the ID exists or is inactive.
  if (!user || !user.isActive || !passwordOk) {
    throw unauthorized('Invalid ID or password')
  }

  const session = await getSession()
  session.userId = user.id
  await session.save()

  return ok({
    user: { id: user.id, fullName: user.fullName, loginId: user.loginId, mobile: user.mobile, email: user.email },
    role: { id: user.roleId, name: user.roleName },
    permissions: await getPermissionMatrix(user.roleId),
  })
})
