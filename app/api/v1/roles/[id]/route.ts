import type { NextRequest } from 'next/server'
import { and, eq, ne } from 'drizzle-orm'
import { z } from 'zod'
import { db, schema } from '@/db/drizzle'
import { requirePermission } from '@/lib/auth'
import { audit } from '@/lib/audit'
import { conflict, notFound, ok, route } from '@/lib/api'

const updateSchema = z.object({ name: z.string().trim().min(1).max(64) })

/** PUT /roles/:id — rename a role. */
export const PUT = route(async (req: NextRequest, ctx: { params: Promise<{ id: string }> }) => {
  const actor = await requirePermission('roles_users', 'create_edit')
  const { id } = await ctx.params
  const { name } = updateSchema.parse(await req.json())

  const updated = await db.transaction(async (tx) => {
    const [role] = await tx
      .select({ id: schema.roles.id, name: schema.roles.name })
      .from(schema.roles)
      .where(eq(schema.roles.id, id))
      .limit(1)
    if (!role) throw notFound('Role not found')
    if (role.name === name) return role

    const clash = await tx
      .select({ id: schema.roles.id })
      .from(schema.roles)
      .where(and(eq(schema.roles.name, name), ne(schema.roles.id, id)))
      .limit(1)
    if (clash.length) throw conflict(`A role named "${name}" already exists`)

    const [row] = await tx
      .update(schema.roles)
      .set({ name })
      .where(eq(schema.roles.id, id))
      .returning({ id: schema.roles.id, name: schema.roles.name })

    await audit(tx, actor, {
      entity: 'roles',
      entityId: id,
      action: 'update',
      field: 'name',
      oldValue: role.name,
      newValue: name,
    })
    return row!
  })

  return ok({ role: updated })
})
