'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import Image from 'next/image'
import { usePathname, useRouter } from 'next/navigation'
import { toast } from 'sonner'
import {
  BadgeCheck,
  BarChart3,
  BedDouble,
  BookOpen,
  CalendarDays,
  ChefHat,
  FileText,
  History,
  LayoutDashboard,
  LogOut,
  Menu,
  PanelLeftClose,
  PanelLeftOpen,
  ShieldCheck,
  Users,
  UtensilsCrossed,
  Wrench,
  X,
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
  { href: '/approvals/history', label: 'Approvals history', module: 'approvals', icon: History },
  // No sidebar row for /change-requests: a venue move is decided inside its proposal's
  // approval bundle now (1 Aug 2026). The page remains for the raiser, linked from their
  // notification, so the outcome is still somewhere to be read.
  { href: '/reports', label: 'Reports', module: 'audit', icon: BarChart3 },
  { href: '/admin/menus', label: 'Menu master', module: 'menu_master', icon: UtensilsCrossed },
  { href: '/admin/roles', label: 'Roles & permissions', module: 'roles_users', icon: ShieldCheck },
  { href: '/admin/users', label: 'Users', module: 'roles_users', icon: Users },
  // No module: how to work your own screens is not something a role can be denied.
  { href: '/manual', label: 'User manual', icon: BookOpen },
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
  // `collapsed` is a desktop-only preference; `mobileOpen` drives the off-canvas drawer below lg.
  const [collapsed, setCollapsed] = useState(false)
  const [mobileOpen, setMobileOpen] = useState(false)

  // Read the saved preference after mount rather than during render: the server has no
  // localStorage, so seeding state from it directly would hydrate mismatched.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setCollapsed(window.localStorage.getItem(STORAGE_KEY) === '1')
  }, [])

  // The drawer is a mobile overlay: close it on navigation and on Escape, the way any sheet
  // should (ux: modal-escape, back-behavior).
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setMobileOpen(false)
  }, [pathname])
  useEffect(() => {
    if (!mobileOpen) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setMobileOpen(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [mobileOpen])

  function toggleCollapsed() {
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
    // Only the server can end the session — the cookie is httpOnly, so the browser cannot
    // clear it. If that call fails the user is STILL signed in, and sending them to /login
    // anyway would paint a sign-in screen over a live session: on the shared machine at the
    // front desk, that is the worst possible outcome. Say it failed and stay put.
    // Previously this was an unguarded `await`, so a failure rejected here and the two lines
    // below never ran — the button did nothing at all, silently.
    try {
      await api('/auth/logout', { method: 'POST' })
    } catch {
      toast.error('Could not sign you out — check your connection and try again.')
      return
    }
    router.replace('/login')
    router.refresh()
  }

  // The Banquet Manager's whole job is the next fifteen days (client, 22 Jul 2026: "keep
  // next 15 days and dashboard, that's it, nothing more"). The board and the venue calendar
  // and change requests all share the `calendar` module, so permission alone cannot show
  // one without the others — hence a role allowlist here.
  const BANQUET_ONLY = new Set(['/', '/day-sheet'])
  // The approvals history is the deciders' record — hidden from everyone else, the same way
  // the page redirects non-deciders. Higher Authority and Auditor are the deciders.
  const DECIDER_ROLES = new Set(['higher_authority', 'auditor'])
  const DECIDER_ONLY = new Set(['/approvals/history'])
  const items = NAV.filter((item) => canView(item.module))
    .filter((item) => user.roleName !== 'banquet_manager' || BANQUET_ONLY.has(item.href))
    .filter((item) => !DECIDER_ONLY.has(item.href) || DECIDER_ROLES.has(user.roleName))

  // ── Shared pieces, rendered at both sizes (desktop aside + mobile drawer) ──────────────
  const links = (opts: { collapsed: boolean; onNavigate?: () => void }) => (
    <nav className="flex-1 space-y-0.5 overflow-y-auto p-2" aria-label="Main">
      {items.map((item) => {
        const active = item.href === activeHref
        const Icon = item.icon
        return (
          <Link
            key={item.href}
            href={resolveHref(item)}
            onClick={opts.onNavigate}
            aria-current={active ? 'page' : undefined}
            aria-label={opts.collapsed ? item.label : undefined}
            title={opts.collapsed ? item.label : undefined}
            className={cn(
              'flex min-h-11 items-center gap-3 rounded-lg px-3 text-sm transition-colors',
              'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sidebar-ring',
              opts.collapsed && 'justify-center px-0',
              active
                ? 'bg-sidebar-primary font-medium text-sidebar-primary-foreground'
                : 'text-sidebar-foreground hover:bg-sidebar-accent hover:text-sidebar-accent-foreground',
            )}
          >
            <Icon className="size-[18px] shrink-0" aria-hidden />
            {!opts.collapsed && <span className="truncate">{item.label}</span>}
          </Link>
        )
      })}
    </nav>
  )

  const userRow = (opts: { collapsed: boolean }) => (
    <div className={cn('flex items-center gap-2 px-1', opts.collapsed && 'flex-col gap-2 px-0')}>
      <span
        className="grid size-9 shrink-0 place-items-center rounded-full bg-sidebar-primary text-sm font-medium text-sidebar-primary-foreground"
        aria-hidden
      >
        {user.fullName.trim().charAt(0).toUpperCase()}
      </span>
      {!opts.collapsed && (
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-medium">{user.fullName}</div>
          <div className="truncate text-xs text-muted-foreground">{formatRole(user.roleName)}</div>
        </div>
      )}
      <Button variant="ghost" size="icon" onClick={logout} aria-label="Sign out" title="Sign out">
        <LogOut className="size-[18px]" aria-hidden />
      </Button>
    </div>
  )

  return (
    <>
      {/* ── Mobile top bar (below lg): the hamburger, the brand mark and the bell ────────── */}
      <header className="flex shrink-0 items-center gap-2 border-b bg-sidebar px-3 py-2 text-sidebar-foreground lg:hidden">
        <Button
          variant="ghost"
          size="icon"
          onClick={() => setMobileOpen(true)}
          aria-label="Open menu"
          aria-expanded={mobileOpen}
          className="min-h-11 min-w-11"
        >
          <Menu className="size-5" aria-hidden />
        </Button>
        <Link href="/" className="flex min-w-0 flex-1 items-center gap-2">
          <Image
            src="/hotel-dipali-logo.png"
            alt=""
            width={128}
            height={128}
            className="size-8 shrink-0 object-cover object-top mix-blend-multiply dark:mix-blend-normal"
          />
          <span className="truncate font-[family-name:var(--font-serif)] text-base font-bold tracking-tight text-sidebar-primary">
            Hotel Dipali
          </span>
        </Link>
        <NotificationBell />
      </header>

      {/* ── Mobile drawer (below lg): off-canvas, scrim-dismissible ──────────────────────── */}
      <div
        className={cn('fixed inset-0 z-50 lg:hidden', !mobileOpen && 'pointer-events-none')}
        aria-hidden={!mobileOpen}
      >
        <div
          className={cn(
            'absolute inset-0 bg-black/50 transition-opacity duration-200 motion-reduce:transition-none',
            mobileOpen ? 'opacity-100' : 'opacity-0',
          )}
          onClick={() => setMobileOpen(false)}
        />
        <aside
          className={cn(
            'absolute inset-y-0 left-0 flex w-72 max-w-[85%] flex-col border-r bg-sidebar text-sidebar-foreground shadow-xl',
            'transition-transform duration-200 ease-out motion-reduce:transition-none',
            mobileOpen ? 'translate-x-0' : '-translate-x-full',
          )}
          role="dialog"
          aria-modal="true"
          aria-label="Menu"
        >
          <div className="flex items-center justify-between border-b p-4">
            <div className="flex min-w-0 items-center gap-2.5">
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
            <Button variant="ghost" size="icon" onClick={() => setMobileOpen(false)} aria-label="Close menu" className="min-h-11 min-w-11">
              <X className="size-5" aria-hidden />
            </Button>
          </div>
          {links({ collapsed: false, onNavigate: () => setMobileOpen(false) })}
          <div className="border-t p-2">{userRow({ collapsed: false })}</div>
        </aside>
      </div>

      {/* ── Desktop sidebar (lg+): docked, collapsible ───────────────────────────────────── */}
      <aside
        className={cn(
          'hidden shrink-0 flex-col border-r bg-sidebar text-sidebar-foreground transition-[width] duration-200 ease-out lg:flex',
          collapsed ? 'w-[4.5rem]' : 'w-60',
        )}
      >
        {/* Brand. The mark alone when collapsed; `mix-blend-multiply` drops the logo's white
            background into the sidebar instead of showing a box around it. */}
        <div className={cn('flex items-start gap-2 border-b p-4', collapsed && 'flex-col items-center gap-3 px-2')}>
          {collapsed ? (
            <Image
              src="/hotel-dipali-logo.png"
              alt="Hotel Dipali"
              width={128}
              height={128}
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

        {links({ collapsed })}

        <div className="border-t p-2">
          <button
            type="button"
            onClick={toggleCollapsed}
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

          {userRow({ collapsed })}
        </div>
      </aside>
    </>
  )
}

function formatRole(name: string): string {
  return name.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())
}
