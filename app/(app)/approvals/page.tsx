import { redirect } from 'next/navigation'
import { getCurrentUser, getPermissionMatrix } from '@/lib/auth'
import { ApprovalsQueue } from '@/components/approvals-queue'

const DECIDER_ROLES = new Set(['higher_authority', 'auditor'])

export default async function ApprovalsPage() {
  const user = await getCurrentUser()
  if (!user) redirect('/login')
  const perms = await getPermissionMatrix(user.roleId)
  if (!perms.some((p) => p.module === 'approvals' && p.action === 'view')) redirect('/')

  // Deciding is Authority/Auditor-only — a behavioural rule beyond the permission bit.
  const canDecide =
    DECIDER_ROLES.has(user.roleName) &&
    perms.some((p) => p.module === 'approvals' && p.action === 'create_edit')

  return (
    <div className="mx-auto max-w-4xl space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">Approvals</h1>
        <p className="text-muted-foreground">
          {canDecide
            ? 'Decide escalations — the approved change is applied automatically.'
            : 'Exceptions you’ve raised and their outcomes. Only the Higher Authority can decide.'}
        </p>
      </div>
      <ApprovalsQueue canDecide={canDecide} />
    </div>
  )
}
