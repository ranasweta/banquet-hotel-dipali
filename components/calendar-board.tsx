'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { ChevronLeft, ChevronRight, Info } from 'lucide-react'
import { toast } from 'sonner'
import { api } from '@/lib/http'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'

type Venue = { id: string; name: string; kind: string; propertyName: string }
type Booking = {
  venueId: string
  eventId: string
  eventCode: string
  guestName: string
  eventType: string
  subEventId: string
  subEventName: string
  status: string
  starts: string // 'YYYY-MM-DDTHH:MM'
  ends: string
}
type CalendarResponse = {
  from: string
  to: string
  capped: boolean
  windowDays: number
  venues: Venue[]
  bookings: Booking[]
}

// Status color system (FR-2.5). Color is never the only signal — each chip also carries
// a text time and, for carryover, a "↳" glyph. Tuned for light and dark.
const STATUS_STYLES: Record<string, string> = {
  confirmed:
    'bg-blue-50 text-blue-800 ring-blue-200 dark:bg-blue-950/60 dark:text-blue-200 dark:ring-blue-900',
  in_progress:
    'bg-emerald-50 text-emerald-800 ring-emerald-200 dark:bg-emerald-950/60 dark:text-emerald-200 dark:ring-emerald-900',
  completed:
    'bg-slate-100 text-slate-700 ring-slate-200 dark:bg-slate-800/60 dark:text-slate-300 dark:ring-slate-700',
  locked:
    'bg-violet-50 text-violet-800 ring-violet-200 dark:bg-violet-950/60 dark:text-violet-200 dark:ring-violet-900',
  billed:
    'bg-violet-50 text-violet-800 ring-violet-200 dark:bg-violet-950/60 dark:text-violet-200 dark:ring-violet-900',
  closed:
    'bg-slate-100 text-slate-600 ring-slate-200 dark:bg-slate-800/60 dark:text-slate-400 dark:ring-slate-700',
}
const CARRYOVER_STYLE =
  'bg-amber-50 text-amber-800 ring-amber-200 dark:bg-amber-950/50 dark:text-amber-200 dark:ring-amber-900'

type Chip = {
  key: string
  booking: Booking
  label: string // time text
  carryover: boolean
}

function dateOnly(iso: string): string {
  return iso.slice(0, 10)
}
function timeOnly(iso: string): string {
  return iso.slice(11, 16)
}
function nextDay(date: string): string {
  const [y, m, d] = date.split('-').map(Number)
  return new Date(Date.UTC(y, m - 1, d + 1)).toISOString().slice(0, 10)
}
function eachDay(from: string, to: string): string[] {
  const days: string[] = []
  let d = from
  // Guard against an unbounded loop; the window is at most a few weeks.
  for (let i = 0; i < 120 && d <= to; i++) {
    days.push(d)
    d = nextDay(d)
  }
  return days
}

function formatDayHeader(date: string): { weekday: string; day: string; month: string } {
  const [y, m, d] = date.split('-').map(Number)
  const dt = new Date(Date.UTC(y, m - 1, d))
  return {
    weekday: dt.toLocaleDateString('en-US', { weekday: 'short', timeZone: 'UTC' }),
    day: String(d),
    month: dt.toLocaleDateString('en-US', { month: 'short', timeZone: 'UTC' }),
  }
}
function titleCase(s: string): string {
  return s.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())
}

