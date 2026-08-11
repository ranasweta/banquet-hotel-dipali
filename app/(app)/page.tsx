import { redirect } from 'next/navigation'
import { getCurrentUser, getPermissionMatrix } from '@/lib/auth'
import { getDashboardForRole } from '@/lib/dashboard'
import { DashboardHome } from '@/components/dashboard-home'
import { BanquetDashboard } from '@/components/dashboard-banquet'
import { LodgeDashboard } from '@/components/dashboard-lodge'
import { MaintenanceDashboard } from '@/components/dashboard-maintenance'
import { ChefDashboard } from '@/components/dashboard-chef'
import { AuthorityDashboard } from '@/components/dashboard-authority'
import { AuditorDashboard } from '@/components/dashboard-auditor'
import { PushSetup } from '@/components/push-setup'

export default async function DashboardPage() {
  // Next renders the layout and this page in parallel, so the page cannot rely on the
  // layout's auth guard having run first — it must guard itself.
  const user = await getCurrentUser()
  if (!user) redirect('/login')

  const [permissions, board] = await Promise.all([
    getPermissionMatrix(user.roleId),
    getDashboardForRole(user.roleName, undefined, user),
  ])
  const canAdmin = permissions.some((p) => p.module === 'roles_users' && p.action === 'view')
  const u = { fullName: user.fullName, roleName: user.roleName }

  // Registers the service worker (which is what makes the app installable) and offers phone
  // notifications. It lives on the dashboard because that is the manifest's `start_url`, so
  // an installed app lands here every cold start; the button itself renders nothing at all on
  // a browser that cannot do push.
  const push = <PushSetup vapidPublicKey={process.env.VAPID_PUBLIC_KEY ?? null} />

  // Every role gets its own board (getDashboardForRole); the discriminant keeps it type-safe,
  // so adding a role forces a case here rather than silently inheriting someone else's screen.
  function renderBoard() {
    switch (board.kind) {
      case 'banquet':
        return <BanquetDashboard data={board} user={u} />
      case 'lodge':
        return <LodgeDashboard data={board} user={u} />
      case 'maintenance':
        return <MaintenanceDashboard data={board} user={u} />
      case 'chef':
        return <ChefDashboard data={board} user={u} />
      case 'authority':
        return <AuthorityDashboard data={board} user={u} />
      case 'auditor':
        return <AuditorDashboard data={board} user={u} />
      default:
        return <DashboardHome data={board} user={u} canAdmin={canAdmin} />
    }
  }

  return (
    <>
      {renderBoard()}
      <div className="mx-auto mt-6 flex max-w-6xl justify-end">{push}</div>
    </>
  )
}
