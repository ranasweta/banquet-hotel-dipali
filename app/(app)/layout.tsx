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
  // itself. Previously `min-h-dvh` let a long sidebar (the Auditor sees every module)
  // stretch the whole page, which also stopped the calendars from ever fitting one screen.
  return (
    <div className="flex h-dvh overflow-hidden">
      <AppNav user={{ fullName: user.fullName, roleName: user.roleName }} permissions={permissions} />
      <main className="flex-1 overflow-auto p-6">{children}</main>
    </div>
  )
}
