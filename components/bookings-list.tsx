'use client'

import { useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { toast } from 'sonner'
import { api } from '@/lib/http'
import { formatPaise } from '@/lib/money'
import { todayISO } from '@/lib/time'
import { cn } from '@/lib/utils'
import { buttonVariants } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { DownloadPdfButton } from '@/components/download-pdf-button'
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
  proposalTotalPaise: number
  stale: boolean
}

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
  const [loading, setLoading] = useState(true)
  const [filter, setFilter] = useState('all')

  useEffect(() => {
    api<{ events: EventRow[] }>('/events')
      .then((r) => setEvents(r.events))
      .catch((e) => toast.error(e instanceof Error ? e.message : 'Failed to load'))
      .finally(() => setLoading(false))
  }, [])

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
        {canCreate && (
          <Link href="/bookings/new" className={buttonVariants()}>
            New proposal
          </Link>
        )}
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
                  {events.length === 0
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
                  <TableCell>{e.guestName}</TableCell>
                  <TableCell className="capitalize">{e.eventType.replace(/_/g, ' ')}</TableCell>
                  <TableCell className="tabular-nums text-muted-foreground">
                    {e.firstDate ? `${e.firstDate}${e.lastDate && e.lastDate !== e.firstDate ? ` → ${e.lastDate}` : ''}` : '—'}
                  </TableCell>
                  <TableCell>
                    <span className={`inline-block rounded-full px-2 py-0.5 text-xs ${STATUS_STYLES[e.status] ?? STATUS_STYLES.enquiry}`}>
                      {e.status.replace(/_/g, ' ')}
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
                      {/* A shareable PDF exists only once the proposal is priced (confirmed+). */}
                      {['confirmed', 'in_progress', 'completed'].includes(e.status) && (
                        <DownloadPdfButton eventId={e.id} label="PDF" className="text-xs text-primary hover:underline" />
                      )}
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
