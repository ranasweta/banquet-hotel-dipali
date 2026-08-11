import Link from 'next/link'
import { notFound, redirect } from 'next/navigation'
import { getCurrentUser, getPermissionMatrix } from '@/lib/auth'
import { loadEventDetail } from '@/lib/events'
import { BookingWizard } from '@/components/booking-wizard'

/**
 * Continue / edit a proposal in the wizard. An enquiry is editable by anyone with bookings
 * create_edit. A CONFIRMED booking is editable only by the Higher Authority or Auditor (tester,
 * 23 Jul 2026) — their function changes re-block the venue holds; everyone else, and any later
 * status, is sent back to the detail page (changes there go through the change-request flow).
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

  const isAuthority = user.roleName === 'higher_authority' || user.roleName === 'auditor'
  const editable = detail.status === 'enquiry' || (detail.status === 'confirmed' && isAuthority)
  if (!editable) redirect(`/bookings/${id}`)

  const confirmedEdit = detail.status === 'confirmed'

  return (
    <div className="mx-auto max-w-4xl space-y-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold">{confirmedEdit ? 'Edit booking' : 'Continue proposal'}</h1>
          <p className="text-muted-foreground">
            {confirmedEdit
              ? 'Edits save as you make them, and the venue holds move with the functions.'
              : 'Finish at Payment review — the dates block once an advance is recorded.'}
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
