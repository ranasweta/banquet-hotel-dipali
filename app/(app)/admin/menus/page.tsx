import { getPermissionMatrix, requirePageView } from '@/lib/auth'
import { MenuMaster } from '@/components/menu-master'

/**
 * The menu master (module `menu_master`). The hotel's printed card kept current: tiers and
 * their per-plate rates, the segments on each and the dishes on those.
 *
 * Seeded to the Auditor as `full` and the Higher Authority as `edit`; anyone else the
 * Auditor grants it to from /admin/roles gets the same screen, since every control here is
 * driven by the permission and not by a role name.
 */
export default async function MenuMasterPage() {
  const user = await requirePageView('menu_master')
  const perms = await getPermissionMatrix(user.roleId)
  const can = (action: string) => perms.some((p) => p.module === 'menu_master' && p.action === action)

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">Menu master</h1>
        <p className="max-w-2xl text-muted-foreground">
          Every tier, its per-plate rate and the dishes on it. Rates are dated: a new price
          applies to functions on or after its date, and menus already saved keep the rate
          they were saved with — a booked event is never re-priced.
        </p>
      </div>
      <MenuMaster canEdit={can('create_edit')} canDelete={can('delete')} />
    </div>
  )
}
