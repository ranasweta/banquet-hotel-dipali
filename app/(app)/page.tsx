import { redirect } from 'next/navigation'
import { getCurrentUser, getPermissionMatrix } from '@/lib/auth'
import { getBookingDashboard } from '@/lib/dashboard'
import { DashboardHome } from '@/components/dashboard-home'

export default async function DashboardPage() {
  // Next renders the layout and this page in parallel, so the page cannot rely on the
  // layout's auth guard having run first — it must guard itself.
  const user = await getCurrentUser()
  if (!user) redirect('/login')

  const [permissions, data] = await Promise.all([
    getPermissionMatrix(user.roleId),
    getBookingDashboard(),
  ])
  const canAdmin = permissions.some((p) => p.module === 'roles_users' && p.action === 'view')

  return (
    <DashboardHome
      data={data}
      user={{ fullName: user.fullName, roleName: user.roleName }}
      canAdmin={canAdmin}
    />
  )
}
