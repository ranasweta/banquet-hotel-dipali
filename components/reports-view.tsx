'use client'

import { useCallback, useEffect, useState } from 'react'
import { Loader2 } from 'lucide-react'
import { toast } from 'sonner'
import { api } from '@/lib/http'
import { formatPaise } from '@/lib/money'
import { titleCase } from '@/lib/text'
import { Donut, Hero, Meter, RankBars, StatTile } from '@/components/report-charts'
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

const KINDS = ['overview', 'pipeline', 'occupancy', 'revenue', 'exceptions', 'maintenance', 'outstanding'] as const
type Kind = (typeof KINDS)[number]
const LABEL: Record<Kind, string> = {
  overview: 'Overview', pipeline: 'Pipeline', occupancy: 'Occupancy', revenue: 'Revenue', exceptions: 'Exceptions', maintenance: 'Maintenance', outstanding: 'Outstanding',
}

/* The pipeline is a funnel, so its colours are one hue getting stronger as a proposal
   advances — a reader sees the order in the colour. Cancelled leaves the funnel, so it wears
   the neutral instead of a step of the ramp. */
const STAGE_COLOR: Record<string, string> = {
  enquiry: 'var(--stage-1)',
  confirmed: 'var(--stage-2)',
  running: 'var(--stage-3)',
  delivered: 'var(--stage-4)',
  cancelled: 'var(--muted-foreground)',
}

