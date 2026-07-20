import { getCurrentUser, getPermissionMatrix, requirePageView } from '@/lib/auth'
import { MaintenanceLog } from '@/components/maintenance-log'

/**
 * Where maintenance charges are logged. Entries belong to an event, but the Maintenance team
 * has no Bookings access, so they reach the editor from here rather than the event page.
 * Logging needs create/edit on `maintenance`; Banquet and the Authority can look without it.
 */
export default async function MaintenancePage() {
  await requirePageView('maintenance')
  const user = await getCurrentUser()
  const perms = await getPermissionMatrix(user!.roleId)
  const canEdit = perms.some((p) => p.module === 'maintenance' && p.action === 'create_edit')

  return (
    <div className="mx-auto max-w-4xl space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">Maintenance</h1>
        <p className="text-muted-foreground">
          Log extra costs against a live or completed event — generator hours, extra staff, damages.
          {canEdit
            ? ' Charges can be added until you close the event’s maintenance.'
            : ' You have read access; only the Maintenance team can add charges.'}
        </p>
      </div>
      <MaintenanceLog canEdit={canEdit} />
    </div>
  )
}
