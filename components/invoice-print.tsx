'use client'

import { useEffect, useState } from 'react'
import { Loader2, Printer } from 'lucide-react'
import { toast } from 'sonner'
import { api } from '@/lib/http'
import { formatPaise } from '@/lib/money'
import { Button } from '@/components/ui/button'

/**
 * The printable payment review.
 *
 * TERMINOLOGY (client, 20 Jul 2026): the words "invoice" and "final" must never reach the
 * guest. There are exactly two documents — **Draft** (tentative, amounts can still move)
 * and **Draft 2** (the money actually to be paid, issued once and locked). Both print with
 * their name as a watermark. File and table names keep the old wording internally; only
 * what a human reads changes.
 */

type Line = { id: string; section: string; description: string; functionLabel: string | null; qty: string; ratePaise: number; gstRateBp: number; amountPaise: number; taxPaise: number }
type PrintData = {
  event: { code: string; guestName: string; eventType: string; firstDate: string | null; lastDate: string | null } | null
  contacts: { phone: string; label: string | null }[]
  invoice: {
    invoiceNo: string | null; finalised: boolean
    grossPaise: number; discountPaise: number; taxPaise: number; netPaise: number; advancesPaise: number; balancePaise: number
    tncSnapshot: string; lines: Line[]
    payments: { id: string; kind: string; amountPaise: number; mode: string; receiptNo: string; receivedOn: string }[]
  }
  signoffs: { designation: string; signedBy: string; signedAt: string }[]
}

const SECTIONS = [
  { key: 'venue', label: 'Venue hire' },
  { key: 'food', label: 'Food & beverage' },
  { key: 'rooms', label: 'Rooms & lodging' },
  { key: 'maintenance', label: 'Maintenance & extras' },
  { key: 'adjustment', label: 'Adjustments' },
] as const

