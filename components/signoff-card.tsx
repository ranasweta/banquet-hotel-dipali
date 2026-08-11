'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { CheckCircle2 } from 'lucide-react'
import { toast } from 'sonner'
import { api } from '@/lib/http'
import { titleCase } from '@/lib/text'
import type { SignoffRow } from '@/lib/dashboard'
import { Button } from '@/components/ui/button'
import { SectionCard, EmptyState, formatDay } from '@/components/dashboard-shared'

/**
 * The lock sign-off, on the dashboard of the person who owes it.
 *
 * It used to live only on the booking page, which neither the Banquet Manager nor the Lodge
 * Manager can open — `bookings` is `none` for both by the client's decision of 22 Jul 2026,
 * and that was deliberate, so widening it back would undo a decision rather than fix a bug.
 * Since both lines are blocking in `lockChecklist`, the effect was that no event could be
 * locked, invoiced or billed through the UI at all.
 *
 * So the button comes to them instead, on the one screen they do have. It posts to the same
 * endpoint the booking page used, and the service still decides who may sign what.
 */
export function SignoffCard({
  rows,
  designation,
}: {
  rows: SignoffRow[]
  designation: 'banquet_manager' | 'lodge_manager'
}) {
  const router = useRouter()
  const [busy, setBusy] = useState<string | null>(null)

  const label = designation === 'lodge_manager' ? 'rooms reconciled' : 'day sheet run as listed'

  async function sign(row: SignoffRow) {
    setBusy(row.eventId)
    try {
      await api(`/events/${row.eventId}/signoff`, {
        method: 'POST',
        body: JSON.stringify({ designation }),
      })
      toast.success(`Signed off ${row.code}`)
      router.refresh()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not sign off')
    } finally {
      setBusy(null)
    }
  }

  return (
    <SectionCard
      icon={<CheckCircle2 className="size-4 text-muted-foreground" aria-hidden />}
      title="Awaiting your sign-off"
      note={label}
      badge={rows.length}
    >
      {rows.length === 0 ? (
        <EmptyState text="Nothing waiting on you." />
      ) : (
        <ul className="space-y-2 text-sm">
          {rows.map((r) => (
            <li key={r.eventId} className="flex items-center justify-between gap-2 rounded-lg px-2 py-1.5">
              <span className="min-w-0">
                <span className="line-clamp-1 font-medium">{titleCase(r.guestName)}</span>
                <span className="text-xs text-muted-foreground">
                  {r.code}
                  {r.lastDate ? ` · ended ${formatDay(r.lastDate)}` : ''}
                </span>
              </span>
              <Button
                size="sm"
                variant="outline"
                className="shrink-0"
                disabled={busy === r.eventId}
                onClick={() => sign(r)}
              >
                {busy === r.eventId ? 'Signing…' : 'Sign off'}
              </Button>
            </li>
          ))}
        </ul>
      )}
    </SectionCard>
  )
}
