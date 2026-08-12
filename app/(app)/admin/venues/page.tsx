import { getPermissionMatrix, requirePageView } from '@/lib/auth'
import { VenueMaster } from '@/components/venue-master'

/**
 * The venue master (module `venue_master`, client 12 Aug 2026). The halls, the bundles made
 * out of them, and what each costs per event type — the whole of what pricing reads about a
 * venue, in one place the Auditor owns.
 *
 * Seeded to the Auditor as `full` and the Higher Authority as `edit`, mirroring `menu_master`;
 * anyone else the Auditor grants it to from /admin/roles gets the same screen, since every
 * control here is driven by the permission and not by a role name.
 */
export default async function VenueMasterPage() {
  const user = await requirePageView('venue_master')
  const perms = await getPermissionMatrix(user.roleId)
  const can = (action: string) => perms.some((p) => p.module === 'venue_master' && p.action === action)

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">Venue master</h1>
        <p className="text-muted-foreground">
          Rates are dated — a booking already confirmed keeps the rate it was confirmed at.
        </p>
      </div>
      <VenueMaster canEdit={can('create_edit')} canDelete={can('delete')} />
    </div>
  )
}