export function InvoicePrint({ eventId, proforma = false }: { eventId: string; proforma?: boolean }) {
  const [data, setData] = useState<PrintData | null>(null)

  useEffect(() => {
    api<PrintData>(proforma ? `/events/${eventId}/proforma` : `/events/${eventId}/invoice/print`)
      .then(setData)
      .catch((e) => toast.error(e instanceof Error ? e.message : 'Failed to load'))
  }, [eventId, proforma])

  if (!data) return <div className="flex items-center gap-2 p-4 text-sm text-muted-foreground"><Loader2 className="size-4 animate-spin" /> Loading…</div>
  const inv = data.invoice

  // Draft 2 only once the amount has been issued and locked. Everything before that —
  // including a locked event whose adjustments are still open — is a Draft.
  const isDraft2 = !proforma && inv.finalised
  const docName = isDraft2 ? 'DRAFT 2' : 'DRAFT'

  // Grouped the way the hotel counts a proposal: each function with its own venue and food
  // beneath it, then the event-level heads. Lines that belong to no single function —
  // rooms are booked across dates that span several, and maintenance and adjustments are
  // event-wide — keep their section heading and follow the functions.
  const total = (ls: Line[], f: (l: Line) => number) => ls.reduce((n, l) => n + f(l), 0)

  const functionNames: string[] = []
  for (const l of inv.lines) {
    if (l.functionLabel && !functionNames.includes(l.functionLabel)) functionNames.push(l.functionLabel)
  }

  const functionGroups = functionNames.map((name) => {
    const lines = inv.lines.filter((l) => l.functionLabel === name)
    return {
      key: `fn:${name}`,
      label: name,
      lines,
      subtotalPaise: total(lines, (l) => l.amountPaise),
      taxPaise: total(lines, (l) => l.taxPaise),
    }
  })

  const eventLevel = SECTIONS.map((sec) => {
    const lines = inv.lines.filter((l) => !l.functionLabel && l.section === sec.key)
    return {
      key: sec.key,
      label: sec.label,
      lines,
      subtotalPaise: total(lines, (l) => l.amountPaise),
      taxPaise: total(lines, (l) => l.taxPaise),
    }
  }).filter((g) => g.lines.length > 0)

  const groups = [...functionGroups, ...eventLevel]

  return (
    <div className="relative mx-auto max-w-3xl space-y-6 p-2">
      <Watermark label={docName} />

      <div className="flex items-start justify-between print:hidden">
        <div />
        <Button variant="outline" onClick={() => window.print()}><Printer className="size-4" /> Print</Button>
      </div>

      {/* Header */}
      <div className="flex items-start justify-between border-b pb-4">
        <div>
          <div className="text-xl font-bold">Hotel Dipali</div>
          <div className="text-xs text-muted-foreground">Near Makronia Railway Crossing, Jabalpur Road, Sagar</div>
          <div className="text-xs text-muted-foreground">GSTIN: [hotel GSTIN — to be configured]</div>
        </div>
        <div className="text-right">
          <div className="text-lg font-semibold tracking-wide">{docName}</div>
          {inv.invoiceNo && <div className="tabular-nums">{inv.invoiceNo}</div>}
        </div>
      </div>

      <div
        className={
          isDraft2
            ? 'rounded-md border border-emerald-300 bg-emerald-50 px-3 py-2 text-xs text-emerald-900 dark:border-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-200'
            : 'rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-900 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-200'
        }
      >
        {isDraft2 ? (
          <>This is <strong>Draft 2</strong> — the amount payable. It has been issued and no longer changes.</>
        ) : (
          <>This is a <strong>Draft</strong> — a provisional statement. Amounts can still change as rooms, maintenance and chef charges are recorded, and no document number has been issued yet.</>
        )}
      </div>

      {/* Guest */}
      <div className="grid grid-cols-2 gap-4 text-sm">
        <div>
          <div className="text-xs font-medium text-muted-foreground">Billed to</div>
          <div className="font-medium">{data.event?.guestName}</div>
          {data.contacts.map((c) => <div key={c.phone} className="tabular-nums text-muted-foreground">{c.phone}{c.label ? ` · ${c.label}` : ''}</div>)}
        </div>
        <div className="text-right">
          <div className="text-xs font-medium text-muted-foreground">Event</div>
          <div className="tabular-nums">{data.event?.code} · <span className="capitalize">{data.event?.eventType.replace(/_/g, ' ')}</span></div>
          {data.event?.firstDate && <div className="text-muted-foreground tabular-nums">{data.event.firstDate}{data.event.lastDate && data.event.lastDate !== data.event.firstDate ? ` → ${data.event.lastDate}` : ''}</div>}
        </div>
      </div>

      {/* Lines, grouped by head so every figure shows where it came from */}
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b text-left text-xs text-muted-foreground">
            <th className="py-1">Description</th>
            <th className="py-1 text-right">How it works out</th>
            <th className="py-1 text-right">Amount</th>
            <th className="py-1 text-right">Tax</th>
          </tr>
        </thead>
        <tbody>
          {groups.map((g) => (
            <FragmentGroup key={g.key} group={g} />
          ))}
        </tbody>
      </table>

      {/* Totals — written as the sum it is, so it can be checked by hand */}
      <div className="ml-auto max-w-sm space-y-1 text-sm">
        {groups.map((g) => (
          <Line2 key={g.key} label={g.label} value={formatPaise(g.subtotalPaise)} muted />
        ))}
        <div className="border-t pt-1">
          <Line2 label="Sub-total" value={formatPaise(inv.grossPaise)} />
        </div>
        {inv.discountPaise > 0 && <Line2 label="Less discounts" value={`− ${formatPaise(inv.discountPaise)}`} />}
        <Line2 label="Tax — 5% on rooms only" value={`+ ${formatPaise(inv.taxPaise)}`} />
        <div className="border-t pt-1">
          <Line2 label="Amount payable" value={formatPaise(inv.netPaise)} bold />
        </div>
        <Line2 label="Received so far" value={`− ${formatPaise(inv.advancesPaise)}`} />
        {/* Instalments, so the guest can see the payments this figure is made of. */}
        {inv.payments?.map((p) => (
          <div key={p.id} className="flex justify-between gap-6 pl-3 text-xs text-muted-foreground">
            <span className="tabular-nums">
              {p.receivedOn} · {p.mode} · {p.receiptNo}
            </span>
            <span className="tabular-nums">
              {p.kind === 'refund' ? '+' : '−'} {formatPaise(Math.abs(p.amountPaise))}
            </span>
          </div>
        ))}
        <div className="border-t pt-1">
          <Line2 label="Balance due" value={formatPaise(inv.balancePaise)} bold />
        </div>
      </div>

      {/* T&C */}
      {inv.tncSnapshot && (
        <div className="border-t pt-4 text-xs text-muted-foreground">
          <div className="mb-1 font-medium text-foreground">Terms &amp; Conditions</div>
          <p className="whitespace-pre-wrap">{inv.tncSnapshot}</p>
        </div>
      )}

      {/* Signatures */}
      <div className="grid grid-cols-2 gap-8 pt-8 sm:grid-cols-3">
        {['Guest', 'Banquet Manager', 'Lodge Manager', 'Maintenance', 'Auditor'].map((r) => (
          <div key={r} className="border-t pt-1 text-center text-xs text-muted-foreground">{r}</div>
        ))}
      </div>
    </div>
  )
}

