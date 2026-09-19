'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { ChevronLeft, ChevronRight, Info } from 'lucide-react'
import { toast } from 'sonner'
import { api } from '@/lib/http'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { formatTime } from '@/lib/time'

/**
 * The venue tape chart (client's lead, 18 Sep 2026) — the lodging calendar's counterpart for
 * halls, lawns and bundles. A month of dates at the top, exactly as the lodging calendar picks
 * its day (client, 19 Sep 2026); click one and every venue's day is drawn underneath along a
 * 24-hour axis, so "is Diamond free on the 25th, and from when?" is answered by looking.
 *
 * It says NOTHING about whose booking a window belongs to: that is the calendar board's job.
 * Here a busy window is the whole answer.
 *
 * Colour is never the only signal — every date carries its taken/total count and every venue
 * row spells its free windows out in words.
 */

type Venue = { id: string; name: string; kind: string; propertyName: string }
type Bundle = { id: string; name: string; memberIds: string[]; memberNames: string }
type Busy = { venueId: string; starts: string; ends: string }
type TapeResponse = {
  from: string
  to: string
  venues: Venue[]
  bundles: Bundle[]
  busy: Busy[]
}

/** A busy window clipped to one day, in minutes past midnight. */
type Span = { from: number; to: number; fromPrev: boolean; intoNext: boolean }
type Row = { id: string; name: string; sub: string; spans: Span[] }
type Group = { name: string; note?: string; rows: Row[] }

const DAY = 1440
const TICKS = [0, 2, 4, 6, 8, 10, 12, 14, 16, 18, 20, 22]
/** Phones only have room for a quarter-day axis; the rest of the ticks appear at sm+. */
const isMajorTick = (h: number) => h % 6 === 0
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

// ── date helpers (UTC throughout: these are calendar dates, not instants) ────────

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

// ── occupancy maths ─────────────────────────────────────────────────────────────

function pct(min: number) {
  return `${(min / DAY) * 100}%`
}
function tickLabel(h: number) {
  if (h === 0) return '12a'
  if (h === 12) return '12p'
  return h < 12 ? `${h}a` : `${h - 12}p`
}
function toMin(iso: string) {
  return Number(iso.slice(11, 13)) * 60 + Number(iso.slice(14, 16))
}
/** Minutes past midnight as the app's 12-hour text; the end of the day reads as midnight. */
function clock(min: number) {
  const m = min % DAY
  return formatTime(`${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`)
}
function range(from: number, to: number) {
  return `${clock(from)} – ${clock(to)}`
}

/** The last calendar day a window actually occupies — one ending at midnight does not touch it. */
function lastDayOf(w: Busy): string {
  const endDay = w.ends.slice(0, 10)
  return toMin(w.ends) === 0 ? w.starts.slice(0, 10) : endDay
}

/**
 * Stored occupancy windows clipped to one day, and MERGED where they touch: since
 * 13 Sep 2026 an all-day live counter may legitimately share a hall with the function it
 * accompanies, so one row can carry two windows over the same minutes — and "taken 9 AM to
 * 11 PM" is the answer this screen owes, not a stack of bars.
 */
export function spansFor(day: string, windows: Busy[]): Span[] {
  // Take the windows that actually touch this day FIRST. The payload carries a whole month,
  // and clipping a window from another date to [00:00, 24:00) would draw it here as a phantom
  // block — a hall reading as taken on a day nothing is booked in it.
  const dayStart = `${day}T00:00`
  const dayEnd = `${nextDay(day)}T00:00`
  const clipped = windows
    .filter((w) => w.starts < dayEnd && w.ends > dayStart)
    .map((w) => ({
      from: w.starts.slice(0, 10) < day ? 0 : toMin(w.starts),
      to: w.ends.slice(0, 10) > day ? DAY : toMin(w.ends),
      fromPrev: w.starts.slice(0, 10) < day,
      intoNext: w.ends.slice(0, 10) > day,
    }))
    .filter((s) => s.to > s.from)
    .sort((a, b) => a.from - b.from)

  const merged: Span[] = []
  for (const s of clipped) {
    const last = merged[merged.length - 1]
    if (last && s.from <= last.to) {
      last.to = Math.max(last.to, s.to)
      last.intoNext = last.intoNext || s.intoNext
    } else {
      merged.push({ ...s })
    }
  }
  return merged
}

/** The gaps between the busy windows — what the desk is actually looking for. */
export function freeWindows(spans: Span[]): { from: number; to: number }[] {
  const free: { from: number; to: number }[] = []
  let cursor = 0
  for (const s of spans) {
    if (s.from > cursor) free.push({ from: cursor, to: s.from })
    cursor = Math.max(cursor, s.to)
  }
  if (cursor < DAY) free.push({ from: cursor, to: DAY })
  return free
}

