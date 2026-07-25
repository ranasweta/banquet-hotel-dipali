'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { ChevronLeft, ChevronRight, Info } from 'lucide-react'
import { toast } from 'sonner'
import { api } from '@/lib/http'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'

type Inventory = { unitId: string; unitName: string; roomType: string; total: number }
type Cell = {
  date: string
  unitId: string
  roomType: string
  locked: number
  confirmed: number
  pending: number
}
type CalendarResponse = {
  from: string
  to: string
  windowDays: number
  inventory: Inventory[]
  occupancy: Cell[]
}
type Holder = {
  unitId: string
  roomType: string
  eventId: string
  code: string
  guestName: string
  status: string
  state: 'locked' | 'confirmed' | 'pending'
  count: number
}
type DayResponse = { date: string; inventory: Inventory[]; holders: Holder[] }

const ALL_UNITS = '__all__'

// Colour is never the only signal: every cell carries its booked/total numbers, and the
// day detail spells the same figures out in a table.
const STATE_STYLE = {
  locked: 'bg-rose-500 dark:bg-rose-600',
  confirmed: 'bg-amber-400 dark:bg-amber-500',
  vacant: 'bg-emerald-500 dark:bg-emerald-600',
} as const
const STATE_CHIP = {
  locked:
    'bg-rose-50 text-rose-800 ring-rose-200 dark:bg-rose-950/60 dark:text-rose-200 dark:ring-rose-900',
  confirmed:
    'bg-amber-50 text-amber-800 ring-amber-200 dark:bg-amber-950/60 dark:text-amber-200 dark:ring-amber-900',
  pending:
    'bg-amber-50 text-amber-800 ring-amber-200 dark:bg-amber-950/60 dark:text-amber-200 dark:ring-amber-900',
} as const

function nextDay(date: string): string {
  const [y, m, d] = date.split('-').map(Number)
  return new Date(Date.UTC(y, m - 1, d + 1)).toISOString().slice(0, 10)
}
function eachDay(from: string, to: string): string[] {
  const days: string[] = []
  let d = from
  for (let i = 0; i < 120 && d <= to; i++) {
    days.push(d)
    d = nextDay(d)
  }
  return days
}
function firstOfMonth(date: string): string {
  const [y, m] = date.split('-').map(Number)
  return `${y}-${String(m).padStart(2, '0')}-01`
}
function lastOfMonth(date: string): string {
  const [y, m] = date.split('-').map(Number)
  // Day 0 of the next month is the last day of this one.
  return new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10)
}
function addMonths(date: string, n: number): string {
  const [y, m] = date.split('-').map(Number)
  return new Date(Date.UTC(y, m - 1 + n, 1)).toISOString().slice(0, 10)
}
function monthLabel(date: string): string {
  const [y, m, d] = date.split('-').map(Number)
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString('en-US', {
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  })
}
function weekdayIndex(date: string): number {
  const [y, m, d] = date.split('-').map(Number)
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay()
}
function formatDay(date: string): { day: string; month: string } {
  const [y, m, d] = date.split('-').map(Number)
  const dt = new Date(Date.UTC(y, m - 1, d))
  return { day: String(d), month: dt.toLocaleDateString('en-US', { month: 'short', timeZone: 'UTC' }) }
}
function formatFull(date: string): string {
  const [y, m, d] = date.split('-').map(Number)
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString('en-US', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  })
}
function titleCase(s: string): string {
  return s.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())
}

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

