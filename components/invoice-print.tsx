'use client'

import { useEffect, useState } from 'react'
import { Loader2, Printer } from 'lucide-react'
import { toast } from 'sonner'
import { api } from '@/lib/http'
import { formatPaise } from '@/lib/money'
import { Button } from '@/components/ui/button'

type Line = { id: string; section: string; description: string; qty: string; ratePaise: number; gstRateBp: number; amountPaise: number; taxPaise: number }
type PrintData = {
  event: { code: string; guestName: string; eventType: string; firstDate: string | null; lastDate: string | null } | null
  contacts: { phone: string; label: string | null }[]
  invoice: {
    invoiceNo: string | null; finalised: boolean
    grossPaise: number; discountPaise: number; taxPaise: number; netPaise: number; advancesPaise: number; balancePaise: number
    tncSnapshot: string; lines: Line[]
  }
  signoffs: { designation: string; signedBy: string; signedAt: string }[]
}

const SECTIONS = ['venue', 'food', 'rooms', 'maintenance', 'adjustment'] as const

export function InvoicePrint({ eventId, proforma = false }: { eventId: string; proforma?: boolean }) {
  const [data, setData] = useState<PrintData | null>(null)

  useEffect(() => {
    api<PrintData>(proforma ? `/events/${eventId}/proforma` : `/events/${eventId}/invoice/print`)
      .then(setData)
      .catch((e) => toast.error(e instanceof Error ? e.message : 'Failed to load'))
  }, [eventId, proforma])

  if (!data) return <div className="flex items-center gap-2 p-4 text-sm text-muted-foreground"><Loader2 className="size-4 animate-spin" /> Loading…</div>
  const inv = data.invoice
  const heading = proforma ? 'PROFORMA / ESTIMATE' : inv.finalised ? 'TAX INVOICE' : 'DRAFT BILL'

  return (
    <div className="mx-auto max-w-3xl space-y-6 p-2">
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
          <div className="text-lg font-semibold">{heading}</div>
          {inv.invoiceNo && <div className="tabular-nums">{inv.invoiceNo}</div>}
        </div>
      </div>

      {proforma && (
        <div className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-800 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-200">
          This is a <strong>provisional estimate</strong>, not a tax invoice. Amounts may change until the event is finalised (locked), and no invoice number has been issued.
        </div>
      )}

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

      {/* Lines */}
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b text-left text-xs text-muted-foreground">
            <th className="py-1">Description</th><th className="py-1 text-right">Qty</th><th className="py-1 text-right">Amount</th><th className="py-1 text-right">GST</th><th className="py-1 text-right">Tax</th>
          </tr>
        </thead>
        <tbody>
          {SECTIONS.flatMap((s) => inv.lines.filter((l) => l.section === s)).map((l) => (
            <tr key={l.id} className="border-b border-dashed">
              <td className="py-1">{l.description}</td>
              <td className="py-1 text-right tabular-nums">{Number(l.qty)}</td>
              <td className="py-1 text-right tabular-nums">{formatPaise(l.amountPaise)}</td>
              <td className="py-1 text-right tabular-nums text-muted-foreground">{(l.gstRateBp / 100).toFixed(0)}%</td>
              <td className="py-1 text-right tabular-nums">{formatPaise(l.taxPaise)}</td>
            </tr>
          ))}
        </tbody>
      </table>

      {/* Totals */}
      <div className="ml-auto max-w-xs space-y-1 text-sm">
        <Line2 label="Gross" value={formatPaise(inv.grossPaise)} />
        {inv.discountPaise > 0 && <Line2 label="Less discounts" value={`− ${formatPaise(inv.discountPaise)}`} />}
        <Line2 label="Tax (GST)" value={formatPaise(inv.taxPaise)} />
        <Line2 label="Net payable" value={formatPaise(inv.netPaise)} bold />
        <Line2 label="Advances received" value={`− ${formatPaise(inv.advancesPaise)}`} />
        <Line2 label="Balance due" value={formatPaise(inv.balancePaise)} bold />
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

function Line2({ label, value, bold }: { label: string; value: string; bold?: boolean }) {
  return (
    <div className="flex justify-between gap-6">
      <span className="text-muted-foreground">{label}</span>
      <span className={`tabular-nums ${bold ? 'font-semibold' : ''}`}>{value}</span>
    </div>
  )
}
