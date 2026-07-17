import type { NextRequest } from 'next/server'
import { eq } from 'drizzle-orm'
import { z } from 'zod'
import { db, schema } from '@/db/drizzle'
import { requirePermission } from '@/lib/auth'
import { audit } from '@/lib/audit'
import { notFound, ok, route } from '@/lib/api'
import { MODULES } from '@/db/masters'

const permission = z.object({
  module: z.enum(MODULES),
  action: z.enum(['view', 'create_edit', 'delete']),
})

const bodySchema = z.object({
  // The full desired grant set for this role. The handler replaces all existing rows
  // with exactly this set, so the matrix screen can send the whole grid.
  permissions: z.array(permission).max(MODULES.length * 3),
})

const key = (p: { module: string; action: string }) => `${p.module}:${p.action}`

/** PUT /roles/:id/permissions — replace a role's entire permission matrix. */
export const PUT = route(async (req: NextRequest, ctx: { params: Promise<{ id: string }> }) => {
  const actor = await requirePermission('roles_users', 'create_edit')
  const { id } = await ctx.params
  const { permissions } = bodySchema.parse(await req.json())

  // De-dupe — the same grant sent twice is one grant, and the PK forbids duplicates.
  const desired = [...new Map(permissions.map((p) => [key(p), p])).values()]

  const saved = await db.transaction(async (tx) => {
    const [role] = await tx
      .select({ id: schema.roles.id })
      .from(schema.roles)
      .where(eq(schema.roles.id, id))
      .limit(1)
    if (!role) throw notFound('Role not found')

    const before = await tx
      .select({ module: schema.rolePermissions.moduleCode, action: schema.rolePermissions.action })
      .from(schema.rolePermissions)
      .where(eq(schema.rolePermissions.roleId, id))

    // Replace-all: clear the role's grants, then insert the desired set.
    await tx.delete(schema.rolePermissions).where(eq(schema.rolePermissions.roleId, id))
    if (desired.length) {
      await tx
        .insert(schema.rolePermissions)
        .values(desired.map((p) => ({ roleId: id, moduleCode: p.module, action: p.action })))
    }

    // Audit only the net change, oldest-first, so the trail reads as add/remove events.
    const beforeSet = new Set(before.map(key))
    const afterSet = new Set(desired.map(key))
    const added = desired.filter((p) => !beforeSet.has(key(p)))
    const removed = before.filter((p) => !afterSet.has(key(p)))
    await audit(tx, actor, [
      ...removed.map((p) => ({
        entity: 'role_permissions',
        entityId: id,
        action: 'delete' as const,
        field: p.module,
        oldValue: p.action,
      })),
      ...added.map((p) => ({
        entity: 'role_permissions',
        entityId: id,
        action: 'insert' as const,
        field: p.module,
        newValue: p.action,
      })),
    ])

    return desired
  })

  return ok({ permissions: saved })
})
