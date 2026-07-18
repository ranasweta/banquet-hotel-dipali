'use client'

import { useCallback, useEffect, useState } from 'react'
import Link from 'next/link'
import { Check, CircleDashed, Loader2, Lock } from 'lucide-react'
import { toast } from 'sonner'
import { api } from '@/lib/http'
import { formatPaise, rupeesToPaise } from '@/lib/money'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Badge } from '@/components/ui/badge'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { cn } from '@/lib/utils'

type ChecklistItem = { key: string; label: string; done: boolean; blocking: boolean }
type Checklist = { status: string; canLock: boolean; hasRooms: boolean; items: ChecklistItem[] }
type Invoice = {
  id: string; invoiceNo: string | null; finalised: boolean
  grossPaise: number; discountPaise: number; taxPaise: number; netPaise: number; advancesPaise: number; balancePaise: number
  lines: { id: string; section: string; description: string; qty: string; ratePaise: number; gstRateBp: number; amountPaise: number; taxPaise: number }[]
}

const SIGNOFF_LABEL: Record<string, string> = { banquet_manager: 'Banquet Manager', lodge_manager: 'Lodge Manager' }

export function EventLockInvoice({ eventId, role, isAuditor }: { eventId: string; role: string; isAuditor: boolean }) {
  const [checklist, setChecklist] = useState<Checklist | null>(null)
  const [invoice, setInvoice] = useState<Invoice | null>(null)
  const [busy, setBusy] = useState(false)

  const load = useCallback(async () => {
    const [c, i] = await Promise.all([
      api<Checklist>(`/events/${eventId}/lock-checklist`),
      api<{ invoice: Invoice | null }>(`/events/${eventId}/invoice`),
    ])
    setChecklist(c)
    setInvoice(i.invoice)
  }, [eventId])

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    load().catch((e) => toast.error(e instanceof Error ? e.message : 'Failed to load'))
  }, [load])

  async function act(fn: () => Promise<unknown>, done: string) {
    setBusy(true)
    try { await fn(); await load(); toast.success(done) }
    catch (e) { toast.error(e instanceof Error ? e.message : 'Failed') }
    finally { setBusy(false) }
  }

  if (!checklist) return <div className="flex items-center gap-2 p-2 text-sm text-muted-foreground"><Loader2 className="size-4 animate-spin" /> Loading…</div>

  const mySignoff = SIGNOFF_LABEL[role] ? role : null

  return (
    <div className="space-y-5">
      {/* Checklist */}
      <div>
        <h3 className="mb-2 text-sm font-medium">Lock checklist</h3>
        <ul className="space-y-1">
          {checklist.items.map((i) => (
            <li key={i.key} className="flex items-center gap-2 text-sm">
              {i.done ? <Check className="size-4 text-emerald-600" /> : <CircleDashed className="size-4 text-amber-500" />}
              <span className={i.done ? '' : 'text-muted-foreground'}>{i.label}</span>
            </li>
          ))}
        </ul>
        <div className="mt-3 flex flex-wrap items-center gap-2">
          {(mySignoff || isAuditor) && !checklist.items.find((i) => i.key === (role === 'lodge_manager' ? 'lodge' : 'banquet'))?.done && ['in_progress', 'completed'].includes(checklist.status) && mySignoff && (
            <Button size="sm" variant="outline" disabled={busy} onClick={() => act(() => api(`/events/${eventId}/signoff`, { method: 'POST', body: JSON.stringify({ designation: mySignoff }) }), 'Signed off')}>
              Sign off as {SIGNOFF_LABEL[mySignoff]}
            </Button>
          )}
          {isAuditor && checklist.status === 'completed' && (
            <Button size="sm" disabled={busy || !checklist.canLock} onClick={() => act(() => api(`/events/${eventId}/lock`, { method: 'POST' }), 'Event locked — invoice drafted')}>
              <Lock className="size-3.5" /> Lock &amp; draft invoice
            </Button>
          )}
          {!checklist.canLock && checklist.status === 'completed' && <span className="text-xs text-amber-600">Complete every item to lock.</span>}
        </div>
      </div>

      {/* Invoice */}
      {invoice && (
        <div>
          <div className="mb-2 flex items-center justify-between">
            <h3 className="text-sm font-medium">
              Invoice {invoice.invoiceNo && <span className="tabular-nums">· {invoice.invoiceNo}</span>}
              {invoice.finalised ? <Badge variant="outline" className="ml-2 text-emerald-600">finalised</Badge> : <Badge variant="outline" className="ml-2 text-amber-600">draft</Badge>}
            </h3>
            <Link href={`/bookings/${eventId}/invoice`} className="text-sm text-primary hover:underline">Print view →</Link>
          </div>
          <div className="overflow-x-auto rounded-lg border">
            <Table>
              <TableHeader><TableRow>
                <TableHead>Section</TableHead><TableHead>Description</TableHead><TableHead className="text-right">Qty</TableHead><TableHead className="text-right">Amount</TableHead><TableHead className="text-right">GST</TableHead><TableHead className="text-right">Tax</TableHead>
              </TableRow></TableHeader>
              <TableBody>
                {invoice.lines.map((l) => (
                  <TableRow key={l.id}>
                    <TableCell className="capitalize text-muted-foreground">{l.section}</TableCell>
                    <TableCell>{l.description}</TableCell>
                    <TableCell className="text-right tabular-nums">{Number(l.qty)}</TableCell>
                    <TableCell className="text-right tabular-nums">{formatPaise(l.amountPaise)}</TableCell>
                    <TableCell className="text-right tabular-nums text-muted-foreground">{(l.gstRateBp / 100).toFixed(0)}%</TableCell>
                    <TableCell className="text-right tabular-nums">{formatPaise(l.taxPaise)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
          <dl className="mt-3 ml-auto max-w-xs space-y-1 text-sm">
            <Row label="Gross" value={formatPaise(invoice.grossPaise)} />
            {invoice.discountPaise > 0 && <Row label="Less discounts" value={`− ${formatPaise(invoice.discountPaise)}`} />}
            <Row label="Tax (GST)" value={formatPaise(invoice.taxPaise)} />
            <Row label="Net payable" value={formatPaise(invoice.netPaise)} bold />
            <Row label="Advances received" value={`− ${formatPaise(invoice.advancesPaise)}`} />
            <Row label="Balance due" value={formatPaise(invoice.balancePaise)} bold accent={invoice.balancePaise > 0 ? 'text-amber-600' : 'text-emerald-600'} />
          </dl>

          {isAuditor && !invoice.finalised && (
            <div className="mt-4 flex flex-wrap items-end gap-2 border-t pt-3">
              <Adjuster eventId={eventId} onDone={load} />
              <Button size="sm" disabled={busy} onClick={() => act(() => api(`/events/${eventId}/invoice/finalise`, { method: 'POST' }), 'Invoice finalised')}>
                Finalise invoice
              </Button>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

function Row({ label, value, bold, accent }: { label: string; value: string; bold?: boolean; accent?: string }) {
  return (
    <div className="flex justify-between gap-6">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className={cn('tabular-nums', bold && 'font-semibold', accent)}>{value}</dd>
    </div>
  )
}

function Adjuster({ eventId, onDone }: { eventId: string; onDone: () => Promise<void> }) {
  const [desc, setDesc] = useState('')
  const [amount, setAmount] = useState('')
  const [remark, setRemark] = useState('')
  const [busy, setBusy] = useState(false)

  async function add() {
    const r = Number(amount)
    if (!desc.trim() || !Number.isFinite(r) || r === 0 || !remark.trim()) { toast.error('Enter a description, a non-zero amount and a remark'); return }
    setBusy(true)
    try {
      // Append to the existing adjustment set by reading current adjustments first.
      const inv = (await api<{ invoice: { lines: { section: string; description: string; amountPaise: number }[] } }>(`/events/${eventId}/invoice`)).invoice
      const existing = inv.lines.filter((l) => l.section === 'adjustment').map((l) => ({ description: l.description, amount_paise: l.amountPaise, remark: 'kept' }))
      await api(`/events/${eventId}/invoice/adjustments`, { method: 'PUT', body: JSON.stringify({ adjustments: [...existing, { description: desc.trim(), amount_paise: rupeesToPaise(r), remark: remark.trim() }] }) })
      setDesc(''); setAmount(''); setRemark('')
      await onDone()
      toast.success('Adjustment added')
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed')
    } finally { setBusy(false) }
  }

  return (
    <>
      <Input placeholder="Adjustment" value={desc} onChange={(e) => setDesc(e.target.value)} className="w-40" />
      <Input placeholder="₹ (− for discount)" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} className="w-32" />
      <Input placeholder="Remark" value={remark} onChange={(e) => setRemark(e.target.value)} className="w-40" />
      <Button size="sm" variant="outline" disabled={busy} onClick={add}>Add adjustment</Button>
    </>
  )
}
