import { requirePermission } from '@/lib/auth'
import { ok, route } from '@/lib/api'
import { getMasterMenuPools, getTierCatalog } from '@/lib/menus'

/**
 * GET /menu/catalog — every tier with its categories and items, for the dish picker.
 * Gated on `menus` view: a Booking Manager reads tiers to build a menu even though the
 * `menu_master` module (editing the tiers themselves) is out of their reach.
 */
export const GET = route(async () => {
  await requirePermission('menus', 'view')
  const [tiers, pools] = await Promise.all([getTierCatalog(), getMasterMenuPools()])
  // `pools` is the master menu (all tiers' items per sub-heading) that Swap picks from.
  return ok({ tiers, pools })
})
