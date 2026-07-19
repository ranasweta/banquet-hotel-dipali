import { redirect } from 'next/navigation'
import { getCurrentUser, getPermissionMatrix } from '@/lib/auth'
import { getDashboardForRole } from '@/lib/dashboard'
import { DashboardHome } from '@/components/dashboard-home'
import { BanquetDashboard } from '@/components/dashboard-banquet'
import { LodgeDashboard } from '@/components/dashboard-lodge'
import { MaintenanceDashboard } from '@/components/dashboard-maintenance'

export default async function DashboardPage() {
  // Next renders the layout and this page in parallel, so the page cannot rely on the
  // layout's auth guard having run first — it must guard itself.
  const user = await getCurrentUser()
  if (!user) redirect('/login')

  const [permissions, board] = await Promise.all([
    getPermissionMatrix(user.roleId),
    getDashboardForRole(user.roleName),
  ])
  const canAdmin = permissions.some((p) => p.module === 'roles_users' && p.action === 'view')
  const u = { fullName: user.fullName, roleName: user.roleName }

  // The role determines the board (getDashboardForRole); the discriminant keeps it type-safe.
  switch (board.kind) {
    case 'banquet':
      return <BanquetDashboard data={board} user={u} />
    case 'lodge':
      return <LodgeDashboard data={board} user={u} />
    case 'maintenance':
      return <MaintenanceDashboard data={board} user={u} />
    default:
      return <DashboardHome data={board} user={u} canAdmin={canAdmin} />
  }
}
