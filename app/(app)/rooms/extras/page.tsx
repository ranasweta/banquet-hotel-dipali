import { getCurrentUser, getPermissionMatrix, requirePageView } from '@/lib/auth'
import { LodgeExtrasLog } from '@/components/lodge-extras-log'

/**
 * Where the Lodge Manager logs what the desk gave out beyond the booking (client, 15 Aug 2026):
 * extra rooms, and the in-room dining total. Extras belong to an event, but the role has no
 * Bookings access, so the panel is reached from here rather than the event page. Logging needs
 * create/edit on `rooms`; Booking Managers and the Authority can look without it.
 */
export default async function LodgeExtrasPage() {
  await requirePageView('rooms')
  const user = await getCurrentUser()
  const perms = await getPermissionMatrix(user!.roleId)
  const canEdit = perms.some((p) => p.module === 'rooms' && p.action === 'create_edit')

  return (
    <div className="mx-auto max-w-4xl space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">Lodge extras</h1>
        <p className="text-muted-foreground">
          {canEdit
            ? 'Rooms given beyond the booking, and in-room dining. Nothing reaches the bill until you close the event’s extras.'
            : 'Read only — the Lodge Manager logs extra rooms and in-room dining.'}
        </p>
      </div>
      <LodgeExtrasLog canEdit={canEdit} />
    </div>
  )
}
