import { redirect } from 'next/navigation'
import { getCurrentUser, getPermissionMatrix } from '@/lib/auth'
import { AppNav } from '@/components/app-nav'

/**
 * Guards every page under (app). An unauthenticated visitor is bounced to /login before
 * any child renders. The nav is filtered by permission for tidiness only — each API
 * route re-checks server-side, so hiding a link is never the actual control.
 */
export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const user = await getCurrentUser()
  if (!user) redirect('/login')
  const permissions = await getPermissionMatrix(user.roleId)

  // A proper app shell: the frame is exactly the viewport and each pane scrolls inside
  // itself. Below lg the shell stacks — a top bar (from AppNav) over the content; at lg+
  // the sidebar docks on the left. Padding tightens on phones (tester, 25 Jul 2026).
  return (
    <div className="flex h-dvh flex-col overflow-hidden lg:flex-row">
      <AppNav user={{ fullName: user.fullName, roleName: user.roleName }} permissions={permissions} />
      <main className="flex-1 overflow-auto p-4 lg:p-6">{children}</main>
    </div>
  )
}
