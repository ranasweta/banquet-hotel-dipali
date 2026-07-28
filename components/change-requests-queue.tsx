'use client'

import { useCallback, useEffect, useState } from 'react'
import Link from 'next/link'
import { Check, Loader2, X } from 'lucide-react'
import { toast } from 'sonner'
import { api } from '@/lib/http'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Card, CardContent } from '@/components/ui/card'
import { cn } from '@/lib/utils'
import { titleCase } from '@/lib/text'

type CR = {
  id: string
  summary: string
  status: string
  reason: string | null
  remark: string | null
  eventId: string
  eventCode: string
  guestName: string
  requestedByName: string
  requestedAt: string
}

const STATUS: Record<string, string> = {
  pending: 'bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-200',
  approved: 'bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-200',
  rejected: 'bg-red-100 text-red-700 dark:bg-red-950 dark:text-red-300',
}

export function ChangeRequestsQueue({ canDecide }: { canDecide: boolean }) {
  const [rows, setRows] = useState<CR[]>([])
  const [showAll, setShowAll] = useState(false)
  const [loading, setLoading] = useState(true)

  const load = useCallback(async () => {
    const r = await api<{ changeRequests: CR[] }>(`/change-requests${showAll ? '' : '?status=pending'}`)
    setRows(r.changeRequests)
  }, [showAll])

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setLoading(true)
    load().catch((e) => toast.error(e instanceof Error ? e.message : 'Failed to load')).finally(() => setLoading(false))
  }, [load])

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold">{showAll ? 'All change requests' : 'Pending'}</h2>
        <Button variant="ghost" size="sm" onClick={() => setShowAll((v) => !v)}>{showAll ? 'Pending only' : 'Show all'}</Button>
      </div>
      {loading ? (
        <div className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="size-4 animate-spin" /> Loading…</div>
      ) : rows.length === 0 ? (
        <p className="text-sm text-muted-foreground">{showAll ? 'No change requests.' : 'Nothing awaiting a decision. 🎉'}</p>
      ) : (
        rows.map((cr) => <CRCard key={cr.id} cr={cr} canDecide={canDecide && cr.status === 'pending'} onDone={load} />)
      )}
    </div>
  )
}

function CRCard({ cr, canDecide, onDone }: { cr: CR; canDecide: boolean; onDone: () => Promise<void> }) {
  const [busy, setBusy] = useState(false)
  const [rejecting, setRejecting] = useState(false)
  const [remark, setRemark] = useState('')

  async function decide(action: 'approve' | 'reject') {
    if (action === 'reject' && !remark.trim()) { toast.error('A remark is required to reject'); return }
    setBusy(true)
    try {
      await api(`/change-requests/${cr.id}/decide`, { method: 'POST', body: JSON.stringify({ action, remark: remark.trim() || undefined }) })
      toast.success(`${cr.eventCode}: ${action === 'approve' ? 'approved' : 'rejected'}`)
      await onDone()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Decision failed')
    } finally {
      setBusy(false)
    }
  }

  return (
    <Card>
      <CardContent className="py-3">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <span className={cn('rounded-full px-2 py-0.5 text-xs', STATUS[cr.status])}>{titleCase(cr.status)}</span>
              <Link href={`/bookings/${cr.eventId}`} className="font-medium tabular-nums hover:underline">{cr.eventCode}</Link>
              <span className="text-sm text-muted-foreground">{titleCase(cr.guestName)}</span>
            </div>
            <div className="mt-1 text-sm">{cr.summary}</div>
            <div className="mt-0.5 text-xs text-muted-foreground">
              by {cr.requestedByName}{cr.reason && ` · “${cr.reason}”`}{cr.remark && <span className="text-foreground"> · decision: “{cr.remark}”</span>}
            </div>
          </div>
          {canDecide && (
            <div className="flex shrink-0 items-center gap-1.5">
              {!rejecting ? (
                <>
                  <Button size="sm" disabled={busy} onClick={() => decide('approve')}><Check className="size-3.5" /> Approve</Button>
                  <Button size="sm" variant="destructive" disabled={busy} onClick={() => setRejecting(true)}><X className="size-3.5" /> Reject</Button>
                </>
              ) : (
                <>
                  <Input placeholder="Reason (required)" value={remark} onChange={(e) => setRemark(e.target.value)} className="h-7 w-56" autoFocus />
                  <Button size="sm" variant="destructive" disabled={busy} onClick={() => decide('reject')}>{busy && <Loader2 className="size-3.5 animate-spin" />} Confirm</Button>
                  <Button size="sm" variant="ghost" disabled={busy} onClick={() => { setRejecting(false); setRemark('') }}>Cancel</Button>
                </>
              )}
            </div>
          )}
        </div>
      </CardContent>
    </Card>
  )
}
