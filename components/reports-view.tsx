'use client'

import { useCallback, useEffect, useState } from 'react'
import { Loader2 } from 'lucide-react'
import { toast } from 'sonner'
import { api } from '@/lib/http'
import { formatPaise } from '@/lib/money'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { cn } from '@/lib/utils'

const KINDS = ['pipeline', 'occupancy', 'revenue', 'exceptions', 'maintenance', 'outstanding'] as const
type Kind = (typeof KINDS)[number]
const LABEL: Record<Kind, string> = {
  pipeline: 'Pipeline', occupancy: 'Occupancy', revenue: 'Revenue', exceptions: 'Exceptions', maintenance: 'Maintenance', outstanding: 'Outstanding',
}

export function ReportsView() {
  const [kind, setKind] = useState<Kind>('pipeline')
  const [data, setData] = useState<Record<string, unknown> | null>(null)
  const [busy, setBusy] = useState(false)

  const load = useCallback(async (k: Kind) => {
    setBusy(true)
    try {
      const r = await api<{ data: Record<string, unknown> }>(`/reports/${k}`)
      setData(r.data)
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed to load report')
    } finally {
      setBusy(false)
    }
  }, [])

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    load(kind)
  }, [kind, load])

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap gap-1.5">
        {KINDS.map((k) => (
          <Button key={k} size="sm" variant={k === kind ? 'default' : 'outline'} onClick={() => setKind(k)}>{LABEL[k]}</Button>
        ))}
      </div>
      {busy && !data ? (
        <div className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="size-4 animate-spin" /> Loading…</div>
      ) : (
        <div className={cn(busy && 'opacity-60')}>{data && renderReport(kind, data)}</div>
      )}
    </div>
  )
}

function T({ head, rows }: { head: string[]; rows: (string | number)[][] }) {
  return (
    <div className="overflow-x-auto rounded-lg border">
      <Table>
        <TableHeader><TableRow>{head.map((h, i) => <TableHead key={h} className={i === 0 ? '' : 'text-right'}>{h}</TableHead>)}</TableRow></TableHeader>
        <TableBody>
          {rows.length === 0 ? (
            <TableRow><TableCell colSpan={head.length} className="text-muted-foreground">No data.</TableCell></TableRow>
          ) : rows.map((r, i) => (
            <TableRow key={i}>{r.map((c, j) => <TableCell key={j} className={j === 0 ? '' : 'text-right tabular-nums'}>{c}</TableCell>)}</TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  )
}

function Stat({ label, value }: { label: string; value: string }) {
  return <Card><CardContent className="py-3"><div className="text-xs text-muted-foreground">{label}</div><div className="text-xl font-semibold tabular-nums">{value}</div></CardContent></Card>
}

/* eslint-disable @typescript-eslint/no-explicit-any */
function renderReport(kind: Kind, d: any) {
  switch (kind) {
    case 'pipeline':
      return (
        <div className="space-y-3">
          <div className="grid gap-3 sm:grid-cols-3">
            <Stat label="Total events" value={String(d.total)} />
            <Stat label="Confirmed +" value={String(d.confirmedPlus)} />
            <Stat label="Conversion" value={`${d.conversionRatePct}%`} />
          </div>
          <T head={['Status', 'Count']} rows={d.byStatus.map((r: any) => [r.status.replace(/_/g, ' '), r.n])} />
        </div>
      )
    case 'occupancy':
      return (
        <div className="space-y-4">
          <div><h3 className="mb-1 text-sm font-medium">Bookings by month</h3><T head={['Month', 'Hall', 'Lawn']} rows={d.byMonth.map((r: any) => [r.month, r.hall, r.lawn])} /></div>
          <div><h3 className="mb-1 text-sm font-medium">By venue</h3><T head={['Venue', 'Property', 'Kind', 'Bookings']} rows={d.byVenue.map((r: any) => [r.venueName, r.propertyName, r.kind, r.bookings])} /></div>
        </div>
      )
    case 'revenue':
      return (
        <div className="space-y-4">
          <div className="grid gap-3 sm:grid-cols-4">
            <Stat label="Gross billed" value={formatPaise(d.taxSummary.grossPaise)} />
            <Stat label="Discounts" value={formatPaise(d.taxSummary.discountPaise)} />
            <Stat label="GST" value={formatPaise(d.taxSummary.taxPaise)} />
            <Stat label="Net billed" value={formatPaise(d.taxSummary.netPaise)} />
          </div>
          <div><h3 className="mb-1 text-sm font-medium">By event type</h3><T head={['Event type', 'Events', 'Net']} rows={d.byEventType.map((r: any) => [r.eventType.replace(/_/g, ' '), r.events, formatPaise(r.netPaise)])} /></div>
          <div><h3 className="mb-1 text-sm font-medium">Venue revenue by property</h3><T head={['Property', 'Venue revenue']} rows={d.byProperty.map((r: any) => [r.propertyName, formatPaise(r.venueRevenuePaise)])} /></div>
        </div>
      )
    case 'exceptions':
      return (
        <div className="space-y-3">
          <Stat label="Pending now" value={String(d.pending)} />
          <T head={['Category', 'Outcome', 'Count']} rows={d.rows.map((r: any) => [r.kind.replace(/_/g, ' '), r.status.replace(/_/g, ' '), r.n])} />
        </div>
      )
    case 'maintenance':
      return (
        <div className="space-y-3">
          <Stat label="Total maintenance cost" value={formatPaise(d.totalPaise)} />
          <T head={['Event', 'Guest', 'Entries', 'Total']} rows={d.byEvent.map((r: any) => [r.code, r.guestName, r.entries, formatPaise(r.totalPaise)])} />
        </div>
      )
    case 'outstanding':
      return (
        <div className="space-y-3">
          <div className="grid gap-3 sm:grid-cols-4">
            <Stat label="0–30 days" value={formatPaise(d.buckets.d0_30)} />
            <Stat label="31–60 days" value={formatPaise(d.buckets.d31_60)} />
            <Stat label="61–90 days" value={formatPaise(d.buckets.d61_90)} />
            <Stat label="90+ days" value={formatPaise(d.buckets.d90_plus)} />
          </div>
          <div className="text-sm text-muted-foreground">Total outstanding: <span className="font-medium tabular-nums text-foreground">{formatPaise(d.totalOutstanding)}</span></div>
          <T head={['Invoice', 'Guest', 'Net', 'Paid', 'Balance', 'Age (d)']} rows={d.rows.map((r: any) => [r.invoiceNo ?? r.code, r.guestName, formatPaise(r.netPaise), formatPaise(r.paidPaise), formatPaise(r.balancePaise), r.ageDays])} />
        </div>
      )
  }
}
