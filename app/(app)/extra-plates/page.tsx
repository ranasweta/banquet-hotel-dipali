import { getCurrentUser, getPermissionMatrix, requirePageView } from '@/lib/auth'
import { ExtraPlatesLog } from '@/components/extra-plates-log'

/**
 * Where the Utensil Manager logs plates issued beyond what a function was catered for (client,
 * 15 Aug 2026). Plates belong to an event, but the role has no Bookings access, so the panel is
 * reached from here. Logging needs create/edit on `utensils`; the Higher Authority and the
 * Auditor hold `view`, which is what lets them check the photograph behind every charge.
 */
export default async function ExtraPlatesPage() {
  await requirePageView('utensils')
  const user = await getCurrentUser()
  const perms = await getPermissionMatrix(user!.roleId)
  const canEdit = perms.some((p) => p.module === 'utensils' && p.action === 'create_edit')

  return (
    <div className="mx-auto max-w-4xl space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">Extra plates</h1>
        <p className="text-muted-foreground">
          {canEdit
            ? 'Every entry needs a photo of the plates. Nothing reaches the bill until you close the event’s log.'
            : 'Read only — each entry carries a photo of the plates it charges for.'}
        </p>
      </div>
      <ExtraPlatesLog canEdit={canEdit} />
    </div>
  )
}
