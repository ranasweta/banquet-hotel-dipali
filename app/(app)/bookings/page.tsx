import { getPermissionMatrix, requirePageView } from '@/lib/auth'
import { BookingsList } from '@/components/bookings-list'

export default async function BookingsPage() {
  const user = await requirePageView('bookings')
  const perms = await getPermissionMatrix(user.roleId)
  const canCreate = perms.some((p) => p.module === 'bookings' && p.action === 'create_edit')
  // Higher Authority / Auditor may also edit a CONFIRMED booking in the wizard (tester, 23 Jul 2026).
  const canEditConfirmed = user.roleName === 'higher_authority' || user.roleName === 'auditor'

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">Proposals</h1>
        <p className="text-muted-foreground">
          Open enquiries and confirmed events. Start a new proposal to pick a date &amp; time,
          then only the free venues.
        </p>
      </div>
      <BookingsList canCreate={canCreate} canEditConfirmed={canEditConfirmed} />
    </div>
  )
}
