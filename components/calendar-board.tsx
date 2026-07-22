'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { ChevronLeft, ChevronRight, Info } from 'lucide-react'
import { toast } from 'sonner'
import { api } from '@/lib/http'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { formatTime } from '@/lib/time'

/**
 * The venue calendar as a month/week grid (client, 20 Jul 2026), replacing the venues × dates
 * matrix. Confirmed-and-beyond bookings only — enquiries never appear here (FR-2.5).
 *
 * ONE THING TO KNOW ABOUT THE WINDOW. FR-2.1 caps operational roles to a rolling 15 days and
 * `/calendar` clamps `from`/`to` server-side. A month grid asks for ~35 days, so a capped
 * role gets data for only part of it. Those out-of-range days are drawn as explicitly
 * *unavailable* rather than empty — an empty-looking day on a booking calendar reads as
 * "free to sell", and that would be a lie the moment someone books into it.
 */

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

// Status colour (FR-2.5). Never the only signal — each chip also carries a time and, for a
// carryover tail, a "↳" glyph. The left rule is what reads at a glance in a dense grid.
const STATUS_RULE: Record<string, string> = {
  confirmed: 'border-l-[var(--chart-2)]',
  in_progress: 'border-l-emerald-500',
  completed: 'border-l-muted-foreground',
  locked: 'border-l-primary',
  billed: 'border-l-primary',
  closed: 'border-l-muted-foreground',
}
const CARRYOVER_RULE = 'border-l-amber-500'

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

function dateOnly(iso: string) { return iso.slice(0, 10) }
function timeOnly(iso: string) { return iso.slice(11, 16) }
function ymd(d: Date) { return d.toISOString().slice(0, 10) }
function parse(date: string) {
  const [y, m, d] = date.split('-').map(Number)
  return new Date(Date.UTC(y, m - 1, d))
}
function shift(date: string, days: number) {
  const d = parse(date); d.setUTCDate(d.getUTCDate() + days); return ymd(d)
}
function shiftMonths(date: string, months: number) {
  const d = parse(date); d.setUTCDate(1); d.setUTCMonth(d.getUTCMonth() + months); return ymd(d)
}
function startOfMonth(date: string) { const d = parse(date); d.setUTCDate(1); return ymd(d) }
function startOfWeek(date: string) { const d = parse(date); return shift(ymd(d), -d.getUTCDay()) }
function monthLabel(date: string) {
  return parse(date).toLocaleDateString('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' })
}
function longDate(date: string) {
  return parse(date).toLocaleDateString('en-US', {
    weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC',
  })
}
function titleCase(s: string) {
  return s.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())
}

type Chip = { key: string; booking: Booking; label: string; carryover: boolean }

