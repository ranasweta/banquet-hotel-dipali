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
  /** What they type to sign in (mig 0027). */
  loginId: string
  /** Contact information only since 0027 — may be absent. */
  mobile: string | null
  email: string | null
  roleId: string
  roleName: string
  /** The lodge a Lodge Manager is responsible for; NULL for every other role (mig 0013). */
  lodgingUnitId: string | null
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
      loginId: schema.users.loginId,
      mobile: schema.users.mobile,
      email: schema.users.email,
      roleId: schema.users.roleId,
      roleName: schema.roles.name,
      lodgingUnitId: schema.users.lodgingUnitId,
    })
    .from(schema.users)
    .innerJoin(schema.roles, eq(schema.roles.id, schema.users.roleId))
    .where(and(eq(schema.users.id, session.userId), eq(schema.users.isActive, true)))
    .limit(1)

  return row ?? null
}

/**
 * Which lodge a user's room views are limited to; null means all of them.
 *
 * A Lodge Manager is responsible for exactly one lodge (client, 21 Jul 2026). Everyone
 * else who can read rooms — Booking, Banquet, the Authority, the Auditor — sees all three.
 * A Lodge Manager with no lodge set is a configuration mistake, and it fails loudly here
 * rather than quietly widening to every lodge.
 */
export function lodgeScopeFor(user: CurrentUser): string | null {
  if (user.roleName !== 'lodge_manager') return null
  if (!user.lodgingUnitId) {
    throw forbidden('No lodge is assigned to your account — ask an Admin to set one.')
  }
  return user.lodgingUnitId
}

/**
 * The Banquet Manager the operations board should be scoped to, or null for everyone else.
 *
 * A Banquet Manager sees only the venues they own (client, 22 Jul 2026), matched against
 * properties.banquet_manager_id — so this is simply their own id. One manager can own
 * several properties (Regency covers Dipali Grand), which is why the ownership lives on the
 * property, not here. A manager who owns none gets an empty board, not an error: unlike a
 * lodge with no rooms, an empty schedule is a legible state, not a misconfiguration to shout
 * about.
 */
export function banquetScopeFor(user: CurrentUser): string | null {
  return user.roleName === 'banquet_manager' ? user.id : null
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
