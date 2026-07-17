import { redirect } from 'next/navigation'
import { getCurrentUser, getPermissionMatrix } from '@/lib/auth'
import { BookingWizard } from '@/components/booking-wizard'

export default async function NewBookingPage() {
  const user = await getCurrentUser()
  if (!user) redirect('/login')
  const perms = await getPermissionMatrix(user.roleId)
  // Creating a booking needs Create/Edit on bookings — not just view.
  if (!perms.some((p) => p.module === 'bookings' && p.action === 'create_edit')) redirect('/bookings')

  return (
    <div className="mx-auto max-w-4xl space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">New booking</h1>
        <p className="text-muted-foreground">Enquiry → confirm. The venue slots block only on confirmation with a 25% advance.</p>
      </div>
      <BookingWizard />
    </div>
  )
}