export function LodgingCalendar() {
  const [data, setData] = useState<CalendarResponse | null>(null)
  const [from, setFrom] = useState<string | undefined>(undefined)
  const [unit, setUnit] = useState<string>(ALL_UNITS)
  const [selected, setSelected] = useState<string | null>(null)
  const [day, setDay] = useState<DayResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const today = new Date().toLocaleDateString('en-CA')

  // One whole month at a time (tester, 23 Jul 2026). `monthAnchor` is any day in the target
  // month (undefined = the current month); we ask the server for that month's first→last day.
  const load = useCallback(async (monthAnchor?: string) => {
    setLoading(true)
    try {
      const start = firstOfMonth(monthAnchor ?? new Date().toLocaleDateString('en-CA'))
      const end = lastOfMonth(start)
      setData(await api<CalendarResponse>(`/rooms/calendar?from=${start}&to=${end}`))
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed to load the lodging calendar')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    load(from)
  }, [load, from])

  // Nothing resets `day` when the selection clears: DayDetail is only handed the response
  // when it matches the date being asked for, so a stale one can never render as another day's.
  useEffect(() => {
    if (!selected) return
    let live = true
    api<DayResponse>(`/rooms/calendar/${selected}`)
      .then((res) => {
        if (live) setDay(res)
      })
      .catch((e) => toast.error(e instanceof Error ? e.message : 'Failed to load that date'))
    return () => {
      live = false
    }
  }, [selected])

  const units = useMemo(() => {
    const seen = new Map<string, string>()
    for (const i of data?.inventory ?? []) seen.set(i.unitId, i.unitName)
    return [...seen].map(([id, name]) => ({ id, name }))
  }, [data])

  const inScope = useCallback((unitId: string) => unit === ALL_UNITS || unitId === unit, [unit])

  /** Total active rooms in the current unit filter — the denominator for every cell. */
  const capacity = useMemo(
    () => (data?.inventory ?? []).filter((i) => inScope(i.unitId)).reduce((n, i) => n + i.total, 0),
    [data, inScope],
  )

  /** date → { locked, confirmed, pending } summed over the units in scope. */
  const byDate = useMemo(() => {
    const map = new Map<string, { locked: number; confirmed: number; pending: number }>()
    for (const c of data?.occupancy ?? []) {
      if (!inScope(c.unitId)) continue
      const cur = map.get(c.date) ?? { locked: 0, confirmed: 0, pending: 0 }
      cur.locked += c.locked
      cur.confirmed += c.confirmed
      cur.pending += c.pending
      map.set(c.date, cur)
    }
    return map
  }, [data, inScope])

  const days = useMemo(() => (data ? eachDay(data.from, data.to) : []), [data])
  const leadingBlanks = days.length ? weekdayIndex(days[0]!) : 0
  const weekRows = Math.max(1, Math.ceil((leadingBlanks + days.length) / 7))
  // Pad the final row so the grid keeps clean rectangular rows at any month offset.
  const trailingBlanks = weekRows * 7 - (leadingBlanks + days.length)

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3">
      <div className="flex flex-wrap items-center gap-3">
        <div className="flex items-center gap-1">
          <Button
            variant="outline"
            size="icon"
            onClick={() => data && setFrom(addMonths(data.from, -1))}
            disabled={loading}
            aria-label="Previous month"
          >
            <ChevronLeft className="size-4" />
          </Button>
          <Button
            variant="outline"
            size="icon"
            onClick={() => data && setFrom(addMonths(data.from, 1))}
            disabled={loading}
            aria-label="Next month"
          >
            <ChevronRight className="size-4" />
          </Button>
          <span className="ml-1 min-w-40 text-base font-semibold tabular-nums">
            {data ? monthLabel(data.from) : ''}
          </span>
          {from && (
            <Button variant="ghost" size="sm" onClick={() => setFrom(undefined)}>
              This month
            </Button>
          )}
        </div>

        {/* A one-lodge user (a Lodge Manager) sees only their own lodge, so "All units" would
            just duplicate it with an identical count. Show the switch only when more than one
            lodge is actually in scope — e.g. the Auditor (tester, 23 Jul 2026). */}
        {units.length > 1 && (
          <div className="flex flex-wrap items-center gap-0.5 rounded-lg border bg-card p-0.5">
            <UnitTab label="All units" active={unit === ALL_UNITS} onClick={() => setUnit(ALL_UNITS)} />
            {units.map((u) => (
              <UnitTab key={u.id} label={u.name} active={unit === u.id} onClick={() => setUnit(u.id)} />
            ))}
          </div>
        )}

        <Legend />
      </div>

      {/* Header row plus one row per week, sharing the leftover height — the whole
          window stays on one screen until a date is opened (client, 20 Jul 2026). */}
      {/* Horizontal scroll on phones keeps the day cells legible; at lg+ the month fits the
          width with no scroll (tester, 25 Jul 2026). */}
      <div className="min-h-0 flex-1 overflow-auto rounded-lg border">
        <div
          className="grid h-full min-w-[42rem] grid-cols-7 gap-px bg-border lg:min-w-0"
          style={{ gridTemplateRows: `auto repeat(${weekRows}, minmax(0, 1fr))` }}
        >
        {WEEKDAYS.map((w) => (
          <div
            key={w}
            className="bg-muted px-2 py-2.5 text-center text-[10px] font-semibold uppercase tracking-[0.12em] text-muted-foreground"
          >
            {w}
          </div>
        ))}
        {Array.from({ length: leadingBlanks }, (_, i) => (
          <div key={`lead-${i}`} className="bg-muted/30" />
        ))}
        {days.map((date) => {
          const o = byDate.get(date) ?? { locked: 0, confirmed: 0, pending: 0 }
          const booked = o.locked + o.confirmed + o.pending
          const vacant = Math.max(0, capacity - booked)
          const { day: dd } = formatDay(date)
          const isToday = date === today
          const isSelected = date === selected
          return (
            <button
              key={date}
              type="button"
              onClick={() => setSelected(isSelected ? null : date)}
              aria-pressed={isSelected}
              className={cn(
                'flex min-h-0 flex-col gap-1.5 overflow-hidden bg-card p-2 text-left transition-colors hover:bg-accent/50',
                'focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring',
                isToday && 'bg-accent/40',
                isSelected && 'ring-2 ring-inset ring-secondary',
              )}
            >
              <div className="flex items-baseline gap-1">
                <span className={cn('text-[15px] tabular-nums', isToday && 'font-semibold text-primary')}>
                  {dd}
                </span>
              </div>

              <OccupancyBar locked={o.locked} soft={o.confirmed + o.pending} vacant={vacant} />

              <div className="mt-auto text-[11px] leading-tight tabular-nums">
                {booked === 0 ? (
                  <span className="text-muted-foreground">All {capacity} vacant</span>
                ) : (
                  <>
                    <span className="font-medium">{booked}</span>
                    <span className="text-muted-foreground">/{capacity} booked</span>
                  </>
                )}
              </div>
            </button>
          )
        })}
        {Array.from({ length: trailingBlanks }, (_, i) => (
          <div key={`trail-${i}`} className="bg-muted/30" />
        ))}
        </div>
      </div>

      {loading && <p className="text-sm text-muted-foreground">Loading…</p>}

      {selected && (
        <DayDetail
          date={selected}
          day={day?.date === selected ? day : null}
          unitFilter={unit}
          onClose={() => setSelected(null)}
        />
      )}

      {!selected && !loading && (
        <p className="flex items-center gap-2 rounded-md border bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
          <Info className="size-3.5 shrink-0" />
          Pick a date to see what is booked in each category and by whom. Counts are cumulative —
          room numbers are assigned on the booking&apos;s own rooms tab.
        </p>
      )}
    </div>
  )
}

