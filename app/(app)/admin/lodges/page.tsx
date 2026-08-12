import { getPermissionMatrix, requirePageView } from '@/lib/auth'
import { LodgeMaster } from '@/components/lodge-master'

/**
 * The lodge master (module `lodge_master`, client 13 Aug 2026). The venue master's counterpart
 * for rooms: each lodge's categories, how many rooms of each there are and what one costs a
 * night.
 *
 * Seeded to the Auditor as `full` and the Higher Authority as `edit`. Deliberately NOT the
 * Lodge Manager's: they run the day sheet through `lodging_calendar` and `rooms`, which is a
 * different job from re-pricing the hotel.
 */
export default async function LodgeMasterPage() {
  const user = await requirePageView('lodge_master')
  const perms = await getPermissionMatrix(user.roleId)
  const can = (action: string) => perms.some((p) => p.module === 'lodge_master' && p.action === action)

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">Lodge master</h1>
        <p className="text-muted-foreground">
          Categories, how many rooms of each, and the nightly rate.
        </p>
      </div>
      <LodgeMaster canEdit={can('create_edit')} canDelete={can('delete')} />
    </div>
  )
}
