import Link from 'next/link'
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
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold">New proposal</h1>
          <p className="text-muted-foreground">Pick the date &amp; time first — we&apos;ll show only free venues. The slots block only on confirmation with a 25% advance.</p>
        </div>
        <Link href="/bookings" className="shrink-0 text-sm font-medium text-primary underline-offset-4 hover:underline">
          Past proposals →
        </Link>
      </div>
      <BookingWizard />
    </div>
  )
}
