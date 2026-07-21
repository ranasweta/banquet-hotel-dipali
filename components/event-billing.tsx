'use client'

import { useCallback, useEffect, useState } from 'react'
import { Loader2 } from 'lucide-react'
import { toast } from 'sonner'
import { api } from '@/lib/http'
import { formatPaise, rupeesToPaise } from '@/lib/money'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Card, CardContent } from '@/components/ui/card'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { cn } from '@/lib/utils'

type Ledger = {
  proposalTotalPaise: number
  discountPaise: number
  netBillPaise: number
  paidPaise: number
  balancePaise: number
  payments: { id: string; kind: string; amountPaise: number; mode: string; receiptNo: string; receivedOn: string; note: string | null }[]
}

export function EventBilling({ eventId, editable }: { eventId: string; editable: boolean }) {
  const [ledger, setLedger] = useState<Ledger | null>(null)

  const load = useCallback(async () => {
    setLedger(await api<Ledger>(`/events/${eventId}/ledger`))
  }, [eventId])

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    load().catch((e) => toast.error(e instanceof Error ? e.message : 'Failed to load billing'))
  }, [load])

  if (!ledger) {
    return <div className="flex items-center gap-2 p-2 text-sm text-muted-foreground"><Loader2 className="size-4 animate-spin" /> Loading billing…</div>
  }

  return (
    <div className="space-y-6">
      {/* Money summary */}
      <div className="grid gap-3 sm:grid-cols-4">
        <Stat label="Proposal" value={formatPaise(ledger.proposalTotalPaise)} />
        <Stat label="Discounts" value={ledger.discountPaise ? `− ${formatPaise(ledger.discountPaise)}` : '—'} />
        <Stat label="Paid" value={formatPaise(ledger.paidPaise)} />
        <Stat
          label="Balance"
          value={formatPaise(ledger.balancePaise)}
          accent={ledger.balancePaise > 0 ? 'text-amber-600' : 'text-emerald-600'}
        />
      </div>

      <PaymentSection eventId={eventId} ledger={ledger} editable={editable} onChanged={load} />
    </div>
  )
}

function Stat({ label, value, accent }: { label: string; value: string; accent?: string }) {
  return (
    <Card>
      <CardContent className="py-3">
        <div className="text-xs text-muted-foreground">{label}</div>
        <div className={cn('text-lg font-semibold tabular-nums', accent)}>{value}</div>
      </CardContent>
    </Card>
  )
}

function PaymentSection({ eventId, ledger, editable, onChanged }: { eventId: string; ledger: Ledger; editable: boolean; onChanged: () => Promise<void> }) {
  const [kind, setKind] = useState('part_payment')
  const [amount, setAmount] = useState('')
  const [mode, setMode] = useState('upi')
  const [receipt, setReceipt] = useState('')
  const [receivedOn, setReceivedOn] = useState('')
  const [busy, setBusy] = useState(false)

  async function record() {
    const rupees = Number(amount)
    if (!Number.isFinite(rupees) || rupees <= 0 || !receipt.trim() || !receivedOn) {
      toast.error('Enter amount, receipt number and date')
      return
    }
    setBusy(true)
    try {
      await api(`/events/${eventId}/payments`, {
        method: 'POST',
        body: JSON.stringify({ kind, amount_paise: rupeesToPaise(rupees), mode, receipt_no: receipt.trim(), received_on: receivedOn }),
      })
      toast.success('Payment recorded')
      setAmount(''); setReceipt('')
      await onChanged()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not record payment')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div>
      <h3 className="mb-2 text-sm font-medium">Payment ledger</h3>
      {ledger.payments.length === 0 ? (
        <p className="text-sm text-muted-foreground">No payments recorded yet.</p>
      ) : (
        <div className="mb-2 overflow-x-auto rounded-lg border">
          <Table>
            <TableHeader><TableRow>
              <TableHead>Date</TableHead><TableHead>Kind</TableHead><TableHead>Mode</TableHead><TableHead>Receipt</TableHead><TableHead className="text-right">Amount</TableHead>
            </TableRow></TableHeader>
            <TableBody>
              {ledger.payments.map((p) => (
                <TableRow key={p.id}>
                  <TableCell className="tabular-nums text-muted-foreground">{p.receivedOn}</TableCell>
                  <TableCell className="capitalize">{p.kind.replace(/_/g, ' ')}</TableCell>
                  <TableCell className="uppercase text-xs">{p.mode}</TableCell>
                  <TableCell className="tabular-nums">{p.receiptNo}</TableCell>
                  <TableCell className={cn('text-right tabular-nums', p.kind === 'refund' && 'text-red-600')}>
                    {p.kind === 'refund' ? '− ' : ''}{formatPaise(p.amountPaise)}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
      {editable && (
        <div className="flex flex-wrap items-end gap-2">
          <div className="w-32 space-y-1"><Label className="text-xs">Kind</Label>
            <Select value={kind} onValueChange={(v) => { if (v) setKind(v) }} items={[{ value: 'part_payment', label: 'Part payment' }, { value: 'settlement', label: 'Settlement' }, { value: 'refund', label: 'Refund' }]}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="part_payment">Part payment</SelectItem>
                <SelectItem value="settlement">Settlement</SelectItem>
                <SelectItem value="refund">Refund</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="w-28 space-y-1"><Label className="text-xs">Amount ₹</Label><Input inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} /></div>
          <div className="w-28 space-y-1"><Label className="text-xs">Mode</Label>
            <Select value={mode} onValueChange={(v) => { if (v) setMode(v) }} items={[{ value: 'cash', label: 'Cash' }, { value: 'upi', label: 'UPI' }, { value: 'bank', label: 'Bank' }, { value: 'cheque', label: 'Cheque' }]}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="cash">Cash</SelectItem>
                <SelectItem value="upi">UPI</SelectItem>
                <SelectItem value="bank">Bank</SelectItem>
                <SelectItem value="cheque">Cheque</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="w-40 space-y-1"><Label className="text-xs">Receipt no.</Label><Input value={receipt} onChange={(e) => setReceipt(e.target.value)} /></div>
          <div className="w-40 space-y-1"><Label className="text-xs">Received on</Label><Input type="date" value={receivedOn} onChange={(e) => setReceivedOn(e.target.value)} /></div>
          <Button onClick={record} disabled={busy}>{busy && <Loader2 className="size-4 animate-spin" />} Record</Button>
        </div>
      )}
    </div>
  )
}