export function VenueTapeChart() {
  const [data, setData] = useState<TapeResponse | null>(null)
  const [from, setFrom] = useState<string | undefined>(undefined)
  const [loading, setLoading] = useState(true)
  const today = new Date().toLocaleDateString('en-CA')
  // The day opens on today, so the page lands on the chart people came for; moving month
  // clears it, since a date that is no longer on screen must not go on being drawn below.
  const [selected, setSelected] = useState<string | null>(today)

  // One whole month at a time, like the lodging calendar. `from` is any day in the target
  // month (undefined = the current month); we ask for that month's first → last day.
  const load = useCallback(async (monthAnchor?: string) => {
    setLoading(true)
    try {
      const start = firstOfMonth(monthAnchor ?? new Date().toLocaleDateString('en-CA'))
      const end = lastOfMonth(start)
      setData(await api<TapeResponse>(`/calendar/availability?from=${start}&to=${end}`))
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed to load venue availability')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    load(from)
  }, [load, from])

  function goToMonth(anchor: string) {
    setFrom(anchor)
    setSelected(null)
  }

  /** Every venue taken at any point on a date — the month grid's count. */
  const takenByDate = useMemo(() => {
    const map = new Map<string, Set<string>>()
    for (const w of data?.busy ?? []) {
      for (const d of eachDay(w.starts.slice(0, 10), lastDayOf(w))) {
        const set = map.get(d) ?? new Set<string>()
        set.add(w.venueId)
        map.set(d, set)
      }
    }
    return map
  }, [data])

  const days = useMemo(() => (data ? eachDay(data.from, data.to) : []), [data])
  const leadingBlanks = days.length ? weekdayIndex(days[0]!) : 0
  const weekRows = Math.max(1, Math.ceil((leadingBlanks + days.length) / 7))
  const trailingBlanks = weekRows * 7 - (leadingBlanks + days.length)
  const capacity = data?.venues.length ?? 0

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2 sm:gap-3">
        <div className="flex items-center gap-1">
          <Button
            variant="outline"
            size="icon"
            onClick={() => data && goToMonth(addMonths(data.from, -1))}
            disabled={loading}
            aria-label="Previous month"
          >
            <ChevronLeft className="size-4" />
          </Button>
          <Button
            variant="outline"
            size="icon"
            onClick={() => data && goToMonth(addMonths(data.from, 1))}
            disabled={loading}
            aria-label="Next month"
          >
            <ChevronRight className="size-4" />
          </Button>
          <span className="ml-1 min-w-36 text-base font-semibold tabular-nums">
            {data ? monthLabel(data.from) : ''}
          </span>
          {from && (
            <Button variant="ghost" size="sm" onClick={() => { setFrom(undefined); setSelected(today) }}>
              This month
            </Button>
          )}
        </div>
        <Legend />
      </div>

      <div className="overflow-hidden rounded-lg border">
        <div className="grid grid-cols-7 gap-px bg-border">
          {WEEKDAYS.map((w) => (
            <div
              key={w}
              className="bg-muted px-1 py-2 text-center text-[10px] font-semibold uppercase tracking-[0.08em] text-muted-foreground sm:px-2 sm:tracking-[0.12em]"
            >
              <span className="sm:hidden">{w[0]}</span>
              <span className="hidden sm:inline">{w}</span>
            </div>
          ))}
          {Array.from({ length: leadingBlanks }, (_, i) => (
            <div key={`lead-${i}`} className="min-h-16 bg-muted/30 sm:min-h-20" />
          ))}
          {days.map((date) => {
            const taken = takenByDate.get(date)?.size ?? 0
            const free = Math.max(0, capacity - taken)
            const isToday = date === today
            const isSelected = date === selected
            return (
              <button
                key={date}
                type="button"
                onClick={() => setSelected(isSelected ? null : date)}
                aria-pressed={isSelected}
                className={cn(
                  'flex min-h-16 flex-col gap-1 bg-card p-1.5 text-left transition-colors hover:bg-accent/50 sm:min-h-20 sm:gap-1.5 sm:p-2',
                  'focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring',
                  isToday && 'bg-accent/40',
                  isSelected && 'ring-2 ring-inset ring-secondary',
                )}
              >
                <span
                  className={cn(
                    'text-[13px] tabular-nums sm:text-[15px]',
                    isToday && 'font-semibold text-primary',
                  )}
                >
                  {Number(date.slice(8))}
                </span>
                <OccupancyBar taken={taken} free={free} />
                <span className="mt-auto text-[10px] leading-tight tabular-nums text-muted-foreground sm:text-[11px]">
                  {taken === 0 ? (
                    <>
                      <span className="sm:hidden">Free</span>
                      <span className="hidden sm:inline">All {capacity} free</span>
                    </>
                  ) : (
                    <>
                      <span className="font-medium text-foreground">{taken}</span>/{capacity}
                      <span className="hidden sm:inline"> taken</span>
                    </>
                  )}
                </span>
              </button>
            )
          })}
          {Array.from({ length: trailingBlanks }, (_, i) => (
            <div key={`trail-${i}`} className="min-h-16 bg-muted/30 sm:min-h-20" />
          ))}
        </div>
      </div>

      {loading && <p className="text-sm text-muted-foreground">Loading…</p>}

      {selected && data && (
        <DayTape
          date={selected}
          data={data}
          isToday={selected === today}
          onClose={() => setSelected(null)}
        />
      )}

      {!selected && !loading && (
        <p className="flex items-center gap-2 rounded-md border bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
          <Info className="size-3.5 shrink-0" />
          Pick a date to see every hall, lawn and bundle hour by hour.
        </p>
      )}
    </div>
  )
}

