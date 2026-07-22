'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import Image from 'next/image'
import { usePathname, useRouter } from 'next/navigation'
import {
  BadgeCheck,
  BarChart3,
  BedDouble,
  CalendarDays,
  ChefHat,
  FileText,
  LayoutDashboard,
  LogOut,
  PanelLeftClose,
  PanelLeftOpen,
  Repeat2,
  ShieldCheck,
  Users,
  UtensilsCrossed,
  Wrench,
  type LucideIcon,
} from 'lucide-react'
import { api } from '@/lib/http'
import { Button } from '@/components/ui/button'
import { NotificationBell } from '@/components/notification-bell'
import { cn } from '@/lib/utils'

type Perm = { module: string; action: string }

const NAV: { href: string; label: string; module?: string; icon: LucideIcon }[] = [
  { href: '/', label: 'Dashboard', icon: LayoutDashboard },
  { href: '/bookings', label: 'Proposal', module: 'bookings', icon: FileText },
  { href: '/calendar', label: 'Calendar', module: 'calendar', icon: CalendarDays },
  // The 15-day operations board (client, 21 Jul 2026). It is the Banquet Manager's main
  // screen, so it earns a sidebar row — the Chef and Booking Manager reach the same board.
  { href: '/day-sheet', label: 'Next 15 days', module: 'calendar', icon: CalendarDays },
  // Rooms stays off the sidebar: it is reached from the dashboard tile that already points
  // at it, so it doesn't need a nav row of its own.
  { href: '/rooms/calendar', label: 'Lodging calendar', module: 'lodging_calendar', icon: BedDouble },
  { href: '/maintenance', label: 'Maintenance', module: 'maintenance', icon: Wrench },
  { href: '/chef', label: 'Chef requests', module: 'menus', icon: ChefHat },
  { href: '/approvals', label: 'Approvals', module: 'approvals', icon: BadgeCheck },
  { href: '/change-requests', label: 'Change requests', module: 'calendar', icon: Repeat2 },
  { href: '/reports', label: 'Reports', module: 'audit', icon: BarChart3 },
  { href: '/admin/menus', label: 'Menu master', module: 'menu_master', icon: UtensilsCrossed },
  { href: '/admin/roles', label: 'Roles & permissions', module: 'roles_users', icon: ShieldCheck },
  { href: '/admin/users', label: 'Users', module: 'roles_users', icon: Users },
]

const STORAGE_KEY = 'dipali:nav-collapsed'

