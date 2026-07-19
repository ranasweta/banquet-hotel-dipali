'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { toast } from 'sonner'
import { api } from '@/lib/http'
import { formatPaise } from '@/lib/money'
import { buttonVariants } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
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
  enquiry: 'bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-300',
  confirmed: 'bg-blue-100 text-blue-800 dark:bg-blue-950 dark:text-blue-200',
  in_progress: 'bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-200',
  cancelled: 'bg-red-100 text-red-700 dark:bg-red-950 dark:text-red-300',
}

export function BookingsList({ canCreate }: { canCreate: boolean }) {
  const [events, setEvents] = useState<EventRow[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    api<{ events: EventRow[] }>('/events')
      .then((r) => setEvents(r.events))
      .catch((e) => toast.error(e instanceof Error ? e.message : 'Failed to load'))
      .finally(() => setLoading(false))
  }, [])

  return (
    <div className="space-y-4">
      {canCreate && (
        <div className="flex justify-end">
          <Link href="/bookings/new" className={buttonVariants()}>
            New proposal
          </Link>
        </div>
      )}
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
            </TableRow>
          </TableHeader>
          <TableBody>
            {loading ? (
              <TableRow>
                <TableCell colSpan={6} className="text-muted-foreground">Loading…</TableCell>
              </TableRow>
            ) : events.length === 0 ? (
              <TableRow>
                <TableCell colSpan={6} className="text-muted-foreground">
                  No proposals yet.{canCreate ? ' Start one with “New proposal”.' : ''}
                </TableCell>
              </TableRow>
            ) : (
              events.map((e) => (
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
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </div>
    </div>
  )
}
