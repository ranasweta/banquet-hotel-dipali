import type { NextRequest } from 'next/server'
import { asc, eq, sql } from 'drizzle-orm'
import { z } from 'zod'
import { db, schema } from '@/db/drizzle'
import { requirePermission } from '@/lib/auth'
import { audit } from '@/lib/audit'
import { conflict, ok, route } from '@/lib/api'

/** GET /roles — roles with their grants and user counts, plus the module list for the matrix UI. */
export const GET = route(async () => {
  await requirePermission('roles_users', 'view')

  const roles = await db
    .select({
      id: schema.roles.id,
      name: schema.roles.name,
      isSystem: schema.roles.isSystem,
      userCount: sql<number>`count(distinct ${schema.users.id})::int`,
    })
    .from(schema.roles)
    .leftJoin(schema.users, eq(schema.users.roleId, schema.roles.id))
    .groupBy(schema.roles.id)
    .orderBy(asc(schema.roles.name))

  const perms = await db
    .select({
      roleId: schema.rolePermissions.roleId,
      module: schema.rolePermissions.moduleCode,
      action: schema.rolePermissions.action,
    })
    .from(schema.rolePermissions)

  const byRole = new Map<string, { module: string; action: string }[]>()
  for (const p of perms) {
    const list = byRole.get(p.roleId) ?? []
    list.push({ module: p.module, action: p.action })
    byRole.set(p.roleId, list)
  }

  const modules = await db
    .select({ code: schema.modules.code })
    .from(schema.modules)
    .orderBy(asc(schema.modules.code))

  return ok({
    roles: roles.map((r) => ({ ...r, permissions: byRole.get(r.id) ?? [] })),
    modules: modules.map((m) => m.code),
    actions: ['view', 'create_edit', 'delete'],
  })
})

const createSchema = z.object({ name: z.string().trim().min(1).max(64) })

/** POST /roles — create a role. */
export const POST = route(async (req: NextRequest) => {
  const actor = await requirePermission('roles_users', 'create_edit')
  const { name } = createSchema.parse(await req.json())

  const created = await db.transaction(async (tx) => {
    const existing = await tx
      .select({ id: schema.roles.id })
      .from(schema.roles)
      .where(eq(schema.roles.name, name))
      .limit(1)
    if (existing.length) throw conflict(`A role named "${name}" already exists`)

    const [row] = await tx
      .insert(schema.roles)
      .values({ name, isSystem: false })
      .returning({ id: schema.roles.id, name: schema.roles.name, isSystem: schema.roles.isSystem })

    await audit(tx, actor, {
      entity: 'roles',
      entityId: row!.id,
      action: 'insert',
      field: 'name',
      newValue: name,
    })
    return row!
  })

  return ok({ role: { ...created, permissions: [] } }, 201)
})
