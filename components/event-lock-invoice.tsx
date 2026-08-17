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
  /** >1 once the Higher Authority has changed a billed booking and it was re-issued. */
  version: number; supersedesNo: string | null
  grossPaise: number; discountPaise: number
  /** Collected — the GST on rooms, 5% or 18% by nightly rate. Inside netPaise. */
  taxPaise: number
  /** Shown and never collected — the 18%. Inside displayTotalPaise only. */
  shownTaxPaise: number
  netPaise: number; displayTotalPaise: number; advancesPaise: number; balancePaise: number
  lines: { id: string; section: string; description: string; qty: string; ratePaise: number; gstRateBp: number; amountPaise: number; taxPaise: number }[]
  payments: { id: string; kind: string; amountPaise: number; mode: string; receiptNo: string; receivedOn: string }[]
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

  /**
   * The designations this reader may record here, and that are still outstanding.
   *
   * The Auditor is included deliberately: `lib/lock.ts` has always accepted them for ANY
   * designation, but the button was gated on the reader's own role being a designation, so an
   * Auditor saw nothing and the two blocking lines could not be cleared from this screen at
   * all. The managers who own them cannot open this page (`bookings` is `none` for both), so
   * their own route is the Sign-off card on their dashboard — this is the Auditor's backstop
   * for a manager who has left, or an event nobody signed.
   */
  const ITEM_OF: Record<string, string> = { banquet_manager: 'banquet', lodge_manager: 'lodge' }
  const outstanding = (d: string) => !checklist.items.find((i) => i.key === ITEM_OF[d])?.done
  const signable = (
    isAuditor ? Object.keys(SIGNOFF_LABEL) : SIGNOFF_LABEL[role] ? [role] : []
  ).filter((d) => outstanding(d) && ['in_progress', 'completed'].includes(checklist.status))

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
          {signable.map((d) => (
            <Button
              key={d}
              size="sm"
              variant="outline"
              disabled={busy}
              onClick={() => act(() => api(`/events/${eventId}/signoff`, { method: 'POST', body: JSON.stringify({ designation: d }) }), 'Signed off')}
            >
              Sign off as {SIGNOFF_LABEL[d]}
            </Button>
          ))}
          {isAuditor && checklist.status === 'completed' && (
            <Button size="sm" disabled={busy || !checklist.canLock} onClick={() => act(() => api(`/events/${eventId}/lock`, { method: 'POST' }), 'Event locked — Draft prepared')}>
              <Lock className="size-3.5" /> Lock &amp; prepare Draft
            </Button>
          )}
          {!checklist.canLock && checklist.status === 'completed' && <span className="text-xs text-amber-600">Complete every item to lock.</span>}
        </div>
      </div>

      {/* Payment review. Never "invoice", never "final" — the two documents the client
          recognises are Draft and Draft 2 (20 Jul 2026). */}
      {invoice && (
        <div>
          <div className="mb-2 flex items-center justify-between">
            <h3 className="text-sm font-medium">
              Payment review {invoice.invoiceNo && <span className="tabular-nums">· {invoice.invoiceNo}</span>}
              {invoice.finalised ? <Badge variant="outline" className="ml-2 text-emerald-600">Draft 2</Badge> : <Badge variant="outline" className="ml-2 text-amber-600">Draft</Badge>}
              {/* Re-issued after the Higher Authority changed a billed booking. Two numbers
                  against one guest is confusing unless the screen says which replaced which. */}
              {invoice.version > 1 && (
                <Badge variant="outline" className="ml-2 text-violet-600">
                  Revision {invoice.version}{invoice.supersedesNo && ` · replaces ${invoice.supersedesNo}`}
                </Badge>
              )}
            </h3>
            <Link href={`/bookings/${eventId}/invoice`} className="text-sm text-primary hover:underline">Print view →</Link>
          </div>
          <div className="overflow-x-auto rounded-lg border">
            <Table>
              <TableHeader><TableRow>
                <TableHead>Head</TableHead><TableHead>Description</TableHead><TableHead className="text-right">How it works out</TableHead><TableHead className="text-right">Amount</TableHead><TableHead className="text-right">Tax</TableHead>
              </TableRow></TableHeader>
              <TableBody>
                {invoice.lines.map((l) => {
                  const qty = Number(l.qty)
                  return (
                    <TableRow key={l.id}>
                      <TableCell className="capitalize text-muted-foreground">{l.section}</TableCell>
                      <TableCell>{l.description}</TableCell>
                      {/* The arithmetic, spelled out — the client asked for every penny to
                          be traceable rather than a bare total. */}
                      <TableCell className="text-right text-xs tabular-nums text-muted-foreground">
                        {qty > 1 ? `${qty} × ${formatPaise(l.ratePaise)}` : formatPaise(l.ratePaise)}
                      </TableCell>
                      <TableCell className="text-right tabular-nums">{formatPaise(l.amountPaise)}</TableCell>
                      <TableCell className="text-right tabular-nums text-muted-foreground">
                        {l.gstRateBp > 0 ? `${formatPaise(l.taxPaise)} (${(l.gstRateBp / 100).toFixed(0)}%)` : '—'}
                      </TableCell>
                    </TableRow>
                  )
                })}
              </TableBody>
            </Table>
          </div>
          <dl className="mt-3 ml-auto max-w-xs space-y-1 text-sm">
            <Row label="Sub-total" value={formatPaise(invoice.grossPaise)} />
            {invoice.discountPaise > 0 && <Row label="Less discounts" value={`− ${formatPaise(invoice.discountPaise)}`} />}
            {/* Room GST at both bands: 5% at or under ₹7,500 a night, 18% above it (client,
                17 Aug 2026). Both are collected, so both are in this one figure — the per-line
                rate above says which room took which. The 18% BELOW it is the other kind. */}
            <Row label="GST on rooms — 5% / 18%" value={`+ ${formatPaise(invoice.taxPaise)}`} />
            <Row label="GST 18% — venue, food, add-ons" value={`+ ${formatPaise(invoice.shownTaxPaise)}`} />
            <Row label="Total" value={formatPaise(invoice.displayTotalPaise)} bold />
            {/* Two totals, deliberately. The 18% is printed and collected from nobody (client,
                4 Aug 2026), so what the guest settles against is the smaller figure — and a
                staff member reading one number would collect the wrong one. */}
            <Row label="Amount payable" value={formatPaise(invoice.netPaise)} bold />
            <p className="pt-0.5 text-right text-[11px] leading-snug text-muted-foreground">
              GST 18% is shown on the document and is not collected. The balance below is measured
              against the amount payable.
            </p>
            <Row label="Received so far" value={`− ${formatPaise(invoice.advancesPaise)}`} />
            {/* The instalments behind that figure. A wedding is often settled in pieces over
                months, and one total hides who paid what and when (client, 21 Jul 2026). */}
            {invoice.payments?.length > 0 && (
              <ul className="ml-2 space-y-0.5 border-l pl-3 text-xs text-muted-foreground">
                {invoice.payments.map((p) => (
                  <li key={p.id} className="flex justify-between gap-3">
                    <span className="tabular-nums">
                      {p.receivedOn} · <span className="capitalize">{p.kind.replace(/_/g, ' ')}</span> · {p.mode} · {p.receiptNo}
                    </span>
                    <span className="tabular-nums">
                      {p.kind === 'refund' ? '+' : '−'} {formatPaise(Math.abs(p.amountPaise))}
                    </span>
                  </li>
                ))}
              </ul>
            )}
            <Row label="Balance due" value={formatPaise(invoice.balancePaise)} bold accent={invoice.balancePaise > 0 ? 'text-amber-600' : 'text-emerald-600'} />
          </dl>

          {/* Discounts moved to the Billing section (client, 25 Jul 2026), where they can be
              applied from confirmed rather than only once the event is completed. */}

          {isAuditor && !invoice.finalised && (
            <div className="mt-4 flex flex-wrap items-end gap-2 border-t pt-3">
              <Adjuster eventId={eventId} onDone={load} />
              {/* Issuing Draft 2 locks the amount — same mechanism as before, never called
                  "finalise" in front of a user (client, 20 Jul 2026). */}
              <Button size="sm" disabled={busy} onClick={() => act(() => api(`/events/${eventId}/invoice/finalise`, { method: 'POST' }), 'Draft 2 issued — the amount is locked')}>
                Issue Draft 2
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