export function CalendarBoard() {
  const [data, setData] = useState<CalendarResponse | null>(null)
  const [range, setRange] = useState<{ from?: string; to?: string }>({})
  const [loading, setLoading] = useState(true)
  const today = new Date().toLocaleDateString('en-CA')

  const load = useCallback(async (from?: string, to?: string) => {
    setLoading(true)
    try {
      const qs = from && to ? `?from=${from}&to=${to}` : ''
      const res = await api<CalendarResponse>(`/calendar${qs}`)
      setData(res)
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed to load the calendar')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    // Fetch on mount and whenever the range changes; state is set in load's async body.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    load(range.from, range.to)
  }, [load, range])

  const shift = (dir: 1 | -1) => {
    if (!data) return
    const days = data.windowDays
    const move = (date: string, n: number) => {
      let d = date
      const step = n < 0 ? -1 : 1
      for (let i = 0; i < Math.abs(n); i++) {
        const [y, mo, da] = d.split('-').map(Number)
        d = new Date(Date.UTC(y, mo - 1, da + step)).toISOString().slice(0, 10)
      }
      return d
    }
    setRange({ from: move(data.from, dir * days), to: move(data.to, dir * days) })
  }

  const days = useMemo(() => (data ? eachDay(data.from, data.to) : []), [data])

  // cell[venueId][date] = chips. A cross-midnight booking appears on its start day (main)
  // and, as a carryover tail, on the following morning.
  const cells = useMemo(() => {
    const map = new Map<string, Chip[]>()
    const push = (venueId: string, date: string, chip: Chip) => {
      const k = `${venueId}|${date}`
      const list = map.get(k) ?? []
      list.push(chip)
      map.set(k, list)
    }
    if (!data) return map
    for (const b of data.bookings) {
      const startDate = dateOnly(b.starts)
      const endDate = dateOnly(b.ends)
      const crosses = endDate > startDate
      // Key on the sub-event id (not the event id): one event can hold several sub-events
      // on the same venue and day — the exact same-day double-booking the model allows.
      push(b.venueId, startDate, {
        key: `${b.subEventId}-${b.venueId}-main`,
        booking: b,
        label: crosses ? `${timeOnly(b.starts)}→` : `${timeOnly(b.starts)}–${timeOnly(b.ends)}`,
        carryover: false,
      })
      if (crosses) {
        push(b.venueId, endDate, {
          key: `${b.subEventId}-${b.venueId}-tail`,
          booking: b,
          label: `↳ till ${timeOnly(b.ends)}`,
          carryover: true,
        })
      }
    }
    return map
  }, [data])

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <div className="flex items-center gap-1">
          <Button
            variant="outline"
            size="icon"
            onClick={() => shift(-1)}
            disabled={loading || data?.capped}
            aria-label="Previous window"
          >
            <ChevronLeft className="size-4" />
          </Button>
          <Button
            variant="outline"
            size="icon"
            onClick={() => shift(1)}
            disabled={loading || data?.capped}
            aria-label="Next window"
          >
            <ChevronRight className="size-4" />
          </Button>
        </div>
        {data && (
          <span className="text-sm font-medium tabular-nums">
            {formatRange(data.from, data.to)}
          </span>
        )}
        <Legend />
      </div>

      {data?.capped && (
        <p className="flex items-center gap-2 rounded-md border bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
          <Info className="size-3.5 shrink-0" />
          Your role sees the rolling {data.windowDays}-day operational window. Auditor and
          Higher Authority can open any date range.
        </p>
      )}

      <div className="overflow-x-auto rounded-lg border bg-card">
        <table className="w-max min-w-full border-separate border-spacing-0 text-sm">
          <thead>
            <tr>
              <th className="sticky left-0 z-20 w-52 border-b border-r bg-muted/50 px-3 py-2 text-left font-medium backdrop-blur">
                Venue
              </th>
              {days.map((date) => {
                const h = formatDayHeader(date)
                const isToday = date === today
                return (
                  <th
                    key={date}
                    className={cn(
                      'min-w-[132px] border-b border-r px-2 py-1.5 text-center font-medium last:border-r-0',
                      isToday ? 'bg-primary/10' : 'bg-muted/30',
                    )}
                  >
                    <div className="text-[11px] uppercase tracking-wide text-muted-foreground">
                      {h.weekday}
                    </div>
                    <div className="flex items-baseline justify-center gap-1">
                      <span className={cn('text-base tabular-nums', isToday && 'text-primary')}>
                        {h.day}
                      </span>
                      <span className="text-[11px] text-muted-foreground">{h.month}</span>
                    </div>
                  </th>
                )
              })}
            </tr>
          </thead>
          <tbody>
            {(data?.venues ?? []).map((venue, i) => {
              const prev = data!.venues[i - 1]
              const newGroup = !prev || prev.propertyName !== venue.propertyName
              return (
                <tr key={venue.id} className="group">
                  <th
                    scope="row"
                    className={cn(
                      'sticky left-0 z-10 border-b border-r bg-card px-3 py-2 text-left align-top font-normal',
                      newGroup && 'border-t-2 border-t-border',
                    )}
                  >
                    <div className="font-medium leading-tight">{venue.name}</div>
                    <div className="text-[11px] text-muted-foreground">
                      {venue.propertyName} · {venue.kind}
                    </div>
                  </th>
                  {days.map((date) => {
                    const chips = cells.get(`${venue.id}|${date}`) ?? []
                    const isToday = date === today
                    return (
                      <td
                        key={date}
                        className={cn(
                          'h-16 min-w-[132px] border-b border-r p-1 align-top last:border-r-0',
                          newGroup && 'border-t-2 border-t-border',
                          isToday && 'bg-primary/5',
                        )}
                      >
                        <div className="flex flex-col gap-1">
                          {chips.map((chip) => (
                            <BookingChip key={chip.key} chip={chip} />
                          ))}
                        </div>
                      </td>
                    )
                  })}
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>

      {loading && <p className="text-sm text-muted-foreground">Loading…</p>}
      {!loading && data && data.bookings.length === 0 && (
        <p className="rounded-md border border-dashed p-6 text-center text-sm text-muted-foreground">
          No confirmed bookings in this window. Enquiries don&apos;t appear here — the board
          shows locked-in deals only.
        </p>
      )}
    </div>
  )
}

function BookingChip({ chip }: { chip: Chip }) {
  const { booking, label, carryover } = chip
  const style = carryover ? CARRYOVER_STYLE : (STATUS_STYLES[booking.status] ?? STATUS_STYLES.confirmed)
  return (
    <div
      className={cn('rounded-md px-1.5 py-1 text-left ring-1 ring-inset', style)}
      title={`${booking.guestName} — ${titleCase(booking.subEventName)} (${booking.eventCode}, ${titleCase(booking.status)})`}
    >
      <div className="truncate text-[11px] font-medium leading-tight">{booking.guestName}</div>
      <div className="truncate text-[10px] leading-tight opacity-90 tabular-nums">{label}</div>
    </div>
  )
}

function Legend() {
  const items: { label: string; className: string }[] = [
    { label: 'Confirmed', className: STATUS_STYLES.confirmed },
    { label: 'In progress', className: STATUS_STYLES.in_progress },
    { label: 'Carryover', className: CARRYOVER_STYLE },
  ]
  return (
    <div className="ml-auto flex flex-wrap items-center gap-3">
      {items.map((it) => (
        <span key={it.label} className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <span className={cn('size-3 rounded-sm ring-1 ring-inset', it.className)} />
          {it.label}
        </span>
      ))}
    </div>
  )
}

function formatRange(from: string, to: string): string {
  const fmt = (d: string) => {
    const [y, m, day] = d.split('-').map(Number)
    return new Date(Date.UTC(y, m - 1, day)).toLocaleDateString('en-US', {
      day: 'numeric',
      month: 'short',
      year: 'numeric',
      timeZone: 'UTC',
    })
  }
  return `${fmt(from)} – ${fmt(to)}`
}