export function CalendarBoard() {
  const [data, setData] = useState<CalendarResponse | null>(null)
  const [mode, setMode] = useState<'month' | 'week'>('month')
  const [anchor, setAnchor] = useState(() => new Date().toLocaleDateString('en-CA'))
  const [selected, setSelected] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const today = new Date().toLocaleDateString('en-CA')

  // The visible grid always starts on a Sunday and, in month mode, covers whole weeks.
  const gridFrom = mode === 'month' ? startOfWeek(startOfMonth(anchor)) : startOfWeek(anchor)
  const gridDays = mode === 'month' ? 42 : 7
  const gridTo = shift(gridFrom, gridDays - 1)

  const load = useCallback(async (from: string, to: string) => {
    setLoading(true)
    try {
      setData(await api<CalendarResponse>(`/calendar?from=${from}&to=${to}`))
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed to load the calendar')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    load(gridFrom, gridTo)
  }, [load, gridFrom, gridTo])

  const days = useMemo(
    () => Array.from({ length: gridDays }, (_, i) => shift(gridFrom, i)),
    [gridFrom, gridDays],
  )

  const venueName = useMemo(() => {
    const m = new Map<string, string>()
    for (const v of data?.venues ?? []) m.set(v.id, v.name)
    return m
  }, [data])

  // date -> chips. A cross-midnight booking shows on its start day and again, as a tail,
  // on the following morning (BR-C1).
  const cells = useMemo(() => {
    const map = new Map<string, Chip[]>()
    const push = (date: string, chip: Chip) => {
      const list = map.get(date) ?? []
      list.push(chip)
      map.set(date, list)
    }
    for (const b of data?.bookings ?? []) {
      const s = dateOnly(b.starts)
      const e = dateOnly(b.ends)
      const crosses = e > s
      // Key on sub-event AND venue: booking a bundle writes one row per member venue, so
      // one sub-event legitimately appears more than once on a day (FR-2.3). Keying on the
      // sub-event alone collides, and React may then drop one of the two — a booked venue
      // silently missing from the calendar.
      push(s, {
        key: `${b.subEventId}-${b.venueId}-main`,
        booking: b,
        label: crosses ? `${formatTime(timeOnly(b.starts))}→` : `${formatTime(timeOnly(b.starts))}–${formatTime(timeOnly(b.ends))}`,
        carryover: false,
      })
      if (crosses) {
        push(e, {
          key: `${b.subEventId}-${b.venueId}-tail`,
          booking: b,
          label: `↳ till ${formatTime(timeOnly(b.ends))}`,
          carryover: true,
        })
      }
    }
    return map
  }, [data])

  /** A day the server refused to return data for — not the same thing as a day with none. */
  const outOfWindow = (date: string) => !!data && (date < data.from || date > data.to)
  const inMonth = (date: string) => mode === 'week' || date.slice(0, 7) === anchor.slice(0, 7)

  const step = (dir: 1 | -1) =>
    setAnchor((a) => (mode === 'month' ? shiftMonths(a, dir) : shift(startOfWeek(a), dir * 7)))

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3">
      {/* Toolbar */}
      <div className="flex flex-wrap items-center gap-3">
        <div className="flex items-center gap-0.5 rounded-lg border bg-card p-0.5">
          {(['month', 'week'] as const).map((m) => (
            <button
              key={m}
              type="button"
              onClick={() => setMode(m)}
              className={cn(
                'rounded-md px-3 py-1.5 text-[11px] font-semibold uppercase tracking-[0.08em] transition-colors',
                'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring',
                mode === m ? 'bg-secondary text-secondary-foreground' : 'text-muted-foreground hover:bg-muted hover:text-foreground',
              )}
            >
              {m}
            </button>
          ))}
        </div>

        <div className="flex items-center gap-1">
          <Button variant="outline" size="icon" onClick={() => step(-1)} disabled={loading} aria-label={`Previous ${mode}`}>
            <ChevronLeft className="size-4" />
          </Button>
          <Button variant="outline" size="icon" onClick={() => step(1)} disabled={loading} aria-label={`Next ${mode}`}>
            <ChevronRight className="size-4" />
          </Button>
        </div>

        <h2 className="font-[family-name:var(--font-serif)] text-lg font-semibold">
          {mode === 'month' ? monthLabel(anchor) : `Week of ${longDate(startOfWeek(anchor))}`}
        </h2>

        {anchor !== today && (
          <Button variant="ghost" size="sm" onClick={() => setAnchor(today)}>Today</Button>
        )}

        <Legend />
      </div>

      {data?.capped && (
        <p className="flex items-center gap-2 rounded-md border bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
          <Info className="size-3.5 shrink-0" />
          Your role sees a rolling {data.windowDays}-day window. Days outside it are marked
          unavailable rather than empty — they are not known to be free. Auditor and Higher
          Authority can open any range.
        </p>
      )}

      {/* Grid */}
      {/* One header row plus one row per visible week, each sharing the leftover
          height equally — that is what keeps the month inside a single screen. */}
      <div
        className="grid min-h-0 flex-1 grid-cols-7 gap-px overflow-hidden rounded-lg border bg-border"
        style={{ gridTemplateRows: `auto repeat(${gridDays / 7}, minmax(0, 1fr))` }}
      >
        {WEEKDAYS.map((w) => (
          <div
            key={w}
            className="bg-muted px-2 py-2.5 text-center text-[10px] font-semibold uppercase tracking-[0.12em] text-muted-foreground"
          >
            {w}
          </div>
        ))}
        {days.map((date) => {
          const chips = cells.get(date) ?? []
          const isToday = date === today
          const isSelected = date === selected
          const dim = !inMonth(date)
          const blocked = outOfWindow(date)
          return (
            <button
              key={date}
              type="button"
              onClick={() => setSelected(isSelected ? null : date)}
              aria-pressed={isSelected}
              className={cn(
                'flex min-h-0 flex-col gap-1 overflow-hidden p-1.5 text-left align-top transition-colors',
                'focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring',
                blocked ? 'bg-muted/50' : 'bg-card hover:bg-accent/40',
                dim && 'opacity-45',
                isSelected && 'ring-2 ring-inset ring-secondary',
              )}
            >
              <span
                className={cn(
                  'grid size-6 place-items-center rounded-full text-[13px] tabular-nums',
                  isToday ? 'bg-primary font-semibold text-primary-foreground' : 'text-foreground',
                )}
              >
                {Number(date.slice(8, 10))}
              </span>

              {blocked ? (
                <span className="text-[10px] uppercase tracking-wide text-muted-foreground">
                  Outside window
                </span>
              ) : (
                <div className="flex flex-col gap-1">
                  {chips.slice(0, 3).map((c) => (
                    <BookingChip key={c.key} chip={c} venue={venueName.get(c.booking.venueId) ?? ''} />
                  ))}
                  {chips.length > 3 && (
                    <span className="pl-1 text-[10px] text-muted-foreground">+{chips.length - 3} more</span>
                  )}
                </div>
              )}
            </button>
          )
        })}
      </div>

      {loading && <p className="text-sm text-muted-foreground">Loading…</p>}

      {selected && (
        <DayPanel
          date={selected}
          chips={cells.get(selected) ?? []}
          venueName={venueName}
          blocked={outOfWindow(selected)}
          onClose={() => setSelected(null)}
        />
      )}
    </div>
  )
}

