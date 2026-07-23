'use client'

import { useCallback, useEffect, useState } from 'react'
import Link from 'next/link'
import { Check, Loader2, X } from 'lucide-react'
import { toast } from 'sonner'
import { api } from '@/lib/http'
import { formatPaise } from '@/lib/money'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Badge } from '@/components/ui/badge'
import { Card, CardContent } from '@/components/ui/card'
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
type Dashboard = {
  pendingCount: number
  byKind: { kind: string; n: number }[]
  upcomingHighValue: { id: string; code: string; guestName: string; firstDate: string | null; proposalTotalPaise: number }[]
}

const KIND_LABEL: Record<string, string> = {
  menu_increase: 'Menu increase',
  room_allocation_35plus: '35+ rooms',
  discount_over_cap: 'Discount over cap',
  overdue_wedding_balance: 'Overdue balance',
}
const STATUS_STYLES: Record<string, string> = {
  pending: 'bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-200',
  approved: 'bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-200',
  approved_modified: 'bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-200',
  rejected: 'bg-red-100 text-red-700 dark:bg-red-950 dark:text-red-300',
}

/** Age of an exception from its raised_at (real wall-clock, matching the DB's now()). */
function age(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime()
  if (ms < 3_600_000) return 'just now'
  if (ms < 86_400_000) return `${Math.floor(ms / 3_600_000)}h ago`
  return `${Math.floor(ms / 86_400_000)}d ago`
}

/** Absolute date of a decision, for the permanent record ("23 Jul 2026"). */
function decidedOn(iso: string): string {
  return new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })
}

export function ApprovalsQueue({ canDecide }: { canDecide: boolean }) {
  const [rows, setRows] = useState<ExceptionRow[]>([])
  const [dash, setDash] = useState<Dashboard | null>(null)
  const [showAll, setShowAll] = useState(false)
  const [loading, setLoading] = useState(true)

  const load = useCallback(async () => {
    const [ex, d] = await Promise.all([
      api<{ exceptions: ExceptionRow[] }>(`/exceptions${showAll ? '' : '?status=pending'}`),
      api<Dashboard>('/approvals/dashboard'),
    ])
    setRows(ex.exceptions)
    setDash(d)
  }, [showAll])

  useEffect(() => {
    // Reload the queue whenever the filter changes; state is seeded after the fetch.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setLoading(true)
    load()
      .catch((e) => toast.error(e instanceof Error ? e.message : 'Failed to load'))
      .finally(() => setLoading(false))
  }, [load])

  return (
    <div className="space-y-6">
      {dash && (
        <div className="grid gap-3 sm:grid-cols-3">
          <Card>
            <CardContent className="py-3">
              <div className="text-xs text-muted-foreground">Pending approvals</div>
              <div className="text-2xl font-semibold tabular-nums">{dash.pendingCount}</div>
              <div className="mt-1 flex flex-wrap gap-1">
                {dash.byKind.map((k) => (
                  <Badge key={k.kind} variant="outline" className="text-xs">{KIND_LABEL[k.kind] ?? k.kind}: {k.n}</Badge>
                ))}
              </div>
            </CardContent>
          </Card>
          <Card className="sm:col-span-2">
            <CardContent className="py-3">
              <div className="mb-1 text-xs text-muted-foreground">Biggest upcoming events</div>
              {dash.upcomingHighValue.length === 0 ? (
                <div className="text-sm text-muted-foreground">None</div>
              ) : (
                <ul className="space-y-0.5 text-sm">
                  {dash.upcomingHighValue.map((e) => (
                    <li key={e.id} className="flex items-center justify-between gap-2">
                      <Link href={`/bookings/${e.id}`} className="hover:underline">
                        <span className="font-medium tabular-nums">{e.code}</span> · {e.guestName}
                        {e.firstDate && <span className="text-muted-foreground"> · {e.firstDate}</span>}
                      </Link>
                      <span className="tabular-nums">{formatPaise(e.proposalTotalPaise)}</span>
                    </li>
                  ))}
                </ul>
              )}
            </CardContent>
          </Card>
        </div>
      )}

      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold">{showAll ? 'All exceptions' : 'Pending queue'}</h2>
        <Button variant="ghost" size="sm" onClick={() => setShowAll((v) => !v)}>
          {showAll ? 'Show pending only' : 'Show all (incl. decided)'}
        </Button>
      </div>

      {loading ? (
        <div className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="size-4 animate-spin" /> Loading…</div>
      ) : rows.length === 0 ? (
        <p className="text-sm text-muted-foreground">{showAll ? 'No exceptions.' : 'Nothing awaiting approval. 🎉'}</p>
      ) : (
        <div className="space-y-2">
          {rows.map((r) => (
            <ExceptionCard key={r.id} row={r} canDecide={canDecide} onDecided={load} />
          ))}
        </div>
      )}
    </div>
  )
}

