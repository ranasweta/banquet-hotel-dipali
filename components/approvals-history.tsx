'use client'

import { useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { Download, Loader2 } from 'lucide-react'
import { toast } from 'sonner'
import { api } from '@/lib/http'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Badge } from '@/components/ui/badge'
import { cn } from '@/lib/utils'

type ExceptionRow = {
  id: string
  kind: string
  status: string
  summary: string
  eventId: string
  eventCode: string
  guestName: string
  eventType: string
  raisedByName: string
  raisedAt: string
  decidedByName: string | null
  decidedAt: string | null
  remark: string | null
}

const KIND_LABEL: Record<string, string> = {
  menu_increase: 'Menu increase',
  room_allocation_35plus: '35+ rooms',
  discount_over_cap: 'Discount over cap',
  overdue_wedding_balance: 'Overdue balance',
  counter_change: 'Counter-change',
}
const STATUS_LABEL: Record<string, string> = {
  approved: 'Approved',
  approved_modified: 'Approved (modified)',
  rejected: 'Rejected',
  pending: 'Pending',
}
const STATUS_STYLES: Record<string, string> = {
  approved: 'bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-200',
  approved_modified: 'bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-200',
  rejected: 'bg-red-100 text-red-700 dark:bg-red-950 dark:text-red-300',
  pending: 'bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-200',
}

const label = (map: Record<string, string>, key: string) => map[key] ?? key.replace(/_/g, ' ')

/** Absolute date of a decision, for the permanent record ("23 Jul 2026"). */
function decidedOn(iso: string): string {
  return new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })
}

/** One CSV field — quoted, with embedded quotes doubled (RFC 4180). */
function csvCell(v: string | null): string {
  return `"${(v ?? '').replace(/"/g, '""')}"`
}

export function ApprovalsHistory() {
  const [rows, setRows] = useState<ExceptionRow[]>([])
  const [loading, setLoading] = useState(true)
  const [kind, setKind] = useState('all')
  const [outcome, setOutcome] = useState('all')
  const [q, setQ] = useState('')

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setLoading(true)
    api<{ exceptions: ExceptionRow[] }>('/approvals/history')
      .then((d) => setRows(d.exceptions))
      .catch((e) => toast.error(e instanceof Error ? e.message : 'Failed to load'))
      .finally(() => setLoading(false))
  }, [])

  // Only offer filters for values that actually occur, so the chips never lie about the data.
  const kinds = useMemo(() => Array.from(new Set(rows.map((r) => r.kind))), [rows])
  const outcomes = useMemo(() => Array.from(new Set(rows.map((r) => r.status))), [rows])

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase()
    return rows.filter((r) => {
      if (kind !== 'all' && r.kind !== kind) return false
      if (outcome !== 'all' && r.status !== outcome) return false
      if (!needle) return true
      return [r.eventCode, r.guestName, r.decidedByName, r.raisedByName, r.summary, r.remark]
        .some((f) => (f ?? '').toLowerCase().includes(needle))
    })
  }, [rows, kind, outcome, q])

  function exportCsv() {
    const header = ['Decided on', 'Booking', 'Guest', 'Type', 'Outcome', 'Raised by', 'Decided by', 'Details', 'Remark']
    const lines = filtered.map((r) =>
      [
        r.decidedAt ? decidedOn(r.decidedAt) : '',
        r.eventCode,
        r.guestName,
        label(KIND_LABEL, r.kind),
        label(STATUS_LABEL, r.status),
        r.raisedByName,
        r.decidedByName ?? '',
        r.summary,
        r.remark ?? '',
      ].map(csvCell).join(','),
    )
    const blob = new Blob([[header.map(csvCell).join(','), ...lines].join('\r\n')], { type: 'text/csv;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = 'approvals-history.csv'
    a.click()
    URL.revokeObjectURL(url)
  }

  if (loading) {
    return <div className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="size-4 animate-spin" /> Loading…</div>
  }

  return (
    <div className="space-y-4">
      {/* Filters */}
      <div className="space-y-3">
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="mr-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">Type</span>
          <FilterChip active={kind === 'all'} onClick={() => setKind('all')}>All</FilterChip>
          {kinds.map((k) => (
            <FilterChip key={k} active={kind === k} onClick={() => setKind(k)}>{label(KIND_LABEL, k)}</FilterChip>
          ))}
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="mr-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">Outcome</span>
          <FilterChip active={outcome === 'all'} onClick={() => setOutcome('all')}>All</FilterChip>
          {outcomes.map((s) => (
            <FilterChip key={s} active={outcome === s} onClick={() => setOutcome(s)}>{label(STATUS_LABEL, s)}</FilterChip>
          ))}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search booking, guest, decider or detail…"
            className="h-9 max-w-xs"
          />
          <span className="text-sm text-muted-foreground">
            {filtered.length} of {rows.length} decision{rows.length === 1 ? '' : 's'}
          </span>
          <Button variant="outline" size="sm" className="ml-auto" onClick={exportCsv} disabled={filtered.length === 0}>
            <Download className="size-4" /> Export CSV
          </Button>
        </div>
      </div>

      {/* Rows */}
      {filtered.length === 0 ? (
        <p className="text-sm text-muted-foreground">{rows.length === 0 ? 'No decisions recorded yet.' : 'No decisions match these filters.'}</p>
      ) : (
        <div className="divide-y rounded-lg border">
          {filtered.map((r) => (
            <div key={r.id} className="flex flex-wrap items-start justify-between gap-x-4 gap-y-1 p-3">
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <Badge variant="outline">{label(KIND_LABEL, r.kind)}</Badge>
                  <span className={cn('rounded-full px-2 py-0.5 text-xs', STATUS_STYLES[r.status] ?? STATUS_STYLES.pending)}>
                    {label(STATUS_LABEL, r.status)}
                  </span>
                  <Link href={`/bookings/${r.eventId}`} className="font-medium tabular-nums hover:underline">{r.eventCode}</Link>
                  <span className="text-sm text-muted-foreground">{r.guestName}</span>
                </div>
                <div className="mt-1 text-sm">{r.summary}</div>
                {r.remark && <div className="mt-0.5 text-xs text-foreground">Remark: “{r.remark}”</div>}
                <div className="mt-0.5 text-xs text-muted-foreground">raised by {r.raisedByName}</div>
              </div>
              <div className="shrink-0 text-right text-xs text-muted-foreground">
                <div className="font-medium text-foreground">{label(STATUS_LABEL, r.status)}</div>
                <div>by {r.decidedByName ?? '—'}</div>
                {r.decidedAt && <div className="tabular-nums">{decidedOn(r.decidedAt)}</div>}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

function FilterChip({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={cn(
        'rounded-full border px-3 py-1 text-xs transition-colors',
        'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring',
        active ? 'border-primary bg-primary text-primary-foreground' : 'border-input text-muted-foreground hover:bg-muted',
      )}
    >
      {children}
    </button>
  )
}
