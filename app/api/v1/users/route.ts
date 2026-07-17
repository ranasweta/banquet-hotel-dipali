import type { NextRequest } from 'next/server'
import { asc, eq } from 'drizzle-orm'
import bcrypt from 'bcryptjs'
import { z } from 'zod'
import { db, schema } from '@/db/drizzle'
import { requirePermission } from '@/lib/auth'
import { audit } from '@/lib/audit'
import { badRequest, conflict, ok, route } from '@/lib/api'

/** GET /users — all users with their role. Never returns password hashes. */
export const GET = route(async () => {
  await requirePermission('roles_users', 'view')
  const users = await db
    .select({
      id: schema.users.id,
      fullName: schema.users.fullName,
      mobile: schema.users.mobile,
      email: schema.users.email,
      isActive: schema.users.isActive,
      roleId: schema.users.roleId,
      roleName: schema.roles.name,
      createdAt: schema.users.createdAt,
    })
    .from(schema.users)
    .innerJoin(schema.roles, eq(schema.roles.id, schema.users.roleId))
    .orderBy(asc(schema.users.fullName))
  return ok({ users })
})

const createSchema = z.object({
  fullName: z.string().trim().min(1).max(120),
  mobile: z.string().trim().min(4).max(20),
  email: z.email().max(200).optional().or(z.literal('')).transform((v) => v || undefined),
  roleId: z.uuid(),
  password: z.string().min(8).max(200),
})

/** POST /users — create a user. */
export const POST = route(async (req: NextRequest) => {
  const actor = await requirePermission('roles_users', 'create_edit')
  const input = createSchema.parse(await req.json())

  const created = await db.transaction(async (tx) => {
    const [role] = await tx
      .select({ id: schema.roles.id })
      .from(schema.roles)
      .where(eq(schema.roles.id, input.roleId))
      .limit(1)
    if (!role) throw badRequest('roleId does not refer to an existing role')

    const [dupe] = await tx
      .select({ id: schema.users.id })
      .from(schema.users)
      .where(eq(schema.users.mobile, input.mobile))
      .limit(1)
    if (dupe) throw conflict(`A user with mobile ${input.mobile} already exists`)

    const passwordHash = await bcrypt.hash(input.password, 10)
    const [row] = await tx
      .insert(schema.users)
      .values({
        fullName: input.fullName,
        mobile: input.mobile,
        email: input.email ?? null,
        passwordHash,
        roleId: input.roleId,
      })
      .returning({
        id: schema.users.id,
        fullName: schema.users.fullName,
        mobile: schema.users.mobile,
        email: schema.users.email,
        isActive: schema.users.isActive,
        roleId: schema.users.roleId,
      })

    await audit(tx, actor, {
      entity: 'users',
      entityId: row!.id,
      action: 'insert',
      field: 'full_name',
      newValue: input.fullName,
    })
    return row!
  })

  return ok({ user: created }, 201)
})
