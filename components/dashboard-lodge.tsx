import Link from 'next/link'
import { BedDouble, LogIn, LogOut, DoorOpen, ClipboardList, ShieldCheck, CircleCheck } from 'lucide-react'
import type { LodgeDashboard as LodgeData, RoomMovement } from '@/lib/dashboard'
import { Hero, KpiTile, SectionCard, EmptyState, formatDay } from '@/components/dashboard-shared'
import { cn } from '@/lib/utils'

/**
 * Lodge Manager home: today's arrivals & departures, live occupancy per property, events whose
 * promised rooms aren't fully allocated (FR-4.5), and any 35+ allocation awaiting the Authority.
 */
export function LodgeDashboard({ data, user }: { data: LodgeData; user: { fullName: string } }) {
  const { arrivals, departures, occupancy, awaitingAllocation, pendingRoomApprovals } = data
  const totalRooms = occupancy.reduce((s, u) => s + u.total, 0)
  const occupied = occupancy.reduce((s, u) => s + u.occupied, 0)
  const toAllocate = awaitingAllocation.reduce((s, e) => s + e.shortfall, 0)
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
                {occupied} of {totalRooms} rooms occupied across all properties.
              </p>
            </div>
          </div>
        ) : (
          <>
            <h1 className="text-2xl font-semibold sm:text-3xl">
              {arrivals.length} {arrivals.length === 1 ? 'arrival' : 'arrivals'} · {departures.length}{' '}
              {departures.length === 1 ? 'departure' : 'departures'} today
            </h1>
            <p className="mt-1 text-sm text-blue-100">
              {occupied} of {totalRooms} rooms occupied right now.
            </p>
          </>
        )}
      </Hero>

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <KpiTile icon={<LogIn className="size-5" aria-hidden />} value={arrivals.length} label="Check-ins today" tone={arrivals.length ? 'emerald' : 'slate'} />
        <KpiTile icon={<LogOut className="size-5" aria-hidden />} value={departures.length} label="Check-outs today" tone={departures.length ? 'amber' : 'slate'} />
        <KpiTile href="/rooms" icon={<DoorOpen className="size-5" aria-hidden />} value={`${occupied}/${totalRooms}`} label="Rooms occupied" tone="blue" />
        <KpiTile href="/rooms" icon={<ClipboardList className="size-5" aria-hidden />} value={toAllocate} label="Rooms to allocate" tone={toAllocate ? 'amber' : 'emerald'} />
      </div>

      <div className="grid gap-6 lg:grid-cols-3">
        <div className="space-y-6 lg:col-span-2">
          <SectionCard
            icon={<BedDouble className="size-4 text-muted-foreground" aria-hidden />}
            title="Occupancy by property"
            note="today"
            link={{ href: '/rooms', label: 'Rooms board' }}
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
                          className={cn('h-full rounded-full', pct >= 90 ? 'bg-red-500' : pct >= 60 ? 'bg-amber-500' : 'bg-blue-500')}
                          style={{ width: `${pct}%` }}
                        />
                      </div>
                    </li>
                  )
                })}
              </ul>
            )}
          </SectionCard>

          <SectionCard
            icon={<ClipboardList className="size-4 text-muted-foreground" aria-hidden />}
            title="Rooms to allocate"
            note="promised, not yet assigned"
          >
            {awaitingAllocation.length === 0 ? (
              <EmptyState text="Every event's promised rooms are allocated." />
            ) : (
              <ul className="space-y-2 text-sm">
                {awaitingAllocation.map((e) => (
                  <li key={e.eventId}>
                    <Link href={`/bookings/${e.eventId}`} className="flex items-center justify-between gap-2 rounded-lg border border-transparent px-2 py-1.5 hover:border-border hover:bg-muted/50">
                      <span className="min-w-0">
                        <span className="line-clamp-1 font-medium">{e.guestName}</span>
                        <span className="text-xs text-muted-foreground">
                          {e.code}{e.firstDate ? ` · ${formatDay(e.firstDate)}` : ''}
                        </span>
                      </span>
                      <span className="shrink-0 text-right">
                        <span className="block font-semibold tabular-nums text-amber-700 dark:text-amber-300">{e.shortfall} to go</span>
                        <span className="text-xs tabular-nums text-muted-foreground">{e.allocated}/{e.promised} allocated</span>
                      </span>
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </SectionCard>
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
                      <span className="text-xs text-muted-foreground">{x.eventCode} · {x.guestName}</span>
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
            <li key={r.allocId} className="flex items-center justify-between gap-2">
              <span className="min-w-0">
                <span className="line-clamp-1 font-medium">{r.guestName}</span>
                <span className="text-xs text-muted-foreground">{r.unitName} · Room {r.roomNo}</span>
              </span>
              <span className="shrink-0 text-xs tabular-nums text-muted-foreground">{dateLabel} {formatDay(r.otherDate)}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
