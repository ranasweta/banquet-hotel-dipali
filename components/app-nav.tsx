'use client'

import Link from 'next/link'
import { usePathname, useRouter } from 'next/navigation'
import { api } from '@/lib/http'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'

type Perm = { module: string; action: string }

const NAV: { href: string; label: string; module?: string }[] = [
  { href: '/', label: 'Dashboard' },
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

  async function logout() {
    await api('/auth/logout', { method: 'POST' })
    router.replace('/login')
    router.refresh()
  }

  return (
    <aside className="flex w-60 shrink-0 flex-col border-r bg-muted/30">
      <div className="border-b p-4">
        <div className="font-semibold">Hotel Dipali</div>
        <div className="text-xs text-muted-foreground">Banquet Management</div>
      </div>
      <nav className="flex-1 space-y-1 p-2">
        {NAV.filter((item) => canView(item.module)).map((item) => {
          const active = pathname === item.href
          return (
            <Link
              key={item.href}
              href={item.href}
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