function UnitTab({ label, active, onClick }: { label: string; active: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'rounded-md px-3 py-1.5 text-[11px] font-semibold uppercase tracking-[0.08em] transition-colors',
        'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring',
        active
          ? 'bg-secondary text-secondary-foreground'
          : 'text-muted-foreground hover:bg-muted hover:text-foreground',
      )}
    >
      {label}
    </button>
  )
}

function OccupancyBar({ locked, soft, vacant }: { locked: number; soft: number; vacant: number }) {
  const total = locked + soft + vacant
  if (total === 0) return <div className="h-1.5 rounded-full bg-muted" />
  const pct = (n: number) => `${(n / total) * 100}%`
  return (
    <div className="flex h-1.5 overflow-hidden rounded-full bg-muted">
      {locked > 0 && <div className={STATE_STYLE.locked} style={{ width: pct(locked) }} />}
      {soft > 0 && <div className={STATE_STYLE.confirmed} style={{ width: pct(soft) }} />}
      {vacant > 0 && <div className={STATE_STYLE.vacant} style={{ width: pct(vacant) }} />}
    </div>
  )
}

function Legend() {
  const items = [
    { label: 'Locked', className: STATE_STYLE.locked },
    { label: 'Confirmed / pending', className: STATE_STYLE.confirmed },
    { label: 'Vacant', className: STATE_STYLE.vacant },
  ]
  return (
    <div className="ml-auto flex flex-wrap items-center gap-4">
      {items.map((it) => (
        <span
          key={it.label}
          className="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-[0.1em] text-muted-foreground"
        >
          <span className={cn('size-2 rounded-full', it.className)} aria-hidden />
          {it.label}
        </span>
      ))}
    </div>
  )
}