export function ReportsView() {
  const [kind, setKind] = useState<Kind>('overview')
  // Track which kind the loaded data belongs to, so a tab switch never renders the previous
  // report's shape against the new kind (and a slow response can't overwrite a newer one).
  const [result, setResult] = useState<{ kind: Kind; data: Record<string, unknown> } | null>(null)
  const [busy, setBusy] = useState(false)

  const load = useCallback(async (k: Kind) => {
    setBusy(true)
    try {
      const r = await api<{ data: Record<string, unknown> }>(`/reports/${k}`)
      setResult({ kind: k, data: r.data })
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

  const shown = result && result.kind === kind ? result.data : null

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap gap-1.5">
        {KINDS.map((k) => (
          <Button key={k} size="sm" variant={k === kind ? 'default' : 'outline'} onClick={() => setKind(k)}>{LABEL[k]}</Button>
        ))}
      </div>
      {!shown ? (
        <div className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="size-4 animate-spin" /> Loading…</div>
      ) : (
        <div className={cn(busy && 'opacity-60')}>{renderReport(kind, shown)}</div>
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

/** A titled block on the overview. `note` carries the caveat that keeps a figure honest. */
function Panel({ title, note, children }: { title: string; note?: string; children: React.ReactNode }) {
  return (
    <Card>
      <CardContent className="space-y-3 py-4">
        <div>
          <h3 className="text-sm font-medium">{title}</h3>
          {note && <p className="mt-0.5 text-xs text-muted-foreground">{note}</p>}
        </div>
        {children}
      </CardContent>
    </Card>
  )
}

function Empty({ children }: { children: React.ReactNode }) {
  return <p className="py-6 text-center text-sm text-muted-foreground">{children}</p>
}

/* eslint-disable @typescript-eslint/no-explicit-any */
function renderReport(kind: Kind, d: any) {
  switch (kind) {
    case 'overview': {
      const venues = d.venues.slice(0, 8)
      const hidden = d.venues.length - venues.length
      return (
        <div className="space-y-4">
          {/* One hero figure, then the numbers that qualify it. Conversion is counted over
              EVERY proposal ever raised — the same way the Pipeline tab counts it — so the
              two tabs can never print different percentages. */}
          <div className="grid gap-3 lg:grid-cols-3">
            <Hero
              value={`${d.conversionRatePct}%`}
              label="Conversion"
              sub={`${d.won} of ${d.total} proposals reached confirmed or beyond`}
            />
            <div className="grid gap-3 sm:grid-cols-2 lg:col-span-2">
              <StatTile label="Proposals raised" value={String(d.total)} hint="every enquiry, all time" />
              <StatTile label="Open enquiry value" value={formatPaise(d.openValuePaise)} hint="venue + food + add-ons, before tax and discounts" />
              <StatTile label="Booked value" value={formatPaise(d.wonValuePaise)} hint="confirmed and beyond, on the same basis" />
              <StatTile label="Advances received" value={formatPaise(d.collectedPaise)} hint={`${d.receipts} receipt${d.receipts === 1 ? '' : 's'} recorded`} />
            </div>
          </div>

          <div className="grid gap-3 lg:grid-cols-2">
            <Panel title="Where the proposals stand" note="Every booking on the books, by stage.">
              {d.stages.length === 0 ? (
                <Empty>No proposals yet.</Empty>
              ) : (
                <Donut
                  segments={d.stages.map((s: any) => ({ label: s.label, value: s.n, color: STAGE_COLOR[s.key] }))}
                  centerValue={String(d.total)}
                  centerLabel="proposals"
                  ariaLabel={`Proposals by stage: ${d.stages.map((s: any) => `${s.label} ${s.n}`).join(', ')}`}
                />
              )}
            </Panel>

            {/* Demand, deliberately: enquiries count. Occupancy answers the other question —
                what was actually confirmed — and this would say the same thing twice if it
                filtered the same way. Bundles rank as themselves; they are what was sold. */}
            <Panel
              title="Most asked-for venues"
              note={`Functions on live proposals, enquiries included.${hidden > 0 ? ` Top ${venues.length} of ${d.venues.length} — the rest are in Occupancy.` : ''}`}
            >
              {venues.length === 0 ? (
                <Empty>No functions with a venue yet.</Empty>
              ) : (
                <RankBars
                  unit="functions"
                  rows={venues.map((v: any) => ({
                    label: v.name,
                    value: v.functions,
                    note: v.property ? `${v.kind} · ${v.property}` : v.kind,
                  }))}
                />
              )}
            </Panel>
          </div>

          <Panel
            title="Booking managers"
            note="Everyone who has raised a proposal, ranked by how many they converted. Someone joining appears with their first proposal. A small number of proposals makes a conversion rate noisy — read the counts beside it."
          >
            {d.managers.length === 0 ? (
              <Empty>No proposals have been raised yet.</Empty>
            ) : (
              <div className="overflow-x-auto">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead className="w-8">#</TableHead>
                      <TableHead>Manager</TableHead>
                      <TableHead className="text-right">Raised</TableHead>
                      <TableHead className="text-right">Converted</TableHead>
                      <TableHead className="w-40">Conversion</TableHead>
                      <TableHead className="text-right">Booked value</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {d.managers.map((m: any, i: number) => (
                      <TableRow key={m.name}>
                        <TableCell className="text-muted-foreground tabular-nums">{i + 1}</TableCell>
                        <TableCell className="font-medium">
                          {titleCase(m.name)}
                          {/* A manager who has left keeps their history — the proposals are
                              still theirs — but the reader should know they are gone. */}
                          {!m.isActive && <span className="ml-1.5 text-xs font-normal text-muted-foreground">disabled</span>}
                        </TableCell>
                        <TableCell className="text-right tabular-nums">{m.proposals}</TableCell>
                        <TableCell className="text-right tabular-nums">{m.won}</TableCell>
                        <TableCell>
                          <Meter
                            pct={m.proposals > 0 ? (m.won / m.proposals) * 100 : 0}
                            label={`${m.won} of ${m.proposals} converted`}
                          />
                        </TableCell>
                        <TableCell className="text-right tabular-nums">{formatPaise(m.wonValuePaise)}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            )}
          </Panel>

          <Panel title="What the hotel is asked for" note="Live proposals by event type.">
            {d.byType.length === 0 ? (
              <Empty>No proposals yet.</Empty>
            ) : (
              <RankBars unit="proposals" rows={d.byType.map((t: any) => ({ label: titleCase(t.label), value: t.n }))} />
            )}
          </Panel>
        </div>
      )
    }
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
          {/* Two GST figures, because the documents carry two. The GST on rooms is collected —
              5% up to ₹7,500 a night and 18% above it (client, 17 Aug 2026) — and sits inside
              "Net billed"; the other 18% is printed on every bill and taken from nobody
              (client, 4 Aug 2026), so it is shown apart rather than summed into anything here. */}
          <div className="grid gap-3 sm:grid-cols-5">
            <Stat label="Gross billed" value={formatPaise(d.taxSummary.grossPaise)} />
            <Stat label="Discounts" value={formatPaise(d.taxSummary.discountPaise)} />
            <Stat label="GST collected (rooms)" value={formatPaise(d.taxSummary.taxPaise)} />
            <Stat label="GST shown, not taken (18%)" value={formatPaise(d.taxSummary.shownTaxPaise)} />
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
