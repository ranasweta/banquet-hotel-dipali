import { getPermissionMatrix, requirePageView } from '@/lib/auth'
import { BookingsList } from '@/components/bookings-list'

export default async function BookingsPage() {
  const user = await requirePageView('bookings')
  const perms = await getPermissionMatrix(user.roleId)
  const canCreate = perms.some((p) => p.module === 'bookings' && p.action === 'create_edit')

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">Bookings</h1>
        <p className="text-muted-foreground">
          Enquiries and confirmed events. Start a new booking to walk through the five-step wizard.
        </p>
      </div>
      <BookingsList canCreate={canCreate} />
    </div>
  )
}
