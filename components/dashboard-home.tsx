import Link from 'next/link'
import {
  CalendarDays,
  MapPin,
  Users,
  Clock,
  Inbox,
  ClipboardCheck,
  Wallet,
  ArrowRight,
  Phone,
  CircleCheck,
  TriangleAlert,
} from 'lucide-react'
import { formatPaise } from '@/lib/money'
import type { AgendaFunction, BookingDashboard } from '@/lib/dashboard'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { cn } from '@/lib/utils'

/**
 * The home dashboard, server-rendered from getBookingDashboard(). It answers, top to bottom,
 * "what needs me today?": today's functions (hero), the week ahead, and the three attention
 * queues — approvals, 30-day balances, and open enquiries. Pure presentation, no client JS.
 */
export function DashboardHome({
  data,
  user,
  canAdmin,
}: {
  data: BookingDashboard
  user: { fullName: string; roleName: string }
  canAdmin: boolean
}) {
  const { today, upcoming, openEnquiries, approvals, paymentsDue } = data
  const staleCount = openEnquiries.filter((e) => e.stale).length
  const dueNowCount = paymentsDue.filter((p) => p.daysToEvent <= 30 && daysUntilDue(p.balanceDueOn, data.asOf) <= 0).length
  const nextFn = upcoming[0]

  return (
    <div className="mx-auto max-w-6xl space-y-6">
      {/* ── Today hero ─────────────────────────────────────────────── */}
      <section
        className={cn(
          'overflow-hidden rounded-xl ring-1 ring-foreground/10',
          today.length
            ? 'bg-gradient-to-br from-blue-600 to-indigo-700 text-white'
            : 'bg-gradient-to-br from-muted/60 to-card',
        )}
      >
        <div className="p-5 sm:p-6">
          <div className="flex items-center justify-between gap-3">
            <p
              className={cn(
                'text-xs font-medium uppercase tracking-wide',
                today.length ? 'text-blue-100' : 'text-muted-foreground',
              )}
            >
              {greeting()}, {firstName(user.fullName)}
            </p>
            <p className={cn('text-xs tabular-nums', today.length ? 'text-blue-100' : 'text-muted-foreground')}>
              {formatFullDate(data.asOf)}
            </p>
          </div>

          {today.length === 0 ? (
            <div className="mt-3 flex items-start gap-3">
              <CircleCheck className="mt-0.5 size-6 shrink-0 text-emerald-500" aria-hidden />
              <div>
                <h1 className="text-xl font-semibold sm:text-2xl">No events today</h1>
                <p className="mt-1 text-sm text-muted-foreground">
                  {nextFn ? (
                    <>
                      Next up: <span className="font-medium text-foreground">{nextFn.guestName}</span> ·{' '}
                      {nextFn.venueName ?? 'venue TBD'} on {formatDay(nextFn.eventDate)}.
                    </>
                  ) : (
                    'Nothing on the calendar in the next week either.'
                  )}
                </p>
              </div>
            </div>
          ) : (
            <div className="mt-3">
              <h1 className="text-2xl font-semibold sm:text-3xl">
                {today.length} {today.length === 1 ? 'event' : 'events'} today
              </h1>
              <ul className="mt-4 space-y-2">
                {today.map((fn) => (
                  <li
                    key={fn.subEventId}
                    className="flex flex-wrap items-center gap-x-4 gap-y-1 rounded-lg bg-white/10 px-4 py-3 backdrop-blur-sm"
                  >
                    <span className="inline-flex items-center gap-1.5 text-sm font-medium tabular-nums text-blue-50">
                      <Clock className="size-4" aria-hidden />
                      {formatTimeRange(fn.startTime, fn.endTime)}
                    </span>
                    <span className="min-w-0 flex-1 text-base font-semibold">
                      {fn.guestName}
                      <span className="ml-2 font-normal text-blue-100">{fn.name}</span>
                    </span>
                    <span className="inline-flex items-center gap-1.5 text-sm text-blue-50">
                      <MapPin className="size-4" aria-hidden />
                      {fn.venueName ?? 'Venue TBD'}
                    </span>
                    <span className="inline-flex items-center gap-1.5 text-sm text-blue-100">
                      <Users className="size-4" aria-hidden />
                      {fn.pax}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      </section>

      {/* ── KPI strip ──────────────────────────────────────────────── */}
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <KpiTile
          href="/day-sheet"
          icon={<CalendarDays className="size-5" aria-hidden />}
          value={upcoming.length}
          label="Functions · next 7 days"
          tone="blue"
        />
        <KpiTile
          href="/bookings"
          icon={<Inbox className="size-5" aria-hidden />}
          value={openEnquiries.length}
          label="Open enquiries"
          hint={staleCount ? `${staleCount} going cold` : undefined}
          tone={staleCount ? 'amber' : 'slate'}
        />
        <KpiTile
          href="/approvals"
          icon={<ClipboardCheck className="size-5" aria-hidden />}
          value={approvals.total}
          label="Awaiting approval"
          tone={approvals.total ? 'amber' : 'slate'}
        />
        <KpiTile
          href="/bookings"
          icon={<Wallet className="size-5" aria-hidden />}
          value={paymentsDue.length}
          label="Balances due · 30 days"
          hint={dueNowCount ? `${dueNowCount} due now` : undefined}
          tone={dueNowCount ? 'red' : paymentsDue.length ? 'emerald' : 'slate'}
        />
      </div>

      {/* ── Main grid: week ahead + attention queues ───────────────── */}
      <div className="grid gap-6 lg:grid-cols-3">
        <div className="lg:col-span-2">
          <UpcomingAgenda upcoming={upcoming} asOf={data.asOf} />
        </div>
        <div className="space-y-6">
          <ApprovalsCard approvals={approvals} />
          <PaymentsDueCard paymentsDue={paymentsDue} asOf={data.asOf} />
        </div>
      </div>

      {/* ── Open enquiries ─────────────────────────────────────────── */}
      <OpenEnquiriesCard enquiries={openEnquiries} />

      {canAdmin && (
        <div className="flex flex-wrap gap-4 text-sm">
          <Link className="font-medium text-primary underline-offset-4 hover:underline" href="/admin/roles">
            Roles &amp; permissions →
          </Link>
          <Link className="font-medium text-primary underline-offset-4 hover:underline" href="/admin/users">
            Users →
          </Link>
        </div>
      )}
    </div>
  )
}

// ── KPI tile ─────────────────────────────────────────────────────────

const TONE: Record<string, { ring: string; icon: string; value: string }> = {
  blue: { ring: 'ring-blue-500/20', icon: 'bg-blue-100 text-blue-700 dark:bg-blue-950 dark:text-blue-300', value: 'text-foreground' },
  amber: { ring: 'ring-amber-500/30', icon: 'bg-amber-100 text-amber-700 dark:bg-amber-950 dark:text-amber-300', value: 'text-amber-700 dark:text-amber-300' },
  emerald: { ring: 'ring-emerald-500/20', icon: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300', value: 'text-foreground' },
  red: { ring: 'ring-red-500/30', icon: 'bg-red-100 text-red-700 dark:bg-red-950 dark:text-red-300', value: 'text-red-700 dark:text-red-300' },
  slate: { ring: 'ring-foreground/10', icon: 'bg-muted text-muted-foreground', value: 'text-foreground' },
}

function KpiTile({
  href,
  icon,
  value,
  label,
  hint,
  tone,
}: {
  href: string
  icon: React.ReactNode
  value: number
  label: string
  hint?: string
  tone: keyof typeof TONE
}) {
  const t = TONE[tone]
  return (
    <Link
      href={href}
      className={cn(
        'group flex items-center gap-3 rounded-xl bg-card p-4 ring-1 transition-all hover:ring-2 hover:shadow-sm',
        t.ring,
      )}
    >
      <span className={cn('flex size-10 shrink-0 items-center justify-center rounded-lg', t.icon)}>{icon}</span>
      <span className="min-w-0">
        <span className={cn('block text-2xl font-semibold leading-none tabular-nums', t.value)}>{value}</span>
        <span className="mt-1 block truncate text-xs text-muted-foreground">{label}</span>
        {hint && <span className="block truncate text-xs font-medium text-amber-600 dark:text-amber-400">{hint}</span>}
      </span>
    </Link>
  )
}

// ── Next 7 days ──────────────────────────────────────────────────────

function UpcomingAgenda({ upcoming, asOf }: { upcoming: AgendaFunction[]; asOf: string }) {
  const byDate = groupBy(upcoming, (f) => f.eventDate)
  return (
    <Card className="h-full">
      <CardHeader className="flex-row items-center justify-between">
        <CardTitle className="flex items-center gap-2">
          <CalendarDays className="size-4 text-muted-foreground" aria-hidden />
          The week ahead
        </CardTitle>
        <Link href="/day-sheet" className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground">
          Day sheet <ArrowRight className="size-3" aria-hidden />
        </Link>
      </CardHeader>
      <CardContent>
        {upcoming.length === 0 ? (
          <EmptyState icon={<CircleCheck className="size-5 text-emerald-500" aria-hidden />} text="No functions scheduled in the next seven days." />
        ) : (
          <div className="space-y-4">
            {[...byDate.entries()].map(([date, fns]) => (
              <div key={date}>
                <div className="mb-2 flex items-baseline gap-2">
                  <h3 className="text-sm font-semibold">{relativeDay(date, asOf)}</h3>
                  <span className="text-xs text-muted-foreground">
                    {fns.length} {fns.length === 1 ? 'function' : 'functions'}
                  </span>
                </div>
                <ul className="space-y-1.5">
                  {fns.map((fn) => (
                    <li key={fn.subEventId}>
                      <Link
                        href={`/bookings/${fn.eventId}`}
                        className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg border border-transparent px-3 py-2 hover:border-border hover:bg-muted/50"
                      >
                        <span className="w-32 shrink-0 text-xs font-medium tabular-nums text-muted-foreground">
                          {formatTimeRange(fn.startTime, fn.endTime)}
                        </span>
                        <span className="min-w-0 flex-1 truncate text-sm font-medium">
                          {fn.guestName}
                          <span className="ml-1.5 font-normal text-muted-foreground">{fn.name}</span>
                        </span>
                        <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
                          <MapPin className="size-3.5" aria-hidden />
                          {fn.venueName ?? 'TBD'}
                        </span>
                        <StatusPill status={fn.status} />
                      </Link>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  )
}

// ── Approvals ────────────────────────────────────────────────────────

function ApprovalsCard({ approvals }: { approvals: BookingDashboard['approvals'] }) {
  return (
    <Card>
      <CardHeader className="flex-row items-center justify-between">
        <CardTitle className="flex items-center gap-2">
          <ClipboardCheck className="size-4 text-muted-foreground" aria-hidden />
          Awaiting approval
          {approvals.total > 0 && (
            <span className="inline-flex h-5 min-w-5 items-center justify-center rounded-full bg-amber-100 px-1.5 text-xs font-semibold text-amber-700 dark:bg-amber-950 dark:text-amber-300">
              {approvals.total}
            </span>
          )}
        </CardTitle>
        <Link href="/approvals" className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground">
          Queue <ArrowRight className="size-3" aria-hidden />
        </Link>
      </CardHeader>
      <CardContent>
        {approvals.total === 0 ? (
          <EmptyState icon={<CircleCheck className="size-5 text-emerald-500" aria-hidden />} text="Nothing waiting on a decision." />
        ) : (
          <ul className="space-y-2 text-sm">
            {approvals.exceptions.map((x) => (
              <li key={x.id}>
                <Link href="/approvals" className="block rounded-lg border border-transparent px-2 py-1.5 hover:border-border hover:bg-muted/50">
                  <span className="line-clamp-1 font-medium">{x.summary}</span>
                  <span className="text-xs text-muted-foreground">
                    {x.eventCode} · {x.guestName} · {x.raisedByName}
                  </span>
                </Link>
              </li>
            ))}
            {approvals.changeRequests.map((cr) => (
              <li key={cr.id}>
                <Link href="/change-requests" className="block rounded-lg border border-transparent px-2 py-1.5 hover:border-border hover:bg-muted/50">
                  <span className="line-clamp-1 font-medium">Change: {cr.summary}</span>
                  <span className="text-xs text-muted-foreground">
                    {cr.eventCode} · {cr.guestName} · {cr.requestedByName}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  )
}

// ── Payments due within 30 days ──────────────────────────────────────

function PaymentsDueCard({ paymentsDue, asOf }: { paymentsDue: BookingDashboard['paymentsDue']; asOf: string }) {
  return (
    <Card>
      <CardHeader className="flex-row items-center justify-between">
        <CardTitle className="flex items-center gap-2">
          <Wallet className="size-4 text-muted-foreground" aria-hidden />
          Balances due · 30 days
        </CardTitle>
      </CardHeader>
      <CardContent>
        {paymentsDue.length === 0 ? (
          <EmptyState icon={<CircleCheck className="size-5 text-emerald-500" aria-hidden />} text="No balances fall inside the 30-day window." />
        ) : (
          <ul className="space-y-2 text-sm">
            {paymentsDue.map((p) => {
              const dueIn = daysUntilDue(p.balanceDueOn, asOf)
              const overdue = dueIn <= 0
              return (
                <li key={p.eventId}>
                  <Link
                    href={`/bookings/${p.eventId}`}
                    className="flex items-center justify-between gap-2 rounded-lg border border-transparent px-2 py-1.5 hover:border-border hover:bg-muted/50"
                  >
                    <span className="min-w-0">
                      <span className="line-clamp-1 font-medium">{p.guestName}</span>
                      <span className="text-xs text-muted-foreground">
                        {p.code} · event {formatDay(p.eventDate)}
                      </span>
                    </span>
                    <span className="shrink-0 text-right">
                      <span className="block font-semibold tabular-nums">{formatPaise(p.outstandingPaise)}</span>
                      <span
                        className={cn(
                          'text-xs font-medium',
                          overdue ? 'text-red-600 dark:text-red-400' : 'text-amber-600 dark:text-amber-400',
                        )}
                      >
                        {overdue ? 'due now' : `due in ${dueIn}d`}
                      </span>
                    </span>
                  </Link>
                </li>
              )
            })}
          </ul>
        )}
      </CardContent>
    </Card>
  )
}

// ── Open enquiries ───────────────────────────────────────────────────

function OpenEnquiriesCard({ enquiries }: { enquiries: BookingDashboard['openEnquiries'] }) {
  return (
    <Card>
      <CardHeader className="flex-row items-center justify-between">
        <CardTitle className="flex items-center gap-2">
          <Inbox className="size-4 text-muted-foreground" aria-hidden />
          Open enquiries
          <span className="text-sm font-normal text-muted-foreground">still to be locked in</span>
        </CardTitle>
        <Link href="/bookings" className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground">
          All bookings <ArrowRight className="size-3" aria-hidden />
        </Link>
      </CardHeader>
      <CardContent>
        {enquiries.length === 0 ? (
          <EmptyState icon={<CircleCheck className="size-5 text-emerald-500" aria-hidden />} text="No open enquiries — the pipeline is clear." />
        ) : (
          <ul className="divide-y">
            {enquiries.map((e) => (
              <li key={e.id}>
                <Link
                  href={`/bookings/${e.id}`}
                  className="flex flex-wrap items-center gap-x-4 gap-y-1 px-1 py-2.5 hover:bg-muted/50"
                >
                  <span className="font-medium tabular-nums text-primary">{e.code}</span>
                  <span className="min-w-0 flex-1 truncate font-medium">{e.guestName}</span>
                  <span className="text-xs capitalize text-muted-foreground">{e.eventType.replace(/_/g, ' ')}</span>
                  {e.contactPhone && (
                    <span className="inline-flex items-center gap-1 text-xs tabular-nums text-muted-foreground">
                      <Phone className="size-3" aria-hidden />
                      {e.contactPhone}
                    </span>
                  )}
                  <span className="inline-flex items-center gap-1.5 text-xs tabular-nums text-muted-foreground">
                    {e.stale && <TriangleAlert className="size-3.5 text-amber-500" aria-hidden />}
                    idle {e.idleDays}d
                  </span>
                  {e.stale && (
                    <span className="rounded-full bg-amber-100 px-2 py-0.5 text-xs font-medium text-amber-700 dark:bg-amber-950 dark:text-amber-300">
                      going cold
                    </span>
                  )}
                </Link>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  )
}

// ── Bits ─────────────────────────────────────────────────────────────

const STATUS_STYLES: Record<string, string> = {
  confirmed: 'bg-blue-100 text-blue-800 dark:bg-blue-950 dark:text-blue-200',
  in_progress: 'bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-200',
  completed: 'bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-300',
  locked: 'bg-violet-100 text-violet-800 dark:bg-violet-950 dark:text-violet-200',
  billed: 'bg-teal-100 text-teal-800 dark:bg-teal-950 dark:text-teal-200',
  closed: 'bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-400',
}

function StatusPill({ status }: { status: string }) {
  return (
    <span className={cn('rounded-full px-2 py-0.5 text-xs', STATUS_STYLES[status] ?? STATUS_STYLES.completed)}>
      {status.replace(/_/g, ' ')}
    </span>
  )
}

function EmptyState({ icon, text }: { icon: React.ReactNode; text: string }) {
  return (
    <div className="flex items-center gap-2 py-4 text-sm text-muted-foreground">
      {icon}
      {text}
    </div>
  )
}

// ── Date / string helpers (no external date lib; parse parts to stay tz-safe) ──

function parseISO(iso: string): Date {
  const [y, m, d] = iso.split('-').map(Number)
  return new Date(y, m - 1, d)
}

function greeting(): string {
  const h = new Date().getHours()
  if (h < 12) return 'Good morning'
  if (h < 17) return 'Good afternoon'
  return 'Good evening'
}

function firstName(full: string): string {
  return full.split(/\s+/)[0]
}

function formatFullDate(iso: string): string {
  return parseISO(iso).toLocaleDateString('en-IN', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })
}

function formatDay(iso: string): string {
  return parseISO(iso).toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric', month: 'short' })
}

/** "Tomorrow" for asOf+1, otherwise a weekday + date label. */
function relativeDay(iso: string, asOf: string): string {
  const days = Math.round((parseISO(iso).getTime() - parseISO(asOf).getTime()) / 86_400_000)
  if (days === 1) return 'Tomorrow'
  return formatDay(iso)
}

function formatTime(hms: string): string {
  const [hStr, mStr] = hms.split(':')
  let h = Number(hStr)
  const m = Number(mStr)
  const ampm = h >= 12 ? 'PM' : 'AM'
  h = h % 12 || 12
  return m === 0 ? `${h} ${ampm}` : `${h}:${mStr} ${ampm}`
}

/** A window whose end ≤ start runs past midnight (schema BR-C1); flag it with +1. */
function formatTimeRange(start: string, end: string): string {
  const overnight = end <= start
  return `${formatTime(start)} – ${formatTime(end)}${overnight ? ' +1' : ''}`
}

function daysUntilDue(balanceDueOn: string, asOf: string): number {
  return Math.round((parseISO(balanceDueOn).getTime() - parseISO(asOf).getTime()) / 86_400_000)
}

function groupBy<T, K>(items: T[], key: (t: T) => K): Map<K, T[]> {
  const map = new Map<K, T[]>()
  for (const item of items) {
    const k = key(item)
    const list = map.get(k) ?? []
    list.push(item)
    map.set(k, list)
  }
  return map
}
