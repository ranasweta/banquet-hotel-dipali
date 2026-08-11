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
        <p className="text-muted-foreground">
          Rates are dated — a menu already saved keeps the rate it was saved with.
        </p>
      </div>
      <MenuMaster canEdit={can('create_edit')} canDelete={can('delete')} />
    </div>
  )
}
