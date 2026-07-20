'use client'

import Link from 'next/link'
import { usePathname, useRouter } from 'next/navigation'
import { api } from '@/lib/http'
import { Button } from '@/components/ui/button'
import { NotificationBell } from '@/components/notification-bell'
import { cn } from '@/lib/utils'

type Perm = { module: string; action: string }

const NAV: { href: string; label: string; module?: string }[] = [
  { href: '/', label: 'Dashboard' },
  { href: '/bookings', label: 'Proposal', module: 'bookings' },
  { href: '/calendar', label: 'Calendar', module: 'calendar' },
  { href: '/day-sheet', label: 'Day sheet', module: 'calendar' },
  { href: '/rooms', label: 'Rooms', module: 'rooms' },
  { href: '/maintenance', label: 'Maintenance', module: 'maintenance' },
  { href: '/chef', label: 'Chef requests', module: 'menus' },
  { href: '/approvals', label: 'Approvals', module: 'approvals' },
  { href: '/change-requests', label: 'Change requests', module: 'calendar' },
  { href: '/reports', label: 'Reports', module: 'audit' },
  { href: '/admin/roles', label: 'Roles & permissions', module: 'roles_users' },
  { href: '/admin/users', label: 'Users', module: 'roles_users' },
]

export function AppNav({
  user,
  permissions,
}: {
  user: { fullName: string; roleName: string }
  permissions: Perm[]
}) {
  const pathname = usePathname()
  const router = useRouter()

  const canView = (module?: string) =>
    !module || permissions.some((p) => p.module === module && p.action === 'view')
  const canCreate = (module: string) =>
    permissions.some((p) => p.module === module && p.action === 'create_edit')

  // "Proposal" opens the date/time-first new-proposal flow for users who can create one;
  // view-only roles land on the proposals list instead.
  const resolveHref = (item: { href: string; module?: string }) =>
    item.href === '/bookings' && canCreate('bookings') ? '/bookings/new' : item.href

  async function logout() {
    await api('/auth/logout', { method: 'POST' })
    router.replace('/login')
    router.refresh()
  }

  return (
    <aside className="flex w-60 shrink-0 flex-col border-r bg-muted/30">
      <div className="flex items-start justify-between border-b p-4">
        <div>
          <div className="font-semibold">Hotel Dipali</div>
          <div className="text-xs text-muted-foreground">Banquet Management</div>
        </div>
        <NotificationBell />
      </div>
      <nav className="flex-1 space-y-1 p-2">
        {NAV.filter((item) => canView(item.module)).map((item) => {
          const active =
            pathname === item.href || (item.href !== '/' && pathname.startsWith(`${item.href}/`))
          return (
            <Link
              key={item.href}
              href={resolveHref(item)}
              className={cn(
                'block rounded-md px-3 py-2 text-sm transition-colors',
                active ? 'bg-primary text-primary-foreground' : 'hover:bg-muted',
              )}
            >
              {item.label}
            </Link>
          )
        })}
      </nav>
      <div className="border-t p-4">
        <div className="text-sm font-medium">{user.fullName}</div>
        <div className="mb-3 text-xs text-muted-foreground">{formatRole(user.roleName)}</div>
        <Button variant="outline" size="sm" className="w-full" onClick={logout}>
          Sign out
        </Button>
      </div>
    </aside>
  )
}

function formatRole(name: string): string {
  return name.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())
}
