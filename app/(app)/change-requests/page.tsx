import { redirect } from 'next/navigation'
import { getCurrentUser, getPermissionMatrix } from '@/lib/auth'
import { DECIDER_ROLES } from '@/lib/change-requests'
import { ChangeRequestsQueue } from '@/components/change-requests-queue'

/**
 * The raiser's record of the venue/date/time changes they asked for.
 *
 * Deciding one no longer happens here (client's lead, 1 Aug 2026): a venue move is a section
 * inside its proposal's approval bundle, so the Authority is sent there rather than made to
 * work a second queue. The page survives for the person who FILED the request — their
 * notification links here to see the outcome — and it is off the sidebar.
 */
export default async function ChangeRequestsPage() {
  const user = await getCurrentUser()
  if (!user) redirect('/login')
  const perms = await getPermissionMatrix(user.roleId)
  if (!perms.some((p) => p.module === 'calendar' && p.action === 'view')) redirect('/')
  if (DECIDER_ROLES.has(user.roleName)) redirect('/approvals')

  return (
    <div className="mx-auto max-w-4xl space-y-6">
      <h1 className="text-2xl font-semibold">Change requests</h1>
      <ChangeRequestsQueue canDecide={false} />
    </div>
  )
}
