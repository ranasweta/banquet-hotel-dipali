import type { NextRequest } from 'next/server'
import { eq } from 'drizzle-orm'
import bcrypt from 'bcryptjs'
import { z } from 'zod'
import { db, schema } from '@/db/drizzle'
import { requirePermission } from '@/lib/auth'
import { audit, diffEntries } from '@/lib/audit'
import { badRequest, ok, notFound, route } from '@/lib/api'

const updateSchema = z
  .object({
    fullName: z.string().trim().min(1).max(120).optional(),
    email: z.email().max(200).or(z.literal('')).optional(),
    roleId: z.uuid().optional(),
    isActive: z.boolean().optional(),
    password: z.string().min(8).max(200).optional(),
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
        email: schema.users.email,
        roleId: schema.users.roleId,
        isActive: schema.users.isActive,
      })
      .from(schema.users)
      .where(eq(schema.users.id, id))
      .limit(1)
    if (!before) throw notFound('User not found')

    if (input.roleId) {
      const [role] = await tx
        .select({ id: schema.roles.id })
        .from(schema.roles)
        .where(eq(schema.roles.id, input.roleId))
        .limit(1)
      if (!role) throw badRequest('roleId does not refer to an existing role')
    }

    const patch: Record<string, unknown> = {}
    if (input.fullName !== undefined) patch.fullName = input.fullName
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
        mobile: schema.users.mobile,
        email: schema.users.email,
        isActive: schema.users.isActive,
        roleId: schema.users.roleId,
      })

    // Audit the visible field changes; the password is audited as an event, never a value.
    const entries = diffEntries(
      { entity: 'users', entityId: id },
      { fullName: before.fullName, email: before.email, roleId: before.roleId, isActive: before.isActive },
      { fullName: row!.fullName, email: row!.email, roleId: row!.roleId, isActive: row!.isActive },
    )
    if (input.password !== undefined) {
      entries.push({ entity: 'users', entityId: id, action: 'update', field: 'password_hash', newValue: '(reset)' })
    }
    await audit(tx, actor, entries)
    return row!
  })

  return ok({ user: updated })
})
