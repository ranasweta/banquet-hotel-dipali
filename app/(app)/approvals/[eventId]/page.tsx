import { redirect } from 'next/navigation'
import { getCurrentUser, getPermissionMatrix } from '@/lib/auth'
import { DECIDER_ROLES } from '@/lib/approvals'
import { ApprovalBundle } from '@/components/approval-bundle'

/**
 * One proposal's approval bundle — every pending ask on it, plus the proposal itself, editable.
 * Deciding is Authority/Auditor-only (a behavioural rule beyond the permission bit), and this
 * screen exposes the whole booking, so a role that cannot decide is sent back to the queue.
 */
export default async function ApprovalBundlePage({ params }: { params: Promise<{ eventId: string }> }) {
  const user = await getCurrentUser()
  if (!user) redirect('/login')
  const perms = await getPermissionMatrix(user.roleId)
  if (!perms.some((p) => p.module === 'approvals' && p.action === 'view')) redirect('/')
  if (!DECIDER_ROLES.has(user.roleName) || !perms.some((p) => p.module === 'approvals' && p.action === 'create_edit')) {
    redirect('/approvals')
  }

  const { eventId } = await params
  return (
    <div className="mx-auto max-w-5xl">
      <ApprovalBundle eventId={eventId} />
    </div>
  )
}
