import { Wrench, Activity, Lock, IndianRupee, ListChecks, CircleCheck } from 'lucide-react'
import type { MaintenanceDashboard as MaintenanceData, MaintenanceEventRow } from '@/lib/dashboard'
import { formatPaise } from '@/lib/money'
import { Hero, KpiTile, SectionCard, EmptyState, StatusPill, formatDay } from '@/components/dashboard-shared'

/**
 * Maintenance home: the team's work board. Events it may log against — In Progress or Completed
 * (FR-5.1) — with each one's running total and whether the section is closed. "Awaiting close"
 * is the gate before an event can be locked (FR-5.2). Rows are informational — the team logs
 * entries through the event, not from here.
 */
export function MaintenanceDashboard({ data, user }: { data: MaintenanceData; user: { fullName: string } }) {
  const { events } = data
  const inProgress = events.filter((e) => e.status === 'in_progress')
  const awaitingClose = events.filter((e) => e.status === 'completed' && !e.closed)
  const openValue = events.filter((e) => !e.closed).reduce((s, e) => s + e.totalPaise, 0)
  const entries = events.reduce((s, e) => s + e.entryCount, 0)

  return (
    <div className="mx-auto max-w-6xl space-y-6">
      <Hero name={user.fullName} dateISO={data.asOf} accent={inProgress.length > 0}>
        {inProgress.length === 0 ? (
          <div className="flex items-start gap-3">
            <CircleCheck className="mt-0.5 size-6 shrink-0 text-emerald-500" aria-hidden />
            <div>
              <h1 className="text-xl font-semibold sm:text-2xl">No events in progress</h1>
              <p className="mt-1 text-sm text-muted-foreground">
                {awaitingClose.length
                  ? `${awaitingClose.length} completed ${awaitingClose.length === 1 ? 'event' : 'events'} still need maintenance closed.`
                  : 'Nothing needs maintenance logging right now.'}
              </p>
            </div>
          </div>
        ) : (
          <>
            <h1 className="text-2xl font-semibold sm:text-3xl">
              {inProgress.length} {inProgress.length === 1 ? 'event' : 'events'} in progress
            </h1>
            <p className="mt-1 text-sm text-primary-foreground/75">Log extra costs while each event is live.</p>
          </>
        )}
      </Hero>

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <KpiTile href="/maintenance" icon={<Activity className="size-5" aria-hidden />} value={inProgress.length} label="Events in progress" tone={inProgress.length ? 'emerald' : 'slate'} />
        <KpiTile href="/maintenance" icon={<Lock className="size-5" aria-hidden />} value={awaitingClose.length} label="Awaiting close" tone={awaitingClose.length ? 'amber' : 'slate'} />
        <KpiTile href="/maintenance" icon={<IndianRupee className="size-5" aria-hidden />} value={formatPaise(openValue)} label="Open (un-closed) value" tone={openValue ? 'blue' : 'slate'} />
        <KpiTile href="/maintenance" icon={<ListChecks className="size-5" aria-hidden />} value={entries} label="Entries logged" tone="slate" />
      </div>

      <div className="grid gap-6 lg:grid-cols-3">
        <SectionCard
          className="lg:col-span-2"
          icon={<Wrench className="size-4 text-muted-foreground" aria-hidden />}
          title="Events to service"
          note="in progress & completed"
          link={{ href: '/maintenance', label: 'Log charges' }}
        >
          {events.length === 0 ? (
            <EmptyState text="No events are live — maintenance can be logged once an event starts." />
          ) : (
            <ul className="divide-y">
              {events.map((e) => (
                <EventRow key={e.id} e={e} />
              ))}
            </ul>
          )}
        </SectionCard>

        <SectionCard
          icon={<Lock className="size-4 text-muted-foreground" aria-hidden />}
          title="Awaiting close"
          badge={awaitingClose.length}
        >
          {awaitingClose.length === 0 ? (
            <EmptyState text="Nothing waiting to be closed." />
          ) : (
            <ul className="space-y-2 text-sm">
              {awaitingClose.map((e) => (
                <li key={e.id} className="flex items-center justify-between gap-2">
                  <span className="min-w-0">
                    <span className="line-clamp-1 font-medium">{e.guestName}</span>
                    <span className="text-xs text-muted-foreground">
                      {e.code}{e.firstDate ? ` · ${formatDay(e.firstDate)}` : ''}
                    </span>
                  </span>
                  <span className="shrink-0 text-right">
                    <span className="block font-semibold tabular-nums">{formatPaise(e.totalPaise)}</span>
                    <span className="text-xs text-muted-foreground">{e.entryCount} {e.entryCount === 1 ? 'entry' : 'entries'}</span>
                  </span>
                </li>
              ))}
            </ul>
          )}
        </SectionCard>
      </div>
    </div>
  )
}

function EventRow({ e }: { e: MaintenanceEventRow }) {
  return (
    <li className="flex flex-wrap items-center gap-x-4 gap-y-1 px-1 py-2.5">
      <span className="font-medium tabular-nums">{e.code}</span>
      <span className="min-w-0 flex-1 truncate font-medium">{e.guestName}</span>
      <StatusPill status={e.status} />
      <span className="text-xs tabular-nums text-muted-foreground">
        {e.entryCount} {e.entryCount === 1 ? 'entry' : 'entries'}
      </span>
      <span className="w-24 shrink-0 text-right font-semibold tabular-nums">{formatPaise(e.totalPaise)}</span>
      <span
        className={
          e.closed
            ? 'shrink-0 rounded-full bg-muted px-2 py-0.5 text-xs font-medium text-muted-foreground'
            : 'shrink-0 rounded-full bg-emerald-100 px-2 py-0.5 text-xs font-medium text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300'
        }
      >
        {e.closed ? 'closed' : 'open'}
      </span>
    </li>
  )
}
