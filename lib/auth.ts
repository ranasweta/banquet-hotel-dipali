import 'server-only'
import { and, eq } from 'drizzle-orm'
import { redirect } from 'next/navigation'
import { db, schema } from '@/db/drizzle'
import { forbidden, unauthorized } from '@/lib/api'
import { getSession } from '@/lib/session'
import type { ModuleCode } from '@/db/masters'

export type PermAction = 'view' | 'create_edit' | 'delete'

export type CurrentUser = {
  id: string
  fullName: string
  mobile: string
  email: string | null
  roleId: string
  roleName: string
}

/**
 * The signed-in user, or null. Reads the session cookie (user id only) and loads the
 * user fresh, joined to their role. A deactivated user (is_active = false) resolves to
 * null — flipping the flag locks them out on their next request without a logout.
 */
export async function getCurrentUser(): Promise<CurrentUser | null> {
  const session = await getSession()
  if (!session.userId) return null

  const [row] = await db
    .select({
      id: schema.users.id,
      fullName: schema.users.fullName,
      mobile: schema.users.mobile,
      email: schema.users.email,
      roleId: schema.users.roleId,
      roleName: schema.roles.name,
    })
    .from(schema.users)
    .innerJoin(schema.roles, eq(schema.roles.id, schema.users.roleId))
    .where(and(eq(schema.users.id, session.userId), eq(schema.users.isActive, true)))
    .limit(1)

  return row ?? null
}

/** The signed-in user, or a 401. */
export async function requireAuth(): Promise<CurrentUser> {
  const user = await getCurrentUser()
  if (!user) throw unauthorized()
  return user
}

/**
 * Enforces a permission server-side (NFR-3, CLAUDE.md rule 2). Throws 401 if not signed
 * in, 403 if the user's role lacks `action` on `module`. Reads role_permissions live, so
 * an Admin's matrix edit takes effect on the next request — no re-login.
 *
 * This is the ONLY control. UI hiding is cosmetic; every mutating route calls this.
 */
export async function requirePermission(
  module: ModuleCode,
  action: PermAction,
): Promise<CurrentUser> {
  const user = await requireAuth()
  const [perm] = await db
    .select({ action: schema.rolePermissions.action })
    .from(schema.rolePermissions)
    .where(
      and(
        eq(schema.rolePermissions.roleId, user.roleId),
        eq(schema.rolePermissions.moduleCode, module),
        eq(schema.rolePermissions.action, action),
      ),
    )
    .limit(1)

  if (!perm) {
    throw forbidden(`Your role (${user.roleName}) cannot ${action.replace('_', '/')} ${module}`)
  }
  return user
}

/**
 * Page-level guard for server components: redirect to /login if signed out, or to the
 * dashboard if the role can't view `module`. The API routes still enforce independently
 * — this only keeps a user from landing on a screen they can't use.
 */
export async function requirePageView(module: ModuleCode): Promise<CurrentUser> {
  const user = await getCurrentUser()
  if (!user) redirect('/login')
  const perms = await getPermissionMatrix(user.roleId)
  if (!perms.some((p) => p.module === module && p.action === 'view')) redirect('/')
  return user
}

/** Every (module, action) grant for a role — drives `/auth/me` and UI visibility. */
export async function getPermissionMatrix(
  roleId: string,
): Promise<{ module: string; action: PermAction }[]> {
  const rows = await db
    .select({ module: schema.rolePermissions.moduleCode, action: schema.rolePermissions.action })
    .from(schema.rolePermissions)
    .where(eq(schema.rolePermissions.roleId, roleId))
  return rows
}
