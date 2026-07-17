import type { NextRequest } from 'next/server'
import { eq } from 'drizzle-orm'
import bcrypt from 'bcryptjs'
import { z } from 'zod'
import { db, schema } from '@/db/drizzle'
import { getPermissionMatrix } from '@/lib/auth'
import { ok, route, unauthorized } from '@/lib/api'
import { getSession } from '@/lib/session'

const loginSchema = z.object({
  mobile: z.string().trim().min(1),
  password: z.string().min(1),
})

// A valid bcrypt hash to compare against when the mobile is unknown, so a missing user
// and a wrong password take about the same time (no user-enumeration via timing).
const DUMMY_HASH = '$2b$10$CwTycUXWue0Thq9StjUM0uJ8DvKqkSV6bJ8m3jK7uJ8m3jK7uJ8m'

export const POST = route(async (req: NextRequest) => {
  const { mobile, password } = loginSchema.parse(await req.json())

  const [user] = await db
    .select({
      id: schema.users.id,
      fullName: schema.users.fullName,
      mobile: schema.users.mobile,
      email: schema.users.email,
      passwordHash: schema.users.passwordHash,
      isActive: schema.users.isActive,
      roleId: schema.users.roleId,
      roleName: schema.roles.name,
    })
    .from(schema.users)
    .innerJoin(schema.roles, eq(schema.roles.id, schema.users.roleId))
    .where(eq(schema.users.mobile, mobile))
    .limit(1)

  const passwordOk = await bcrypt.compare(password, user?.passwordHash ?? DUMMY_HASH)

  // One message for every failure — never reveal whether the mobile exists or is inactive.
  if (!user || !user.isActive || !passwordOk) {
    throw unauthorized('Invalid mobile number or password')
  }

  const session = await getSession()
  session.userId = user.id
  await session.save()

  return ok({
    user: { id: user.id, fullName: user.fullName, mobile: user.mobile, email: user.email },
    role: { id: user.roleId, name: user.roleName },
    permissions: await getPermissionMatrix(user.roleId),
  })
})
