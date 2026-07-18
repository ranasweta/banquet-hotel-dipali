'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { Loader2, Lock, Paperclip, Plus, Trash2 } from 'lucide-react'
import { toast } from 'sonner'
import { api } from '@/lib/http'
import { formatPaise, rupeesToPaise } from '@/lib/money'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Badge } from '@/components/ui/badge'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'

type Entry = { id: string; item: string; qty: string; unit: string; ratePaise: number; amountPaise: number; remarks: string | null; hasAttachment: boolean; createdBy: string; isClosed: boolean }
type View = { closed: boolean; totalPaise: number; entries: Entry[] }

export function EventMaintenance({ eventId, editable }: { eventId: string; editable: boolean }) {
  const [view, setView] = useState<View | null>(null)
  const load = useCallback(async () => setView(await api<View>(`/events/${eventId}/maintenance`)), [eventId])
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    load().catch((e) => toast.error(e instanceof Error ? e.message : 'Failed to load maintenance'))
  }, [load])

  if (!view) return <div className="flex items-center gap-2 p-2 text-sm text-muted-foreground"><Loader2 className="size-4 animate-spin" /> Loading…</div>

  const canEdit = editable && !view.closed

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div className="text-sm text-muted-foreground">
          Total: <span className="font-medium tabular-nums text-foreground">{formatPaise(view.totalPaise)}</span>
          {view.closed && <Badge variant="outline" className="ml-2 text-muted-foreground"><Lock className="mr-1 size-3" /> closed</Badge>}
        </div>
        {canEdit && view.entries.length > 0 && (
          <CloseButton eventId={eventId} onDone={load} />
        )}
      </div>

      {view.entries.length > 0 && (
        <div className="overflow-x-auto rounded-lg border">
          <Table>
            <TableHeader><TableRow>
              <TableHead>Item</TableHead><TableHead className="text-right">Qty</TableHead><TableHead className="text-right">Rate</TableHead><TableHead className="text-right">Amount</TableHead><TableHead>Receipt</TableHead>{canEdit && <TableHead />}
            </TableRow></TableHeader>
            <TableBody>
              {view.entries.map((e) => (
                <TableRow key={e.id}>
                  <TableCell>
                    {e.item}
                    {e.remarks && <span className="block text-xs text-muted-foreground">{e.remarks}</span>}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">{Number(e.qty)} {e.unit}</TableCell>
                  <TableCell className="text-right tabular-nums">{formatPaise(e.ratePaise)}</TableCell>
                  <TableCell className="text-right tabular-nums font-medium">{formatPaise(e.amountPaise)}</TableCell>
                  <TableCell>
                    {e.hasAttachment ? (
                      <a href={`/api/v1/maintenance/${e.id}/attachment`} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-primary hover:underline">
                        <Paperclip className="size-3" /> view
                      </a>
                    ) : <span className="text-muted-foreground">—</span>}
                  </TableCell>
                  {canEdit && (
                    <TableCell className="text-right">
                      <Button size="icon-xs" variant="ghost" onClick={async () => { try { await api(`/maintenance/${e.id}`, { method: 'DELETE' }); await load() } catch (err) { toast.error(err instanceof Error ? err.message : 'Failed') } }}>
                        <Trash2 className="size-3" />
                      </Button>
                    </TableCell>
                  )}
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}

      {canEdit ? <AddEntry eventId={eventId} onAdded={load} /> : !view.closed && <p className="text-sm text-muted-foreground">Maintenance can be logged while the event is In Progress or Completed.</p>}
    </div>
  )
}

function AddEntry({ eventId, onAdded }: { eventId: string; onAdded: () => Promise<void> }) {
  const [item, setItem] = useState('')
  const [qty, setQty] = useState('1')
  const [unit, setUnit] = useState('nos')
  const [rate, setRate] = useState('')
  const [remarks, setRemarks] = useState('')
  const fileRef = useRef<HTMLInputElement>(null)
  const [busy, setBusy] = useState(false)

  async function add() {
    const q = Number(qty), r = Number(rate)
    if (!item.trim() || !(q > 0) || !(r >= 0)) { toast.error('Enter an item, a positive quantity and a rate'); return }
    setBusy(true)
    try {
      const fd = new FormData()
      fd.set('item', item.trim()); fd.set('qty', String(q)); fd.set('unit', unit.trim() || 'nos')
      fd.set('rate_paise', String(rupeesToPaise(r)))
      if (remarks.trim()) fd.set('remarks', remarks.trim())
      const file = fileRef.current?.files?.[0]
      if (file) fd.set('file', file)
      const res = await fetch(`/api/v1/events/${eventId}/maintenance`, { method: 'POST', body: fd })
      if (!res.ok) throw new Error((await res.json().catch(() => ({})))?.error?.message ?? 'Failed')
      setItem(''); setQty('1'); setRate(''); setRemarks(''); if (fileRef.current) fileRef.current.value = ''
      await onAdded()
      toast.success('Entry added')
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not add')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="rounded-lg border border-dashed p-3">
      <div className="mb-2 text-sm font-medium">Add a cost entry</div>
      <div className="flex flex-wrap items-end gap-2">
        <div className="grow space-y-1"><Label className="text-xs">Item</Label><Input placeholder="Generator (extra hours)" value={item} onChange={(e) => setItem(e.target.value)} /></div>
        <div className="w-20 space-y-1"><Label className="text-xs">Qty</Label><Input inputMode="decimal" value={qty} onChange={(e) => setQty(e.target.value)} /></div>
        <div className="w-20 space-y-1"><Label className="text-xs">Unit</Label><Input value={unit} onChange={(e) => setUnit(e.target.value)} /></div>
        <div className="w-28 space-y-1"><Label className="text-xs">Rate ₹</Label><Input inputMode="decimal" value={rate} onChange={(e) => setRate(e.target.value)} /></div>
        <div className="grow space-y-1"><Label className="text-xs">Remarks</Label><Input value={remarks} onChange={(e) => setRemarks(e.target.value)} /></div>
        <div className="space-y-1"><Label className="text-xs">Receipt/photo</Label><Input ref={fileRef} type="file" accept="image/*,application/pdf" className="w-44" /></div>
        <Button onClick={add} disabled={busy}>{busy ? <Loader2 className="size-4 animate-spin" /> : <Plus className="size-4" />} Add</Button>
      </div>
    </div>
  )
}

function CloseButton({ eventId, onDone }: { eventId: string; onDone: () => Promise<void> }) {
  const [busy, setBusy] = useState(false)
  return (
    <Button
      variant="outline"
      size="sm"
      disabled={busy}
      onClick={async () => {
        setBusy(true)
        try { await api(`/events/${eventId}/maintenance/close`, { method: 'POST' }); await onDone(); toast.success('Maintenance closed') }
        catch (e) { toast.error(e instanceof Error ? e.message : 'Failed') }
        finally { setBusy(false) }
      }}
    >
      <Lock className="size-3.5" /> Close maintenance
    </Button>
  )
}