function BookingChip({ chip, venue }: { chip: Chip; venue: string }) {
  const { booking, label, carryover } = chip
  return (
    <span
      className={cn(
        'truncate border-l-2 bg-muted/60 py-0.5 pl-1.5 text-[10px] leading-tight',
        carryover ? CARRYOVER_RULE : (STATUS_RULE[booking.status] ?? STATUS_RULE.confirmed),
      )}
      title={`${booking.guestName} — ${titleCase(booking.subEventName)} · ${venue} · ${label} (${booking.eventCode}, ${titleCase(booking.status)})`}
    >
      <span className="font-medium uppercase">{booking.guestName}</span>
      {venue && <span className="text-muted-foreground"> · {venue}</span>}
    </span>
  )
}

function DayPanel({
  date,
  chips,
  venueName,
  blocked,
  onClose,
}: {
  date: string
  chips: Chip[]
  venueName: Map<string, string>
  blocked: boolean
  onClose: () => void
}) {
  return (
    <div className="rounded-lg border bg-card">
      <div className="flex flex-wrap items-baseline justify-between gap-2 border-b px-4 py-3">
        <div>
          <h2 className="font-medium">{longDate(date)}</h2>
          <p className="text-xs text-muted-foreground">
            {blocked ? 'Outside your window' : `${chips.length} booking${chips.length === 1 ? '' : 's'}`}
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

      {blocked ? (
        <p className="p-4 text-sm text-muted-foreground">
          This date is outside the rolling window your role can open, so nothing is loaded for
          it. It is not necessarily free.
        </p>
      ) : chips.length === 0 ? (
        <p className="p-4 text-sm text-muted-foreground">
          Nothing booked. Enquiries never appear here — the calendar shows locked-in deals only.
        </p>
      ) : (
        <ul className="divide-y">
          {chips.map((c) => (
            <li key={c.key} className="flex flex-wrap items-center justify-between gap-2 px-4 py-2.5 text-sm">
              <div className="min-w-0">
                <span className="font-medium">{c.booking.guestName}</span>
                <span className="text-muted-foreground"> · {titleCase(c.booking.subEventName)}</span>
                <div className="text-xs text-muted-foreground">
                  {venueName.get(c.booking.venueId)} · <span className="tabular-nums">{c.label}</span>
                  {c.carryover && ' · runs past midnight'}
                </div>
              </div>
              <Link
                href={`/bookings/${c.booking.eventId}`}
                className="shrink-0 text-xs text-primary hover:underline"
              >
                {c.booking.eventCode} →
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

function Legend() {
  const items = [
    { label: 'Confirmed', className: 'bg-[var(--chart-2)]' },
    { label: 'In progress', className: 'bg-emerald-500' },
    { label: 'Locked', className: 'bg-primary' },
    { label: 'Carryover', className: 'bg-amber-500' },
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
