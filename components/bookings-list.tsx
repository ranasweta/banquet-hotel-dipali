'use client'

import { useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { Search } from 'lucide-react'
import { toast } from 'sonner'
import { api } from '@/lib/http'
import { formatPaise } from '@/lib/money'
import { titleCase } from '@/lib/text'
import { todayISO } from '@/lib/time'
import { cn } from '@/lib/utils'
import { buttonVariants } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'

type EventRow = {
  id: string
  code: string
  guestName: string
  eventType: string
  status: string
  firstDate: string | null
  lastDate: string | null
  /** When the booking actually runs — its functions' span, not the confirm-time cache. */
  startDate: string | null
  endDate: string | null
  proposalTotalPaise: number
  stale: boolean
}
type EventTypeOption = { code: string; displayName: string }

const STATUS_STYLES: Record<string, string> = {
  enquiry: 'bg-muted text-muted-foreground',
  confirmed: 'bg-[var(--chart-2)]/15 text-[var(--chart-5)] dark:text-[var(--chart-2)]',
  in_progress: 'bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-200',
  cancelled: 'bg-red-100 text-red-700 dark:bg-red-950 dark:text-red-300',
}

// The heading filters (tester, 23 Jul 2026). "Upcoming" is future-dated proposals specifically,
// the rest are plain status filters. Applied client-side over the already-fetched list.
const FILTERS: { value: string; label: string }[] = [
  { value: 'all', label: 'All' },
  { value: 'upcoming', label: 'Upcoming' },
  { value: 'enquiry', label: 'Enquiry' },
  { value: 'confirmed', label: 'Confirmed' },
  { value: 'in_progress', label: 'In progress' },
  { value: 'completed', label: 'Completed' },
  { value: 'cancelled', label: 'Cancelled' },
]

export function BookingsList({ canCreate, canEditConfirmed }: { canCreate: boolean; canEditConfirmed: boolean }) {
  const [events, setEvents] = useState<EventRow[]>([])
  const [types, setTypes] = useState<EventTypeOption[]>([])
  const [loading, setLoading] = useState(true)
  const [filter, setFilter] = useState('all')

  // Searched and filtered SERVER-side (client, 22 Aug 2026: "so we can type name of the client
  // and search"). The list is capped at 200 rows, so filtering what the browser happens to hold
  // would search only the newest proposals — the opposite of what looking for an old one needs.
  const [query, setQuery] = useState('')
  const [eventType, setEventType] = useState('')
  const [from, setFrom] = useState('')
  const [to, setTo] = useState('')
  /** The typed query, settled. Refetching on every keystroke is a request per letter. */
  const [debouncedQuery, setDebouncedQuery] = useState('')

  useEffect(() => {
    const t = setTimeout(() => setDebouncedQuery(query.trim()), 300)
    return () => clearTimeout(t)
  }, [query])

  useEffect(() => {
    const p = new URLSearchParams()
    if (debouncedQuery) p.set('q', debouncedQuery)
    if (eventType) p.set('type', eventType)
    if (from) p.set('from', from)
    if (to) p.set('to', to)
    const qs = p.toString()
    let live = true
    // The spinner has to be up before the request leaves, not after it returns — otherwise the
    // old rows sit there looking current while a new search is in flight.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setLoading(true)
    api<{ events: EventRow[]; eventTypes: EventTypeOption[] }>(`/events${qs ? `?${qs}` : ''}`)
      .then((r) => {
        if (!live) return
        setEvents(r.events)
        setTypes(r.eventTypes)
      })
      .catch((e) => { if (live) toast.error(e instanceof Error ? e.message : 'Failed to load') })
      .finally(() => { if (live) setLoading(false) })
    // `live` drops a slow response that a newer search has already overtaken, or the list
    // flickers back to the previous query's rows.
    return () => { live = false }
  }, [debouncedQuery, eventType, from, to])

  const filtersOn = Boolean(debouncedQuery || eventType || from || to)
  function clearFilters() {
    setQuery('')
    setEventType('')
    setFrom('')
    setTo('')
  }

  const shown = useMemo(() => {
    const today = todayISO()
    return events.filter((e) => {
      if (filter === 'all') return true
      // Future-dated: the first function is today or later. Functionless enquiries (no date)
      // are not "upcoming" by date and fall out here, as intended.
      if (filter === 'upcoming') return e.firstDate != null && e.firstDate >= today
      return e.status === filter
    })
  }, [events, filter])

  return (
    <div className="space-y-4">
      <div className="grid gap-3 rounded-lg border bg-card p-3 sm:grid-cols-2 lg:grid-cols-[1fr_12rem_10rem_10rem]">
        <div className="space-y-1">
          <Label htmlFor="q" className="text-xs">Search</Label>
          <div className="relative">
            <Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
            <Input
              id="q"
              className="pl-8"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Guest name or code — e.g. Sharma, E-1065"
            />
          </div>
        </div>
        <div className="space-y-1">
          <Label htmlFor="type" className="text-xs">Event</Label>
          <select
            id="type"
            className="h-9 w-full rounded-md border bg-background px-2 text-sm"
            value={eventType}
            onChange={(e) => setEventType(e.target.value)}
          >
            <option value="">All events</option>
            {types.map((t) => (
              <option key={t.code} value={t.code}>{t.displayName}</option>
            ))}
          </select>
        </div>
        {/* Dates OVERLAP the range rather than sit inside it, so a wedding running 28–30 Jan is
            found by a search for the 29th. Either end may be left blank for an open range. */}
        <div className="space-y-1">
          <Label htmlFor="from" className="text-xs">From</Label>
          <Input id="from" type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
        </div>
        <div className="space-y-1">
          <Label htmlFor="to" className="text-xs">To</Label>
          <Input id="to" type="date" min={from || undefined} value={to} onChange={(e) => setTo(e.target.value)} />
        </div>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-0.5 rounded-lg border bg-card p-0.5">
          {FILTERS.map((f) => (
            <button
              key={f.value}
              type="button"
              onClick={() => setFilter(f.value)}
              className={cn(
                'rounded-md px-3 py-1 text-sm transition-colors',
                filter === f.value
                  ? 'bg-primary text-primary-foreground'
                  : 'text-muted-foreground hover:text-foreground',
              )}
            >
              {f.label}
            </button>
          ))}
        </div>
        <div className="flex items-center gap-3">
          {filtersOn && (
            <button type="button" onClick={clearFilters} className="text-sm text-muted-foreground hover:text-foreground">
              Clear filters
            </button>
          )}
          {canCreate && (
            <Link href="/bookings/new" className={buttonVariants()}>
              New proposal
            </Link>
          )}
        </div>
      </div>
      <div className="overflow-x-auto rounded-lg border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Code</TableHead>
              <TableHead>Guest</TableHead>
              <TableHead>Type</TableHead>
              <TableHead>Dates</TableHead>
              <TableHead>Status</TableHead>
              <TableHead className="text-right">Proposal</TableHead>
              <TableHead className="text-right">Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {loading ? (
              <TableRow>
                <TableCell colSpan={7} className="text-muted-foreground">Loading…</TableCell>
              </TableRow>
            ) : shown.length === 0 ? (
              <TableRow>
                <TableCell colSpan={7} className="text-muted-foreground">
                  {filtersOn
                    ? 'No proposals match this search.'
                    : events.length === 0
                      ? `No proposals yet.${canCreate ? ' Start one with “New proposal”.' : ''}`
                      : 'No proposals match this filter.'}
                </TableCell>
              </TableRow>
            ) : (
              shown.map((e) => (
                <TableRow key={e.id}>
                  <TableCell className="font-medium tabular-nums">
                    <Link href={`/bookings/${e.id}`} className="text-primary hover:underline">
                      {e.code}
                    </Link>
                  </TableCell>
                  <TableCell>{titleCase(e.guestName)}</TableCell>
                  <TableCell>{titleCase(e.eventType)}</TableCell>
                  <TableCell className="tabular-nums text-muted-foreground">
                    {/* The functions' own span, so a proposal found by date can show the dates
                        that found it. `first_date` is a confirm-time cache and is often NULL. */}
                    {e.startDate
                      ? `${e.startDate}${e.endDate && e.endDate !== e.startDate ? ` → ${e.endDate}` : ''}`
                      : '—'}
                  </TableCell>
                  <TableCell>
                    <span className={`inline-block rounded-full px-2 py-0.5 text-xs ${STATUS_STYLES[e.status] ?? STATUS_STYLES.enquiry}`}>
                      {titleCase(e.status)}
                    </span>
                    {e.stale && <Badge variant="outline" className="ml-2 text-amber-600">stale</Badge>}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {e.proposalTotalPaise > 0 ? formatPaise(e.proposalTotalPaise) : '—'}
                  </TableCell>
                  <TableCell className="text-right">
                    <div className="flex justify-end gap-3 whitespace-nowrap">
                      {/* View opens the complete proposal for any status; Edit reopens the wizard
                          and is only for enquiries (confirmed changes go via change-requests). */}
                      <Link href={`/bookings/${e.id}`} className="text-xs text-primary hover:underline">
                        View
                      </Link>
                      {((e.status === 'enquiry' && canCreate) || (e.status === 'confirmed' && canEditConfirmed)) && (
                        <Link href={`/bookings/${e.id}/edit`} className="text-xs text-primary hover:underline">
                          Edit
                        </Link>
                      )}
                      {/* The proposal Draft prints at any stage — enquiry (Draft) or confirmed
                          (Draft 2); Save-as-PDF from the print dialog makes the shareable file. */}
                      <Link href={`/bookings/${e.id}/proforma`} className="text-xs text-primary hover:underline">
                        Draft
                      </Link>
                    </div>
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </div>
    </div>
  )
}
