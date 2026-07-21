import { requirePermission } from '@/lib/auth'
import { ok, route } from '@/lib/api'
import { getMasterCatalog } from '@/lib/menu-master'

/**
 * GET /menu/master — the whole catalog: tiers, their full price history, segments and every
 * dish including retired ones.
 *
 * Distinct from `/menu/catalog`, which is the picker's view: that one is gated on `menus`,
 * shows only the currently-effective rate and hides retired dishes. This is the module the
 * permission matrix has always carried and nothing implemented — `menu_master` had no
 * enforcement site anywhere in the codebase until now.
 */
export const GET = route(async () => {
  await requirePermission('menu_master', 'view')
  return ok({ tiers: await getMasterCatalog() })
})
