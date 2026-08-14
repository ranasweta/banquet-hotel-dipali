import { UtensilsCrossed, Activity, Lock, IndianRupee, CircleCheck } from 'lucide-react'
import type { UtensilDashboard as UtensilData, UtensilEventRow } from '@/lib/dashboard'
import { formatPaise } from '@/lib/money'
import { Hero, KpiTile, SectionCard, EmptyState, StatusPill, formatDay } from '@/components/dashboard-shared'
import { titleCase } from '@/lib/text'

/**
 * The Utensil Manager's home (client, 15 Aug 2026). Events he may log plates against — In
 * Progress or Completed, the window Maintenance works in — with each one's plate count, what it
 * comes to and whether the log is closed.
 *
 * "Open (un-closed) value" is the figure worth looking at: until he closes a log, none of it is
 * on anybody's bill.
 */
export function UtensilDashboard({ data, user }: { data: UtensilData; user: { fullName: string } }) {
  const { events } = data
  const inProgress = events.filter((e) => e.status === 'in_progress')
  const awaitingClose = events.filter((e) => e.status === 'completed' && !e.closed)
  const openValue = events.filter((e) => !e.closed).reduce((s, e) => s + e.totalPaise, 0)
  const plates = events.reduce((s, e) => s + e.plates, 0)

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
                  ? `${awaitingClose.length} completed ${awaitingClose.length === 1 ? 'event' : 'events'} still need their plates closed.`
                  : 'Nothing needs plates logging right now.'}
              </p>
            </div>
          </div>
        ) : (
          <>
            <h1 className="text-2xl font-semibold sm:text-3xl">
              {inProgress.length} {inProgress.length === 1 ? 'event' : 'events'} in progress
            </h1>
            <p className="mt-1 text-sm text-primary-foreground/75">
              Log extra plates as they go out — every entry needs a photo.
            </p>
          </>
        )}
      </Hero>

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <KpiTile href="/extra-plates" icon={<Activity className="size-5" aria-hidden />} value={inProgress.length} label="Events in progress" tone={inProgress.length ? 'emerald' : 'slate'} />
        <KpiTile href="/extra-plates" icon={<Lock className="size-5" aria-hidden />} value={awaitingClose.length} label="Awaiting close" tone={awaitingClose.length ? 'amber' : 'slate'} />
        <KpiTile href="/extra-plates" icon={<IndianRupee className="size-5" aria-hidden />} value={formatPaise(openValue)} label="Open (un-closed) value" tone={openValue ? 'blue' : 'slate'} />
        <KpiTile href="/extra-plates" icon={<UtensilsCrossed className="size-5" aria-hidden />} value={plates} label="Plates logged" tone="slate" />
      </div>

      <div className="grid gap-6 lg:grid-cols-3">
        <SectionCard
          className="lg:col-span-2"
          icon={<UtensilsCrossed className="size-4 text-muted-foreground" aria-hidden />}
          title="Events to serve"
          note="in progress & completed"
          link={{ href: '/extra-plates', label: 'Log plates' }}
        >
          {events.length === 0 ? (
            <EmptyState text="No events are live — plates can be logged once an event starts." />
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
                    <span className="line-clamp-1 font-medium">{titleCase(e.guestName)}</span>
                    <span className="text-xs text-muted-foreground">
                      {e.code}{e.firstDate ? ` · ${formatDay(e.firstDate)}` : ''}
                    </span>
                  </span>
                  <span className="shrink-0 text-right">
                    <span className="block font-semibold tabular-nums">{formatPaise(e.totalPaise)}</span>
                    <span className="text-xs text-muted-foreground">{e.plates} {e.plates === 1 ? 'plate' : 'plates'}</span>
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

function EventRow({ e }: { e: UtensilEventRow }) {
  return (
    <li className="flex flex-wrap items-center gap-x-4 gap-y-1 px-1 py-2.5">
      <span className="font-medium tabular-nums">{e.code}</span>
      <span className="min-w-0 flex-1 truncate font-medium">{titleCase(e.guestName)}</span>
      <StatusPill status={e.status} />
      <span className="text-xs tabular-nums text-muted-foreground">
        {e.plates} {e.plates === 1 ? 'plate' : 'plates'}
      </span>
      <span className="font-semibold tabular-nums">{formatPaise(e.totalPaise)}</span>
      {e.closed && <span className="text-xs text-muted-foreground">closed</span>}
    </li>
  )
}
