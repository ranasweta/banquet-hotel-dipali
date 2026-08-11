import type { NextRequest } from 'next/server'
import { eq, sql } from 'drizzle-orm'
import bcrypt from 'bcryptjs'
import { z } from 'zod'
import { db, schema } from '@/db/drizzle'
import { requirePermission } from '@/lib/auth'
import { audit, diffEntries } from '@/lib/audit'
import { applyUserScope } from '@/lib/user-scope'
import { badRequest, conflict, ok, notFound, route } from '@/lib/api'

const updateSchema = z
  .object({
    fullName: z.string().trim().min(1).max(120).optional(),
    // The login id is what this person types to sign in, so renaming it changes their
    // access immediately. Unique on lower(login_id) at the database level (migration 0027);
    // the duplicate is caught below to name the clash. The regex mirrors that migration's
    // CHECK constraint, which is the real enforcement.
    loginId: z
      .string()
      .trim()
      .regex(/^[A-Za-z0-9._-]{3,32}$/, 'ID must be 3-32 characters: letters, digits, dot, underscore or hyphen')
      .optional(),
    // Contact information since 0027, no longer the login. May be cleared.
    mobile: z.string().trim().max(20).optional(),
    email: z.email().max(200).or(z.literal('')).optional(),
    roleId: z.uuid().optional(),
    isActive: z.boolean().optional(),
    password: z.string().min(8).max(200).optional(),
    lodgingUnitId: z.uuid().nullish(),
    propertyIds: z.array(z.uuid()).optional(),
  })
  .refine((v) => Object.keys(v).length > 0, { message: 'no fields to update' })

/** PUT /users/:id — change role, activate/deactivate, edit details, reset password. */
export const PUT = route(async (req: NextRequest, ctx: { params: Promise<{ id: string }> }) => {
  const actor = await requirePermission('roles_users', 'create_edit')
  const { id } = await ctx.params
  const input = updateSchema.parse(await req.json())

  const updated = await db.transaction(async (tx) => {
    const [before] = await tx
      .select({
        fullName: schema.users.fullName,
        loginId: schema.users.loginId,
        mobile: schema.users.mobile,
        email: schema.users.email,
        roleId: schema.users.roleId,
        isActive: schema.users.isActive,
      })
      .from(schema.users)
      .where(eq(schema.users.id, id))
      .limit(1)
    if (!before) throw notFound('User not found')

    // The role name drives which scope applies, so it is needed whether the role changed or
    // not — an unchanged Lodge Manager still has their lodge validated.
    const [role] = await tx
      .select({ id: schema.roles.id, name: schema.roles.name })
      .from(schema.roles)
      .where(eq(schema.roles.id, input.roleId ?? before.roleId))
      .limit(1)
    if (!role) throw badRequest('roleId does not refer to an existing role')

    // Case-insensitively, matching the unique index on lower(login_id) (0027). Compared
    // that way too, so re-saving 'admin' as 'Admin' is a rename, not a false clash.
    if (input.loginId !== undefined && input.loginId.toLowerCase() !== before.loginId.toLowerCase()) {
      const [dupe] = await tx
        .select({ id: schema.users.id })
        .from(schema.users)
        .where(sql`lower(${schema.users.loginId}) = ${input.loginId.toLowerCase()}`)
        .limit(1)
      if (dupe) throw conflict(`A user with ID ${input.loginId} already exists`)
    }

    const patch: Record<string, unknown> = {}
    if (input.fullName !== undefined) patch.fullName = input.fullName
    if (input.loginId !== undefined) patch.loginId = input.loginId
    if (input.mobile !== undefined) patch.mobile = input.mobile || null
    if (input.email !== undefined) patch.email = input.email || null
    if (input.roleId !== undefined) patch.roleId = input.roleId
    if (input.isActive !== undefined) patch.isActive = input.isActive
    if (input.password !== undefined) patch.passwordHash = await bcrypt.hash(input.password, 10)

    const [row] = await tx
      .update(schema.users)
      .set(patch)
      .where(eq(schema.users.id, id))
      .returning({
        id: schema.users.id,
        fullName: schema.users.fullName,
        loginId: schema.users.loginId,
        mobile: schema.users.mobile,
        email: schema.users.email,
        isActive: schema.users.isActive,
        roleId: schema.users.roleId,
      })

    // Audit the visible field changes; the password is audited as an event, never a value.
    const entries = diffEntries(
      { entity: 'users', entityId: id },
      { fullName: before.fullName, loginId: before.loginId, mobile: before.mobile, email: before.email, roleId: before.roleId, isActive: before.isActive },
      { fullName: row!.fullName, loginId: row!.loginId, mobile: row!.mobile, email: row!.email, roleId: row!.roleId, isActive: row!.isActive },
    )
    if (input.password !== undefined) {
      entries.push({ entity: 'users', entityId: id, action: 'update', field: 'password_hash', newValue: '(reset)' })
    }
    await audit(tx, actor, entries)

    await applyUserScope(tx, actor, id, role.name, {
      lodgingUnitId: input.lodgingUnitId,
      propertyIds: input.propertyIds,
    })
    return row!
  })

  return ok({ user: updated })
})

/**
 * DELETE /users/:id — remove a user who was created by mistake.
 *
 * Most users cannot be removed, and that is the audit trail working as designed: every write
 * they have ever made holds `audit_log.user_id` pointing at them, and the log is append-only
 * (CLAUDE.md rule 5), so there is no row to clean up first. Postgres refuses the delete with
 * a foreign-key violation, which is translated below into the action that IS correct for a
 * member of staff who has left — Disable, which signs them out on their next request and
 * leaves their history readable.
 *
 * So this succeeds for the case it exists to serve: an account typed in wrong that has never
 * done anything.
 */
export const DELETE = route(async (_req: NextRequest, ctx: { params: Promise<{ id: string }> }) => {
  const actor = await requirePermission('roles_users', 'delete')
  const { id } = await ctx.params
  if (id === actor.id) throw badRequest('You cannot delete your own account')

  await db.transaction(async (tx) => {
    const [target] = await tx
      .select({ fullName: schema.users.fullName, mobile: schema.users.mobile })
      .from(schema.users)
      .where(eq(schema.users.id, id))
      .limit(1)
    if (!target) throw notFound('User not found')

    // Release anything pointing at them that is a setting rather than a record: the
    // properties they managed. Their audit history is not a setting and is never touched.
    await tx
      .update(schema.properties)
      .set({ banquetManagerId: null })
      .where(eq(schema.properties.banquetManagerId, id))

    await audit(tx, actor, {
      entity: 'users',
      entityId: id,
      action: 'delete',
      field: 'full_name',
      oldValue: target.fullName,
    })

    try {
      await tx.delete(schema.users).where(eq(schema.users.id, id))
    } catch (err) {
      if (pgCode(err) === FOREIGN_KEY_VIOLATION) {
        throw conflict(
          `${target.fullName} has already recorded work in the system, so the account cannot be ` +
            'deleted without breaking the audit trail. Disable it instead — they are signed out ' +
            'on their next request and can no longer sign in.',
        )
      }
      throw err
    }
  })

  return ok({ deleted: true })
})

const FOREIGN_KEY_VIOLATION = '23503'

function pgCode(err: unknown): string | undefined {
  let cur: unknown = err
  for (let i = 0; i < 5 && cur && typeof cur === 'object'; i++) {
    if ('code' in cur && typeof (cur as { code: unknown }).code === 'string') return (cur as { code: string }).code
    cur = (cur as { cause?: unknown }).cause
  }
  return undefined
}
