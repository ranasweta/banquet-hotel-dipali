import { redirect } from 'next/navigation'
import { getCurrentUser, getPermissionMatrix } from '@/lib/auth'
import { ChangeRequestsQueue } from '@/components/change-requests-queue'

export default async function ChangeRequestsPage() {
  const user = await getCurrentUser()
  if (!user) redirect('/login')
  const perms = await getPermissionMatrix(user.roleId)
  if (!perms.some((p) => p.module === 'calendar' && p.action === 'view')) redirect('/')
  // Deciding venue/timing changes is the Banquet Manager's (calendar create_edit).
  const canDecide = perms.some((p) => p.module === 'calendar' && p.action === 'create_edit')

  return (
    <div className="mx-auto max-w-4xl space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">Change requests</h1>
        <p className="text-muted-foreground">
          {canDecide
            ? 'Approve or reject venue / date / time changes on confirmed bookings. Approval re-books the slot.'
            : 'Requested venue / date / time changes and their outcomes.'}
        </p>
      </div>
      <ChangeRequestsQueue canDecide={canDecide} />
    </div>
  )
}