function OccupancyBar({ taken, free }: { taken: number; free: number }) {
  const total = taken + free
  if (total === 0) return <div className="h-1.5 rounded-full bg-muted" />
  const width = (n: number) => `${(n / total) * 100}%`
  return (
    <div className="flex h-1.5 overflow-hidden rounded-full bg-muted">
      {taken > 0 && <div className="bg-rose-500 dark:bg-rose-600" style={{ width: width(taken) }} />}
      {free > 0 && <div className="bg-emerald-500 dark:bg-emerald-600" style={{ width: width(free) }} />}
    </div>
  )
}

function DayTape({
  date,
  data,
  isToday,
  onClose,
}: {
  date: string
  data: TapeResponse
  isToday: boolean
  onClose: () => void
}) {
  const { groups, venueRows } = useMemo(() => {
    const byVenue = new Map<string, Busy[]>()
    for (const b of data.busy) {
      const list = byVenue.get(b.venueId) ?? []
      list.push(b)
      byVenue.set(b.venueId, list)
    }

    const properties: Group[] = []
    for (const v of data.venues) {
      let group = properties.find((g) => g.name === v.propertyName)
      if (!group) {
        group = { name: v.propertyName, rows: [] }
        properties.push(group)
      }
      group.rows.push({
        id: v.id,
        name: v.name,
        sub: v.kind === 'lawn' ? 'Lawn' : 'Hall',
        spans: spansFor(date, byVenue.get(v.id) ?? []),
      })
    }

    // A bundle is free only when every venue in it is, so its row is the union of its members'
    // windows. Its own group, because it is not a place but a package of them.
    const bundles: Row[] = data.bundles.map((b) => ({
      id: b.id,
      name: b.name,
      sub: b.memberNames,
      spans: spansFor(date, b.memberIds.flatMap((id) => byVenue.get(id) ?? [])),
    }))

    const groups: Group[] =
      bundles.length > 0
        ? [
            ...properties,
            // Spelled out, because a bundle row filling makes the day look busier than the
            // date's own count: the count is of PLACES, and a bundle is places already counted.
            { name: 'Bundles', note: 'taken whenever one of their venues is', rows: bundles },
          ]
        : properties
    // The count above the chart is of PLACES. A bundle is the same halls counted twice, so
    // adding it to the denominator would make a full day read as half free.
    return { groups, venueRows: properties.flatMap((g) => g.rows) }
  }, [date, data])

  const freeAllDay = venueRows.filter((r) => r.spans.length === 0).length
  const rowCount = groups.reduce((n, g) => n + g.rows.length, 0)

  const nowMin = useMemo(() => {
    if (!isToday) return null
    const now = new Date()
    return now.getHours() * 60 + now.getMinutes()
  }, [isToday])

  return (
    <div className="overflow-hidden rounded-lg border bg-card">
      <div className="flex flex-wrap items-baseline justify-between gap-2 border-b px-3 py-3 sm:px-4">
        <div>
          <h2 className="font-medium">{formatFull(date)}</h2>
          <p className="text-xs text-muted-foreground tabular-nums">
            {freeAllDay} of {venueRows.length} halls &amp; lawns free all day
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

      <div className="flex border-b bg-muted/40">
        <div className="hidden w-44 shrink-0 px-3 py-2 text-[10px] font-semibold uppercase tracking-[0.12em] text-muted-foreground sm:block">
          Venue
        </div>
        {/* Same padding as a row's tape, so the ticks sit over the bars below them. */}
        <div className="flex-1 px-3 py-2 sm:pl-0 sm:pr-4">
          <div className="relative h-3">
            {TICKS.map((h) => (
              <span
                key={h}
                className={cn(
                  'absolute top-0 text-[10px] leading-3 tabular-nums text-muted-foreground',
                  !isMajorTick(h) && 'hidden sm:inline',
                )}
                style={{ left: pct(h * 60) }}
              >
                {tickLabel(h)}
              </span>
            ))}
          </div>
        </div>
      </div>

      {groups.map((g) => (
        <div key={g.name}>
          <div className="border-b bg-muted/20 px-3 py-1.5 text-[10px] font-semibold uppercase tracking-[0.12em] text-muted-foreground sm:px-4">
            {g.name}
            {g.note && (
              <span className="ml-1.5 font-normal normal-case tracking-normal">— {g.note}</span>
            )}
          </div>
          {g.rows.map((row) => (
            <TapeRow key={row.id} row={row} nowMin={nowMin} />
          ))}
        </div>
      ))}

      {rowCount === 0 && <p className="p-4 text-sm text-muted-foreground">No active venues configured.</p>}

      <p className="flex items-start gap-2 border-t bg-muted/30 px-3 py-2 text-xs text-muted-foreground sm:px-4">
        <Info className="mt-0.5 size-3.5 shrink-0" />
        Confirmed bookings only — an enquiry holds no venue, so the first booking to be confirmed
        takes the slot. A window running past midnight is marked ◀ / ▶ and shows on both days.
      </p>
    </div>
  )
}

