import type { NextRequest } from 'next/server'
import { asc, eq } from 'drizzle-orm'
import bcrypt from 'bcryptjs'
import { z } from 'zod'
import { db, schema } from '@/db/drizzle'
import { requirePermission } from '@/lib/auth'
import { audit } from '@/lib/audit'
import { applyUserScope } from '@/lib/user-scope'
import { badRequest, conflict, ok, route } from '@/lib/api'

/**
 * GET /users — all users with their role and the unit they answer for. Never returns
 * password hashes.
 *
 * The lodges and properties come back with the users because the screen that assigns them
 * lives here: fetching them from /booking-options instead would make the Users page depend
 * on a `bookings` permission it has no business holding.
 */
export const GET = route(async () => {
  await requirePermission('roles_users', 'view')
  const [users, lodgingUnits, properties] = await Promise.all([
    db
      .select({
        id: schema.users.id,
        fullName: schema.users.fullName,
        mobile: schema.users.mobile,
        email: schema.users.email,
        isActive: schema.users.isActive,
        roleId: schema.users.roleId,
        roleName: schema.roles.name,
        lodgingUnitId: schema.users.lodgingUnitId,
        createdAt: schema.users.createdAt,
      })
      .from(schema.users)
      .innerJoin(schema.roles, eq(schema.roles.id, schema.users.roleId))
      .orderBy(asc(schema.users.fullName)),
    db
      .select({ id: schema.lodgingUnits.id, name: schema.lodgingUnits.name })
      .from(schema.lodgingUnits)
      .orderBy(asc(schema.lodgingUnits.name)),
    db
      .select({
        id: schema.properties.id,
        name: schema.properties.name,
        banquetManagerId: schema.properties.banquetManagerId,
      })
      .from(schema.properties)
      .orderBy(asc(schema.properties.name)),
  ])

  const owned = new Map<string, string[]>()
  for (const p of properties) {
    if (p.banquetManagerId) owned.set(p.banquetManagerId, [...(owned.get(p.banquetManagerId) ?? []), p.id])
  }

  return ok({
    users: users.map((u) => ({ ...u, propertyIds: owned.get(u.id) ?? [] })),
    lodgingUnits,
    properties,
  })
})

const createSchema = z.object({
  fullName: z.string().trim().min(1).max(120),
  mobile: z.string().trim().min(4).max(20),
  email: z.email().max(200).optional().or(z.literal('')).transform((v) => v || undefined),
  roleId: z.uuid(),
  password: z.string().min(8).max(200),
  // The unit the new user answers for. Which one applies is decided by their role — see
  // lib/user-scope.ts; anything sent for a role that cannot use it is released, not kept.
  lodgingUnitId: z.uuid().nullish(),
  propertyIds: z.array(z.uuid()).optional(),
})

/** POST /users — create a user. */
export const POST = route(async (req: NextRequest) => {
  const actor = await requirePermission('roles_users', 'create_edit')
  const input = createSchema.parse(await req.json())

  const created = await db.transaction(async (tx) => {
    const [role] = await tx
      .select({ id: schema.roles.id, name: schema.roles.name })
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

    await applyUserScope(tx, actor, row!.id, role.name, {
      lodgingUnitId: input.lodgingUnitId ?? null,
      propertyIds: input.propertyIds ?? [],
    })
    return row!
  })

  return ok({ user: created }, 201)
})
