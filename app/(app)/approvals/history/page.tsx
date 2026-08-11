import { redirect } from 'next/navigation'
import { getCurrentUser } from '@/lib/auth'
import { ApprovalsHistory } from '@/components/approvals-history'

// The deciders. The history is their record of every settled escalation; a raiser sees only
// their own outcomes on the queue, never the full log.
const DECIDER_ROLES = new Set(['higher_authority', 'auditor'])

export default async function ApprovalsHistoryPage() {
  const user = await getCurrentUser()
  if (!user) redirect('/login')
  if (!DECIDER_ROLES.has(user.roleName)) redirect('/')

  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <h1 className="text-2xl font-semibold">Approvals history</h1>
      <ApprovalsHistory />
    </div>
  )
}