function TapeRow({ row, nowMin }: { row: Row; nowMin: number | null }) {
  const free = freeWindows(row.spans)
  const freeText =
    row.spans.length === 0
      ? 'Free all day'
      : free.length === 0
        ? 'Taken all day'
        : `Free ${free.map((f) => range(f.from, f.to)).join('  ·  ')}`

  return (
    <div className="flex flex-col border-b last:border-b-0 sm:flex-row sm:items-stretch">
      <div className="w-full shrink-0 px-3 pt-2 sm:w-44 sm:py-2">
        <div className="text-sm font-medium leading-tight">{row.name}</div>
        <div className="truncate text-[11px] text-muted-foreground" title={row.sub}>
          {row.sub}
        </div>
      </div>
      <div className="min-w-0 flex-1 px-3 pb-2 pt-1.5 sm:py-2 sm:pl-0 sm:pr-4">
        <div className="relative h-7 overflow-hidden rounded-md bg-emerald-50 ring-1 ring-inset ring-emerald-200 dark:bg-emerald-950/50 dark:ring-emerald-900">
          {TICKS.map((h) => (
            <span
              key={h}
              className={cn('absolute inset-y-0 w-px bg-border/60', !isMajorTick(h) && 'hidden sm:block')}
              style={{ left: pct(h * 60) }}
              aria-hidden
            />
          ))}
          {row.spans.map((s) => (
            <div
              key={s.from}
              className="absolute inset-y-0 flex items-center gap-0.5 overflow-hidden rounded-md bg-rose-500 px-1 dark:bg-rose-600 sm:px-1.5"
              style={{ left: pct(s.from), width: pct(s.to - s.from) }}
              title={`Taken ${range(s.from, s.to)}${s.fromPrev ? ' — from the previous day' : ''}${s.intoNext ? ' — runs into the next day' : ''}`}
            >
              {s.fromPrev && <span className="shrink-0 text-[10px] text-white/90">◀</span>}
              <span className="truncate text-[10px] font-medium tabular-nums text-white">
                {range(s.from, s.to)}
              </span>
              {s.intoNext && <span className="ml-auto shrink-0 text-[10px] text-white/90">▶</span>}
            </div>
          ))}
          {nowMin !== null && (
            <span
              className="absolute inset-y-0 w-0.5 bg-primary"
              style={{ left: pct(nowMin) }}
              title="Now"
              aria-hidden
            />
          )}
        </div>
        <p
          className={cn(
            'mt-1 text-[11px] leading-tight',
            row.spans.length === 0
              ? 'text-emerald-700 dark:text-emerald-400'
              : 'text-muted-foreground',
          )}
        >
          {freeText}
        </p>
      </div>
    </div>
  )
}

function Legend() {
  const items = [
    { label: 'Taken', className: 'bg-rose-500 dark:bg-rose-600' },
    { label: 'Free', className: 'bg-emerald-500 dark:bg-emerald-600' },
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
