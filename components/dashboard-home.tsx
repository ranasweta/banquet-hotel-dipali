import Link from 'next/link'
import { CalendarDays, MapPin, Users, Clock, Inbox, ClipboardCheck, Wallet, Phone, CircleCheck, TriangleAlert } from 'lucide-react'
import { formatPaise } from '@/lib/money'
import type { BookingDashboard } from '@/lib/dashboard'
import {
  Hero,
  KpiTile,
  SectionCard,
  EmptyState,
  AgendaList,
  daysUntilDue,
  formatDay,
  formatTimeRange,
  formatType,
} from '@/components/dashboard-shared'
import { cn } from '@/lib/utils'

/**
 * Booking Manager home (also shown to Higher Authority and the Auditor for now): the pipeline
 * view — today's functions, the week ahead, open enquiries, approvals, and 30-day balances.
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
  const dueNowCount = paymentsDue.filter((p) => daysUntilDue(p.balanceDueOn, data.asOf) <= 0).length
  const nextFn = upcoming[0]

  return (
    <div className="mx-auto max-w-6xl space-y-6">
      <Hero name={user.fullName} dateISO={data.asOf} accent={today.length > 0}>
        {today.length === 0 ? (
          <div className="flex items-start gap-3">
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
          <>
            <h1 className="text-2xl font-semibold sm:text-3xl">
              {today.length} {today.length === 1 ? 'event' : 'events'} today
            </h1>
            <ul className="mt-4 space-y-2">
              {today.map((fn) => (
                <li
                  key={fn.subEventId}
                  className="flex flex-wrap items-center gap-x-4 gap-y-1 rounded-lg bg-white/10 px-4 py-3 backdrop-blur-sm"
                >
                  <span className="inline-flex items-center gap-1.5 text-sm font-medium tabular-nums text-primary-foreground/90">
                    <Clock className="size-4" aria-hidden />
                    {formatTimeRange(fn.startTime, fn.endTime)}
                  </span>
                  <span className="min-w-0 flex-1 text-base font-semibold">
                    {fn.guestName}
                    <span className="ml-2 font-normal text-primary-foreground/75">{fn.name}</span>
                  </span>
                  <span className="inline-flex items-center gap-1.5 text-sm text-primary-foreground/90">
                    <MapPin className="size-4" aria-hidden />
                    {fn.venueName ?? 'Venue TBD'}
                  </span>
                  <span className="inline-flex items-center gap-1.5 text-sm text-primary-foreground/75">
                    <Users className="size-4" aria-hidden />
                    {fn.pax}
                  </span>
                </li>
              ))}
            </ul>
          </>
        )}
      </Hero>

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <KpiTile href="/calendar" icon={<CalendarDays className="size-5" aria-hidden />} value={upcoming.length} label="Functions · next 7 days" tone="blue" />
        <KpiTile href="/bookings" icon={<Inbox className="size-5" aria-hidden />} value={openEnquiries.length} label="Open enquiries" hint={staleCount ? `${staleCount} going cold` : undefined} tone={staleCount ? 'amber' : 'slate'} />
        <KpiTile href="/approvals" icon={<ClipboardCheck className="size-5" aria-hidden />} value={approvals.total} label="Awaiting approval" tone={approvals.total ? 'amber' : 'slate'} />
        <KpiTile href="/bookings" icon={<Wallet className="size-5" aria-hidden />} value={paymentsDue.length} label="Balances due · 30 days" hint={dueNowCount ? `${dueNowCount} due now` : undefined} tone={dueNowCount ? 'red' : paymentsDue.length ? 'emerald' : 'slate'} />
      </div>

      <div className="grid gap-6 lg:grid-cols-3">
        <SectionCard
          className="lg:col-span-2"
          icon={<CalendarDays className="size-4 text-muted-foreground" aria-hidden />}
          title="The week ahead"
          link={{ href: '/calendar', label: 'Calendar' }}
        >
          <AgendaList functions={upcoming} asOf={data.asOf} empty="No functions scheduled in the next seven days." />
        </SectionCard>

        <div className="space-y-6">
          <SectionCard
            icon={<ClipboardCheck className="size-4 text-muted-foreground" aria-hidden />}
            title="Awaiting approval"
            badge={approvals.total}
            link={{ href: '/approvals', label: 'Queue' }}
          >
            {approvals.total === 0 ? (
              <EmptyState text="Nothing waiting on a decision." />
            ) : (
              <ul className="space-y-2 text-sm">
                {approvals.exceptions.map((x) => (
                  <li key={x.id}>
                    <Link href="/approvals" className="block rounded-lg border border-transparent px-2 py-1.5 hover:border-border hover:bg-muted/50">
                      <span className="line-clamp-1 font-medium">{x.summary}</span>
                      <span className="text-xs text-muted-foreground">{x.eventCode} · {x.guestName} · {x.raisedByName}</span>
                    </Link>
                  </li>
                ))}
                {approvals.changeRequests.map((cr) => (
                  <li key={cr.id}>
                    <Link href="/change-requests" className="block rounded-lg border border-transparent px-2 py-1.5 hover:border-border hover:bg-muted/50">
                      <span className="line-clamp-1 font-medium">Change: {cr.summary}</span>
                      <span className="text-xs text-muted-foreground">{cr.eventCode} · {cr.guestName} · {cr.requestedByName}</span>
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </SectionCard>

          <SectionCard icon={<Wallet className="size-4 text-muted-foreground" aria-hidden />} title="Balances due · 30 days">
            {paymentsDue.length === 0 ? (
              <EmptyState text="No balances fall inside the 30-day window." />
            ) : (
              <ul className="space-y-2 text-sm">
                {paymentsDue.map((p) => {
                  const dueIn = daysUntilDue(p.balanceDueOn, data.asOf)
                  const overdue = dueIn <= 0
                  return (
                    <li key={p.eventId}>
                      <Link href={`/bookings/${p.eventId}`} className="flex items-center justify-between gap-2 rounded-lg border border-transparent px-2 py-1.5 hover:border-border hover:bg-muted/50">
                        <span className="min-w-0">
                          <span className="line-clamp-1 font-medium">{p.guestName}</span>
                          <span className="text-xs text-muted-foreground">{p.code} · event {formatDay(p.eventDate)}</span>
                        </span>
                        <span className="shrink-0 text-right">
                          <span className="block font-semibold tabular-nums">{formatPaise(p.outstandingPaise)}</span>
                          <span className={cn('text-xs font-medium', overdue ? 'text-red-600 dark:text-red-400' : 'text-amber-600 dark:text-amber-400')}>
                            {overdue ? 'due now' : `due in ${dueIn}d`}
                          </span>
                        </span>
                      </Link>
                    </li>
                  )
                })}
              </ul>
            )}
          </SectionCard>
        </div>
      </div>

      <SectionCard
        icon={<Inbox className="size-4 text-muted-foreground" aria-hidden />}
        title="Open enquiries"
        note="still to be locked in"
        link={{ href: '/bookings', label: 'All bookings' }}
      >
        {openEnquiries.length === 0 ? (
          <EmptyState text="No open enquiries — the pipeline is clear." />
        ) : (
          <ul className="divide-y">
            {openEnquiries.map((e) => (
              <li key={e.id}>
                <Link href={`/bookings/${e.id}`} className="flex flex-wrap items-center gap-x-4 gap-y-1 px-1 py-2.5 hover:bg-muted/50">
                  <span className="font-medium tabular-nums text-primary">{e.code}</span>
                  <span className="min-w-0 flex-1 truncate font-medium">{e.guestName}</span>
                  <span className="text-xs capitalize text-muted-foreground">{formatType(e.eventType)}</span>
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
      </SectionCard>

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