export function AppNav({
  user,
  permissions,
}: {
  user: { fullName: string; roleName: string }
  permissions: Perm[]
}) {
  const pathname = usePathname()
  const router = useRouter()
  const [collapsed, setCollapsed] = useState(false)

  // Read the saved preference after mount rather than during render: the server has no
  // localStorage, so seeding state from it directly would hydrate mismatched.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setCollapsed(window.localStorage.getItem(STORAGE_KEY) === '1')
  }, [])

  function toggle() {
    setCollapsed((c) => {
      window.localStorage.setItem(STORAGE_KEY, c ? '0' : '1')
      return !c
    })
  }

  const canView = (module?: string) =>
    !module || permissions.some((p) => p.module === module && p.action === 'view')
  const canCreate = (module: string) =>
    permissions.some((p) => p.module === module && p.action === 'create_edit')

  // "Proposal" opens the date/time-first new-proposal flow for users who can create one;
  // view-only roles land on the proposals list instead.
  const resolveHref = (item: { href: string; module?: string }) =>
    item.href === '/bookings' && canCreate('bookings') ? '/bookings/new' : item.href

  // Longest match wins, so /rooms/calendar doesn't also light up /rooms.
  const activeHref = NAV.map((i) => i.href)
    .filter((href) => pathname === href || (href !== '/' && pathname.startsWith(`${href}/`)))
    .sort((a, b) => b.length - a.length)[0]

  async function logout() {
    await api('/auth/logout', { method: 'POST' })
    router.replace('/login')
    router.refresh()
  }

  // The Banquet Manager's whole job is the next fifteen days (client, 22 Jul 2026: "keep
  // next 15 days and dashboard, that's it, nothing more"). The board and the venue calendar
  // and change requests all share the `calendar` module, so permission alone cannot show
  // one without the others — hence a role allowlist here. Their read grants on bookings,
  // menus, maintenance and approvals are revoked too (migration 0016), so those pages bounce
  // them rather than only hiding from the sidebar.
  const BANQUET_ONLY = new Set(['/', '/day-sheet'])
  const items = NAV.filter((item) => canView(item.module)).filter(
    (item) => user.roleName !== 'banquet_manager' || BANQUET_ONLY.has(item.href),
  )

  return (
    <aside
      className={cn(
        'flex shrink-0 flex-col border-r bg-sidebar text-sidebar-foreground transition-[width] duration-200 ease-out',
        collapsed ? 'w-[4.5rem]' : 'w-60',
      )}
    >
      {/* Brand. The mark itself when there is room for it, the diamond alone when collapsed —
          the logo ships on a white background rather than transparent, so `mix-blend-multiply`
          drops that white into the sidebar instead of showing a box around it. */}
      <div className={cn('flex items-start gap-2 border-b p-4', collapsed && 'flex-col items-center gap-3 px-2')}>
        {collapsed ? (
          <Image
            src="/hotel-dipali-logo.png"
            alt="Hotel Dipali"
            width={128}
            height={128}
            // Cropped to the diamond-and-monogram: the wordmark underneath is illegible at
            // 36px and would just read as a grey smudge.
            className="size-9 shrink-0 object-cover object-top mix-blend-multiply dark:mix-blend-normal"
          />
        ) : (
          <div className="flex min-w-0 flex-1 items-center gap-2.5">
            <Image
              src="/hotel-dipali-logo.png"
              alt=""
              width={128}
              height={128}
              className="size-9 shrink-0 object-cover object-top mix-blend-multiply dark:mix-blend-normal"
            />
            <div className="min-w-0">
              <div className="truncate font-[family-name:var(--font-serif)] text-base font-bold tracking-tight text-sidebar-primary">
                Hotel Dipali
              </div>
              <div className="truncate text-xs text-muted-foreground">Banquet Management</div>
            </div>
          </div>
        )}
        <NotificationBell />
      </div>

      <nav className="flex-1 space-y-0.5 overflow-y-auto p-2" aria-label="Main">
        {items.map((item) => {
          const active = item.href === activeHref
          const Icon = item.icon
          return (
            <Link
              key={item.href}
              href={resolveHref(item)}
              aria-current={active ? 'page' : undefined}
              // The label is the accessible name when collapsed; `title` gives sighted
              // users the same hint on hover, since the text is hidden by choice.
              aria-label={collapsed ? item.label : undefined}
              title={collapsed ? item.label : undefined}
              className={cn(
                'flex min-h-11 items-center gap-3 rounded-lg px-3 text-sm transition-colors',
                'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sidebar-ring',
                collapsed && 'justify-center px-0',
                active
                  ? 'bg-sidebar-primary font-medium text-sidebar-primary-foreground'
                  : 'text-sidebar-foreground hover:bg-sidebar-accent hover:text-sidebar-accent-foreground',
              )}
            >
              <Icon className="size-[18px] shrink-0" aria-hidden />
              {!collapsed && <span className="truncate">{item.label}</span>}
            </Link>
          )
        })}
      </nav>

      <div className="border-t p-2">
        <button
          type="button"
          onClick={toggle}
          aria-expanded={!collapsed}
          aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
          title={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
          className={cn(
            'mb-2 flex min-h-11 w-full items-center gap-3 rounded-lg px-3 text-sm text-muted-foreground transition-colors hover:bg-sidebar-accent hover:text-sidebar-accent-foreground',
            'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sidebar-ring',
            collapsed && 'justify-center px-0',
          )}
        >
          {collapsed ? <PanelLeftOpen className="size-[18px]" aria-hidden /> : <PanelLeftClose className="size-[18px]" aria-hidden />}
          {!collapsed && <span>Collapse</span>}
        </button>

        <div className={cn('flex items-center gap-2 px-1', collapsed && 'flex-col gap-2 px-0')}>
          <span
            className="grid size-9 shrink-0 place-items-center rounded-full bg-sidebar-primary text-sm font-medium text-sidebar-primary-foreground"
            aria-hidden
          >
            {user.fullName.trim().charAt(0).toUpperCase()}
          </span>
          {!collapsed && (
            <div className="min-w-0 flex-1">
              <div className="truncate text-sm font-medium">{user.fullName}</div>
              <div className="truncate text-xs text-muted-foreground">{formatRole(user.roleName)}</div>
            </div>
          )}
          <Button variant="ghost" size="icon" onClick={logout} aria-label="Sign out" title="Sign out">
            <LogOut className="size-[18px]" aria-hidden />
          </Button>
        </div>
      </div>
    </aside>
  )
}

function formatRole(name: string): string {
  return name.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())
}