/** One charge head: its lines, then its own sub-total. */
function FragmentGroup({
  group,
}: {
  group: { key: string; label: string; lines: Line[]; subtotalPaise: number; taxPaise: number }
}) {
  return (
    <>
      <tr className="border-b bg-muted/40">
        <td colSpan={4} className="px-1 py-1 text-xs font-semibold uppercase tracking-wide">
          {group.label}
        </td>
      </tr>
      {group.lines.map((l) => {
        const qty = Number(l.qty)
        return (
          <tr key={l.id} className="border-b border-dashed">
            <td className="py-1">{l.description}</td>
            {/* The arithmetic spelled out, so the total can be checked line by line. */}
            <td className="py-1 text-right tabular-nums text-xs text-muted-foreground">
              {qty > 1 ? `${qty} × ${formatPaise(l.ratePaise)}` : formatPaise(l.ratePaise)}
            </td>
            <td className="py-1 text-right tabular-nums">{formatPaise(l.amountPaise)}</td>
            <td className="py-1 text-right tabular-nums text-muted-foreground">
              {l.gstRateBp > 0 ? `${formatPaise(l.taxPaise)} (${(l.gstRateBp / 100).toFixed(0)}%)` : '—'}
            </td>
          </tr>
        )
      })}
      <tr className="border-b">
        <td colSpan={2} className="py-1 text-right text-xs text-muted-foreground">{group.label} sub-total</td>
        <td className="py-1 text-right tabular-nums font-medium">{formatPaise(group.subtotalPaise)}</td>
        <td className="py-1 text-right tabular-nums font-medium">
          {group.taxPaise > 0 ? formatPaise(group.taxPaise) : '—'}
        </td>
      </tr>
    </>
  )
}

/**
 * Diagonal watermark. `printColorAdjust: exact` is what keeps it on the page — browsers
 * strip background-ish colour when printing otherwise, which would defeat the point.
 */
function Watermark({ label }: { label: string }) {
  return (
    <div
      aria-hidden
      className="pointer-events-none absolute inset-0 z-10 flex select-none items-center justify-center overflow-hidden"
      style={{ WebkitPrintColorAdjust: 'exact', printColorAdjust: 'exact' }}
    >
      <span className="-rotate-[28deg] whitespace-nowrap text-[5.5rem] font-black uppercase tracking-[0.2em] text-foreground/[0.07]">
        {label}
      </span>
    </div>
  )
}

function Line2({ label, value, bold, muted }: { label: string; value: string; bold?: boolean; muted?: boolean }) {
  return (
    <div className="flex justify-between gap-6">
      <span className={muted ? 'text-xs text-muted-foreground' : 'text-muted-foreground'}>{label}</span>
      <span className={`tabular-nums ${bold ? 'font-semibold' : ''} ${muted ? 'text-xs text-muted-foreground' : ''}`}>{value}</span>
    </div>
  )
}