function DayDetail({
  date,
  day,
  unitFilter,
  onClose,
}: {
  date: string
  day: DayResponse | null
  unitFilter: string
  onClose: () => void
}) {
  const rows = useMemo(() => {
    if (!day) return []
    const inScope = (unitId: string) => unitFilter === ALL_UNITS || unitId === unitFilter
    const held = new Map<string, { locked: number; confirmed: number; pending: number; who: Holder[] }>()
    for (const h of day.holders) {
      if (!inScope(h.unitId)) continue
      const k = `${h.unitId}|${h.roomType}`
      const cur = held.get(k) ?? { locked: 0, confirmed: 0, pending: 0, who: [] }
      cur[h.state] += h.count
      cur.who.push(h)
      held.set(k, cur)
    }
    return day.inventory
      .filter((i) => inScope(i.unitId))
      .map((i) => {
        const h = held.get(`${i.unitId}|${i.roomType}`) ?? { locked: 0, confirmed: 0, pending: 0, who: [] }
        const booked = h.locked + h.confirmed + h.pending
        return { ...i, ...h, booked, vacant: Math.max(0, i.total - booked) }
      })
  }, [day, unitFilter])

  const totals = rows.reduce(
    (a, r) => ({ total: a.total + r.total, booked: a.booked + r.booked, vacant: a.vacant + r.vacant }),
    { total: 0, booked: 0, vacant: 0 },
  )

  return (
    <div className="rounded-lg border bg-card">
      <div className="flex flex-wrap items-baseline justify-between gap-2 border-b px-4 py-3">
        <div>
          <h2 className="font-medium">{formatFull(date)}</h2>
          <p className="text-xs text-muted-foreground tabular-nums">
            {totals.booked} of {totals.total} booked · {totals.vacant} vacant
          </p>
        </div>
        <Button
          variant="ghost"
          size="sm"
          onClick={onClose}
          className="text-[11px] font-semibold uppercase tracking-[0.1em] text-muted-foreground"
        >
          Close
        </Button>
      </div>

      {!day ? (
        <p className="p-4 text-sm text-muted-foreground">Loading…</p>
      ) : rows.length === 0 ? (
        <p className="p-4 text-sm text-muted-foreground">No rooms configured for this unit yet.</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[640px] text-sm">
            <thead>
              <tr className="border-b text-left text-[10px] uppercase tracking-[0.12em] text-muted-foreground">
                <th className="px-4 py-2.5 font-semibold">Unit</th>
                <th className="px-4 py-2.5 font-semibold">Category</th>
                <th className="px-4 py-2.5 text-right font-semibold">Booked</th>
                <th className="px-4 py-2.5 text-right font-semibold">Vacant</th>
                <th className="px-4 py-2.5 font-semibold">Held by</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r, i) => {
                const newUnit = i === 0 || rows[i - 1]!.unitId !== r.unitId
                return (
                  <tr key={`${r.unitId}-${r.roomType}`} className={cn('border-b last:border-b-0', newUnit && 'border-t-2')}>
                    <td className="px-4 py-2 align-top text-muted-foreground">
                      {newUnit ? r.unitName : ''}
                    </td>
                    <td className="px-4 py-2 align-top font-medium">{titleCase(r.roomType)}</td>
                    <td className="px-4 py-2 text-right align-top tabular-nums">
                      <span className={cn(r.booked > 0 && 'font-medium')}>{r.booked}</span>
                      <span className="text-muted-foreground">/{r.total}</span>
                    </td>
                    <td
                      className={cn(
                        'px-4 py-2 text-right align-top tabular-nums',
                        r.vacant > 0 ? 'text-emerald-700 dark:text-emerald-400' : 'text-muted-foreground',
                      )}
                    >
                      {r.vacant}
                    </td>
                    <td className="px-4 py-2 align-top">
                      {r.who.length === 0 ? (
                        <span className="text-muted-foreground">—</span>
                      ) : (
                        <div className="flex flex-wrap gap-1">
                          {r.who.map((h) => (
                            <span
                              key={`${h.eventId}-${h.state}`}
                              className={cn(
                                'rounded-md px-1.5 py-0.5 text-[11px] ring-1 ring-inset',
                                STATE_CHIP[h.state],
                              )}
                              title={`${h.guestName} · ${h.code} · ${titleCase(h.status)}${
                                h.state === 'pending' ? ' · awaiting Authority approval (35+ rooms)' : ''
                              }`}
                            >
                              {h.guestName} ×{h.count}
                              {h.state === 'pending' && ' (pending)'}
                            </span>
                          ))}
                        </div>
                      )}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
