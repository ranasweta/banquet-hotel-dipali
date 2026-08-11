import type { NextRequest } from 'next/server'
import { asc, eq, sql } from 'drizzle-orm'
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
        loginId: schema.users.loginId,
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

// Mirrors the users_login_id_format CHECK in migration 0027, which is the real enforcement —
// the seed and psql write users too. This copy only buys a 400 with a readable message
// instead of a constraint violation.
const loginIdSchema = z
  .string()
  .trim()
  .regex(/^[A-Za-z0-9._-]{3,32}$/, 'ID must be 3-32 characters: letters, digits, dot, underscore or hyphen')

const createSchema = z.object({
  fullName: z.string().trim().min(1).max(120),
  loginId: loginIdSchema,
  // Contact information since 0027, no longer the login. Optional.
  mobile: z.string().trim().max(20).optional().or(z.literal('')).transform((v) => v || undefined),
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

    // Case-insensitively, matching the unique index on lower(login_id) (0027) — otherwise
    // 'Rahul' passes this check, then the database rejects it as a duplicate of 'rahul'.
    const [dupe] = await tx
      .select({ id: schema.users.id })
      .from(schema.users)
      .where(sql`lower(${schema.users.loginId}) = ${input.loginId.toLowerCase()}`)
      .limit(1)
    if (dupe) throw conflict(`A user with ID ${input.loginId} already exists`)

    const passwordHash = await bcrypt.hash(input.password, 10)
    const [row] = await tx
      .insert(schema.users)
      .values({
        fullName: input.fullName,
        loginId: input.loginId,
        mobile: input.mobile ?? null,
        email: input.email ?? null,
        passwordHash,
        roleId: input.roleId,
      })
      .returning({
        id: schema.users.id,
        fullName: schema.users.fullName,
        loginId: schema.users.loginId,
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
