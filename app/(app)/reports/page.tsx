import { redirect } from 'next/navigation'
import { getCurrentUser, getPermissionMatrix } from '@/lib/auth'
import { ReportsView } from '@/components/reports-view'

export default async function ReportsPage() {
  const user = await getCurrentUser()
  if (!user) redirect('/login')
  const perms = await getPermissionMatrix(user.roleId)
  if (!perms.some((p) => p.module === 'audit' && p.action === 'view')) redirect('/')

  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">Reports</h1>
        <p className="text-muted-foreground">Occupancy, revenue, pipeline, exceptions, maintenance and outstanding balances.</p>
      </div>
      <ReportsView />
    </div>
  )
}