function ExceptionCard({ row, canDecide, onDecided }: { row: ExceptionRow; canDecide: boolean; onDecided: () => Promise<void> }) {
  const [busy, setBusy] = useState(false)
  const [rejecting, setRejecting] = useState(false)
  const [remark, setRemark] = useState('')
  const [picks, setPicks] = useState('1')
  const [countering, setCountering] = useState(false)
  const [counterReason, setCounterReason] = useState('')

  async function raiseCounter() {
    if (!counterReason.trim()) {
      toast.error('A reason is required')
      return
    }
    setBusy(true)
    try {
      await api(`/exceptions/${row.id}/counter`, {
        method: 'POST',
        body: JSON.stringify({ reason: counterReason.trim() }),
      })
      toast.success(`${row.eventCode}: counter-change raised`)
      await onDecided()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not raise counter-change')
    } finally {
      setBusy(false)
    }
  }

  async function decide(action: 'approve' | 'reject' | 'approve_modified', modified?: Record<string, unknown>) {
    if (action === 'reject' && !remark.trim()) {
      toast.error('A remark is required to reject')
      return
    }
    setBusy(true)
    try {
      const res = await api<{ decision: { status: string; applied: string } }>(`/exceptions/${row.id}/decide`, {
        method: 'POST',
        body: JSON.stringify({ action, remark: remark.trim() || undefined, modified }),
      })
      toast.success(`${row.eventCode}: ${res.decision.status.replace('_', ' ')}${res.decision.applied !== 'none' ? ` — ${res.decision.applied}` : ''}`)
      await onDecided()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Decision failed')
    } finally {
      setBusy(false)
    }
  }

  const isMenu = row.kind === 'menu_increase'

  return (
    <Card>
      <CardContent className="py-3">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <Badge variant="outline">{KIND_LABEL[row.kind] ?? row.kind}</Badge>
              <span className={cn('rounded-full px-2 py-0.5 text-xs', STATUS_STYLES[row.status] ?? STATUS_STYLES.pending)}>
                {row.status.replace('_', ' ')}
              </span>
              <Link href={`/bookings/${row.eventId}`} className="font-medium tabular-nums hover:underline">{row.eventCode}</Link>
              <span className="text-sm text-muted-foreground">{row.guestName}</span>
            </div>
            <div className="mt-1 text-sm">{row.summary}</div>
            <div className="mt-0.5 text-xs text-muted-foreground">
              raised by {row.raisedByName} · {age(row.raisedAt)}
              {row.status !== 'pending' && (
                <span>
                  {' · '}
                  {row.status.replace('_', ' ')} by {row.decidedByName ?? '—'}
                  {row.decidedAt ? ` on ${decidedOn(row.decidedAt)}` : ''}
                </span>
              )}
              {row.remark && <span className="text-foreground"> · remark: “{row.remark}”</span>}
            </div>
          </div>

          {canDecide && row.status === 'pending' && (
            <div className="flex shrink-0 flex-col items-end gap-2">
              {!rejecting ? (
                <div className="flex items-center gap-1.5">
                  {isMenu && (
                    <Input
                      value={picks}
                      onChange={(e) => setPicks(e.target.value)}
                      className="h-7 w-12 text-center"
                      inputMode="numeric"
                      aria-label="extra picks"
                    />
                  )}
                  <Button
                    size="sm"
                    disabled={busy}
                    onClick={() =>
                      isMenu && Number(picks) !== 1
                        ? decide('approve_modified', { extraPicks: Number(picks) })
                        : decide('approve')
                    }
                  >
                    <Check className="size-3.5" /> Approve{isMenu && Number(picks) !== 1 ? ` +${picks}` : ''}
                  </Button>
                  <Button size="sm" variant="destructive" disabled={busy} onClick={() => setRejecting(true)}>
                    <X className="size-3.5" /> Reject
                  </Button>
                </div>
              ) : (
                <div className="flex items-center gap-1.5">
                  <Input
                    placeholder="Reason for rejection (required)"
                    value={remark}
                    onChange={(e) => setRemark(e.target.value)}
                    className="h-7 w-64"
                    autoFocus
                  />
                  <Button size="sm" variant="destructive" disabled={busy} onClick={() => decide('reject')}>
                    {busy && <Loader2 className="size-3.5 animate-spin" />} Confirm
                  </Button>
                  <Button size="sm" variant="ghost" disabled={busy} onClick={() => { setRejecting(false); setRemark('') }}>Cancel</Button>
                </div>
              )}
            </div>
          )}

          {/* A settled decision is never edited — the Authority revises it by raising a new,
              linked counter-change with a reason (tester, 23 Jul 2026). Not offered on a
              counter-change itself, to avoid endless chains. */}
          {canDecide && row.status !== 'pending' && row.kind !== 'counter_change' && (
            <div className="flex shrink-0 flex-col items-end gap-2">
              {!countering ? (
                <Button size="sm" variant="outline" disabled={busy} onClick={() => setCountering(true)}>
                  Raise counter-change
                </Button>
              ) : (
                <div className="flex items-center gap-1.5">
                  <Input
                    placeholder="What to change & why (required)"
                    value={counterReason}
                    onChange={(e) => setCounterReason(e.target.value)}
                    className="h-7 w-72"
                    autoFocus
                  />
                  <Button size="sm" disabled={busy} onClick={raiseCounter}>
                    {busy && <Loader2 className="size-3.5 animate-spin" />} Raise
                  </Button>
                  <Button size="sm" variant="ghost" disabled={busy} onClick={() => { setCountering(false); setCounterReason('') }}>Cancel</Button>
                </div>
              )}
            </div>
          )}
        </div>
      </CardContent>
    </Card>
  )
}
