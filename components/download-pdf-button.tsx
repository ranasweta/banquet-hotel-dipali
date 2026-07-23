'use client'

import { useState } from 'react'
import { Download, Loader2 } from 'lucide-react'
import { toast } from 'sonner'
import { api } from '@/lib/http'
import { cn } from '@/lib/utils'
import type { ProposalPdfData } from '@/lib/pdf/proposal-pdf'

/**
 * One-click proposal PDF download (tester, 23 Jul 2026). @react-pdf/renderer and the document
 * are imported lazily on click, so the (large) PDF engine never lands in the initial bundle —
 * it's fetched only when someone actually asks for a file. The data comes from the same
 * /proforma endpoint the on-screen Draft uses, so the PDF matches it to the paisa.
 *
 * Only offered for priced proposals (confirmed and up); an enquiry has no estimate yet
 * (proformaData throws for it), which is why callers gate on status.
 */
export function DownloadPdfButton({
  eventId,
  label = 'Download PDF',
  className,
}: {
  eventId: string
  label?: string
  className?: string
}) {
  const [busy, setBusy] = useState(false)

  async function download() {
    setBusy(true)
    try {
      const [{ pdf }, { ProposalPdf }, data] = await Promise.all([
        import('@react-pdf/renderer'),
        import('@/lib/pdf/proposal-pdf'),
        api<ProposalPdfData>(`/events/${eventId}/proforma`),
      ])
      const blob = await pdf(ProposalPdf({ data })).toBlob()
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `Proposal-${data.event?.code ?? eventId}.pdf`
      document.body.appendChild(a)
      a.click()
      a.remove()
      URL.revokeObjectURL(url)
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not generate the PDF')
    } finally {
      setBusy(false)
    }
  }

  return (
    <button
      type="button"
      onClick={download}
      disabled={busy}
      className={cn('inline-flex items-center gap-1 disabled:opacity-60', className)}
    >
      {busy ? <Loader2 className="size-3.5 animate-spin" /> : <Download className="size-3.5" />}
      {busy ? 'Generating…' : label}
    </button>
  )
}
