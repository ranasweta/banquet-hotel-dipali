import Link from 'next/link'
import { BedDouble, LogIn, LogOut, DoorOpen, CheckCircle2, ShieldCheck, CircleCheck } from 'lucide-react'
import type { LodgeDashboard as LodgeData, RoomMovement } from '@/lib/dashboard'
import { Hero, KpiTile, SectionCard, EmptyState, formatDay } from '@/components/dashboard-shared'
import { SignoffCard } from '@/components/signoff-card'
import { cn } from '@/lib/utils'
import { titleCase } from '@/lib/text'

/**
 * Lodge Manager home: today's arrivals & departures, live occupancy for their lodge, the
 * events waiting on their rooms sign-off, and any 35+ booking awaiting the Authority.
 */
export function LodgeDashboard({ data, user }: { data: LodgeData; user: { fullName: string } }) {
  const { arrivals, departures, occupancy, awaitingSignoff, pendingRoomApprovals } = data
  const totalRooms = occupancy.reduce((s, u) => s + u.total, 0)
  const occupied = occupancy.reduce((s, u) => s + u.occupied, 0)
  // Guests, not rows: one line can be twelve rooms arriving together.
  const arrivingRooms = arrivals.reduce((s, r) => s + r.count, 0)
  const departingRooms = departures.reduce((s, r) => s + r.count, 0)
  const movement = arrivals.length + departures.length

  return (
    <div className="mx-auto max-w-6xl space-y-6">
      <Hero name={user.fullName} dateISO={data.asOf} accent={movement > 0}>
        {movement === 0 ? (
          <div className="flex items-start gap-3">
            <CircleCheck className="mt-0.5 size-6 shrink-0 text-emerald-500" aria-hidden />
            <div>
              <h1 className="text-xl font-semibold sm:text-2xl">No arrivals or departures today</h1>
              <p className="mt-1 text-sm text-muted-foreground">
                {occupied} of {totalRooms} rooms occupied.
              </p>
            </div>
          </div>
        ) : (
          <>
            <h1 className="text-2xl font-semibold sm:text-3xl">
              {arrivals.length} {arrivals.length === 1 ? 'arrival' : 'arrivals'} · {departures.length}{' '}
              {departures.length === 1 ? 'departure' : 'departures'} today
            </h1>
            <p className="mt-1 text-sm text-primary-foreground/75">
              {occupied} of {totalRooms} rooms occupied right now.
            </p>
          </>
        )}
      </Hero>

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <KpiTile icon={<LogIn className="size-5" aria-hidden />} value={arrivingRooms} label="Rooms checking in" tone={arrivingRooms ? 'emerald' : 'slate'} />
        <KpiTile icon={<LogOut className="size-5" aria-hidden />} value={departingRooms} label="Rooms checking out" tone={departingRooms ? 'amber' : 'slate'} />
        <KpiTile href="/rooms/calendar" icon={<DoorOpen className="size-5" aria-hidden />} value={`${occupied}/${totalRooms}`} label="Rooms occupied" tone="blue" />
        <KpiTile icon={<CheckCircle2 className="size-5" aria-hidden />} value={awaitingSignoff.length} label="Awaiting your sign-off" tone={awaitingSignoff.length ? 'amber' : 'emerald'} />
      </div>

      <div className="grid gap-6 lg:grid-cols-3">
        <div className="space-y-6 lg:col-span-2">
          <SectionCard
            icon={<BedDouble className="size-4 text-muted-foreground" aria-hidden />}
            title="Occupancy by property"
            note="today"
            link={{ href: '/rooms/calendar', label: 'Lodging calendar' }}
          >
            {occupancy.length === 0 ? (
              <EmptyState text="No properties configured." />
            ) : (
              <ul className="space-y-3">
                {occupancy.map((u) => {
                  const pct = u.total ? Math.round((u.occupied / u.total) * 100) : 0
                  return (
                    <li key={u.unitId}>
                      <div className="flex items-baseline justify-between text-sm">
                        <span className="font-medium">{u.name}</span>
                        <span className="tabular-nums text-muted-foreground">
                          {u.occupied}/{u.total} · <span className="text-emerald-600 dark:text-emerald-400">{u.available} free</span>
                        </span>
                      </div>
                      <div className="mt-1 h-2 overflow-hidden rounded-full bg-muted">
                        <div
                          className={cn('h-full rounded-full', pct >= 90 ? 'bg-red-500' : pct >= 60 ? 'bg-amber-500' : 'bg-emerald-500')}
                          style={{ width: `${pct}%` }}
                        />
                      </div>
                    </li>
                  )
                })}
              </ul>
            )}
          </SectionCard>

          <SignoffCard rows={awaitingSignoff} designation="lodge_manager" />
        </div>

        <div className="space-y-6">
          <SectionCard icon={<LogIn className="size-4 text-muted-foreground" aria-hidden />} title="Today's movements">
            <MovementList label="Arrivals" empty="No check-ins today." rows={arrivals} dateLabel="out" />
            <div className="my-3 border-t" />
            <MovementList label="Departures" empty="No check-outs today." rows={departures} dateLabel="in" />
          </SectionCard>

          <SectionCard
            icon={<ShieldCheck className="size-4 text-muted-foreground" aria-hidden />}
            title="Large allocations"
            note="awaiting Authority"
            badge={pendingRoomApprovals.length}
            link={{ href: '/approvals', label: 'Approvals' }}
          >
            {pendingRoomApprovals.length === 0 ? (
              <EmptyState text="No 35+ room requests in flight." />
            ) : (
              <ul className="space-y-2 text-sm">
                {pendingRoomApprovals.map((x) => (
                  <li key={x.id}>
                    <Link href="/approvals" className="block rounded-lg border border-transparent px-2 py-1.5 hover:border-border hover:bg-muted/50">
                      <span className="line-clamp-1 font-medium">{x.summary}</span>
                      <span className="text-xs text-muted-foreground">{x.eventCode} · {titleCase(x.guestName)}</span>
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

function MovementList({ label, empty, rows, dateLabel }: { label: string; empty: string; rows: RoomMovement[]; dateLabel: string }) {
  return (
    <div>
      <div className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">{label}</div>
      {rows.length === 0 ? (
        <p className="text-sm text-muted-foreground">{empty}</p>
      ) : (
        <ul className="space-y-1.5 text-sm">
          {rows.map((r) => (
            <li key={r.reqId} className="flex items-center justify-between gap-2">
              <span className="min-w-0">
                <span className="line-clamp-1 font-medium">{titleCase(r.guestName)}</span>
                {/* Category and count, not a room number — reception assigns those on the day. */}
                <span className="text-xs text-muted-foreground">
                  {r.unitName} · {r.count} × {r.roomType.replace(/_/g, ' ')}
                </span>
              </span>
              <span className="shrink-0 text-xs tabular-nums text-muted-foreground">{dateLabel} {formatDay(r.otherDate)}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
