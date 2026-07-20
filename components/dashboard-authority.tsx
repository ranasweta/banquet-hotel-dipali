import Link from 'next/link'
import { ClipboardCheck, Wallet, TrendingUp, CalendarDays, CircleCheck } from 'lucide-react'
import { formatPaise } from '@/lib/money'
import type { AuthorityDashboard as AuthorityData } from '@/lib/dashboard'
import {
  Hero,
  KpiTile,
  SectionCard,
  EmptyState,
  AgendaList,
  daysUntilDue,
  formatDay,
  formatType,
} from '@/components/dashboard-shared'
import { cn } from '@/lib/utils'

/**
 * Higher Authority home: the oversight board. What is waiting on their decision, what money is
 * at risk, and where the biggest exposure sits — rather than the Booking Manager's pipeline,
 * which they can only read.
 */
export function AuthorityDashboard({ data, user }: { data: AuthorityData; user: { fullName: string } }) {
  const { exceptions, byKind, paymentsDue, highValue, upcoming } = data
  const overdue = paymentsDue.filter((p) => daysUntilDue(p.balanceDueOn, data.asOf) <= 0)
  const atRiskPaise = paymentsDue.reduce((s, p) => s + p.outstandingPaise, 0)

  return (
    <div className="mx-auto max-w-6xl space-y-6">
      <Hero name={user.fullName} dateISO={data.asOf} accent={exceptions.length > 0}>
        {exceptions.length === 0 ? (
          <div className="flex items-start gap-3">
            <CircleCheck className="mt-0.5 size-6 shrink-0 text-emerald-500" aria-hidden />
            <div>
              <h1 className="text-xl font-semibold sm:text-2xl">Nothing waiting on you</h1>
              <p className="mt-1 text-sm text-muted-foreground">
                No exceptions to decide. {overdue.length > 0 && `${overdue.length} balance${overdue.length === 1 ? '' : 's'} still overdue.`}
              </p>
            </div>
          </div>
        ) : (
          <>
            <h1 className="text-2xl font-semibold sm:text-3xl">
              {exceptions.length} {exceptions.length === 1 ? 'decision' : 'decisions'} waiting
            </h1>
            <p className="mt-1 text-sm text-blue-100">
              {byKind.map((k) => `${k.n} ${formatType(k.kind)}`).join(' · ')}
            </p>
          </>
        )}
      </Hero>

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <KpiTile href="/approvals" icon={<ClipboardCheck className="size-5" aria-hidden />} value={exceptions.length} label="Awaiting your decision" tone={exceptions.length ? 'amber' : 'slate'} />
        <KpiTile icon={<Wallet className="size-5" aria-hidden />} value={formatPaise(atRiskPaise)} label="Outstanding · 30 days" tone={atRiskPaise ? 'red' : 'slate'} />
        <KpiTile icon={<Wallet className="size-5" aria-hidden />} value={overdue.length} label="Balances overdue" tone={overdue.length ? 'red' : 'emerald'} />
        <KpiTile href="/day-sheet" icon={<CalendarDays className="size-5" aria-hidden />} value={upcoming.length} label="Functions · next 7 days" tone="blue" />
      </div>

      <div className="grid gap-6 lg:grid-cols-3">
        <div className="space-y-6 lg:col-span-2">
          <SectionCard
            icon={<ClipboardCheck className="size-4 text-muted-foreground" aria-hidden />}
            title="Awaiting your decision"
            badge={exceptions.length}
            link={{ href: '/approvals', label: 'Approvals' }}
          >
            {exceptions.length === 0 ? (
              <EmptyState text="Nothing to decide right now." />
            ) : (
              <ul className="divide-y text-sm">
                {exceptions.map((x) => (
                  <li key={x.id}>
                    <Link href="/approvals" className="flex items-center justify-between gap-3 px-1 py-2 hover:bg-muted/50">
                      <span className="min-w-0">
                        <span className="line-clamp-1 font-medium">{x.summary}</span>
                        <span className="text-xs text-muted-foreground">
                          {x.eventCode} · {x.guestName} · raised by {x.raisedByName}
                        </span>
                      </span>
                      <span className="shrink-0 rounded-full bg-muted px-2 py-0.5 text-xs capitalize text-muted-foreground">
                        {formatType(x.kind)}
                      </span>
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </SectionCard>

          <SectionCard icon={<CalendarDays className="size-4 text-muted-foreground" aria-hidden />} title="The week ahead" link={{ href: '/calendar', label: 'Calendar' }}>
            <AgendaList functions={upcoming} asOf={data.asOf} empty="No functions in the next seven days." />
          </SectionCard>
        </div>

        <div className="space-y-6">
          <SectionCard icon={<Wallet className="size-4 text-muted-foreground" aria-hidden />} title="Money at risk" note="30-day window">
            {paymentsDue.length === 0 ? (
              <EmptyState text="No balances inside the window." />
            ) : (
              <ul className="space-y-2 text-sm">
                {paymentsDue.map((p) => {
                  const dueIn = daysUntilDue(p.balanceDueOn, data.asOf)
                  return (
                    <li key={p.eventId}>
                      <Link href={`/bookings/${p.eventId}`} className="flex items-center justify-between gap-2 rounded-lg border border-transparent px-2 py-1.5 hover:border-border hover:bg-muted/50">
                        <span className="min-w-0">
                          <span className="line-clamp-1 font-medium">{p.guestName}</span>
                          <span className="text-xs text-muted-foreground">{p.code} · {formatDay(p.eventDate)}</span>
                        </span>
                        <span className="shrink-0 text-right">
                          <span className="block font-semibold tabular-nums">{formatPaise(p.outstandingPaise)}</span>
                          <span className={cn('text-xs font-medium', dueIn <= 0 ? 'text-red-600 dark:text-red-400' : 'text-amber-600 dark:text-amber-400')}>
                            {dueIn <= 0 ? 'overdue' : `due in ${dueIn}d`}
                          </span>
                        </span>
                      </Link>
                    </li>
                  )
                })}
              </ul>
            )}
          </SectionCard>

          <SectionCard icon={<TrendingUp className="size-4 text-muted-foreground" aria-hidden />} title="Biggest upcoming">
            {highValue.length === 0 ? (
              <EmptyState text="No confirmed events yet." />
            ) : (
              <ul className="space-y-2 text-sm">
                {highValue.map((e) => (
                  <li key={e.id}>
                    <Link href={`/bookings/${e.id}`} className="flex items-center justify-between gap-2 rounded-lg border border-transparent px-2 py-1.5 hover:border-border hover:bg-muted/50">
                      <span className="min-w-0">
                        <span className="line-clamp-1 font-medium">{e.guestName}</span>
                        <span className="text-xs capitalize text-muted-foreground">
                          {e.code} · {formatType(e.eventType)}{e.firstDate ? ` · ${formatDay(e.firstDate)}` : ''}
                        </span>
                      </span>
                      <span className="shrink-0 font-semibold tabular-nums">{formatPaise(e.proposalTotalPaise)}</span>
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </SectionCard>
        </div>
      </div>
    </div>
  )
}
