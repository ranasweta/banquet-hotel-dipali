import Link from 'next/link'
import { notFound, redirect } from 'next/navigation'
import { getCurrentUser, getPermissionMatrix } from '@/lib/auth'
import { loadEventDetail } from '@/lib/events'
import { BookingWizard } from '@/components/booking-wizard'

/**
 * Continue a saved proposal. Only enquiries are editable this way — once the 25% advance is
 * recorded (confirm), changes route through the approval flow, so a confirmed/locked event is
 * sent back to its read-only detail page rather than reopened in the wizard.
 */
export default async function EditBookingPage({
  params,
}: {
  params: Promise<{ id: string }>
}) {
  const user = await getCurrentUser()
  if (!user) redirect('/login')
  const perms = await getPermissionMatrix(user.roleId)
  if (!perms.some((p) => p.module === 'bookings' && p.action === 'create_edit')) redirect('/bookings')

  const { id } = await params
  const detail = await loadEventDetail(id)
  if (!detail) notFound()
  if (detail.status !== 'enquiry') redirect(`/bookings/${id}`)

  return (
    <div className="mx-auto max-w-4xl space-y-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold">Continue proposal</h1>
          <p className="text-muted-foreground">
            Edit anything below and finish at Payment review — the dates block only once a 25%
            advance is recorded.
          </p>
        </div>
        <Link href={`/bookings/${id}`} className="shrink-0 text-sm font-medium text-primary underline-offset-4 hover:underline">
          Back to booking →
        </Link>
      </div>
      <BookingWizard resumeEventId={id} />
    </div>
  )
}
