'use client'

import { useCallback, useEffect, useState } from 'react'
import Link from 'next/link'
import { ChevronRight, Loader2 } from 'lucide-react'
import { toast } from 'sonner'
import { api } from '@/lib/http'
import { formatPaise } from '@/lib/money'
import { Badge } from '@/components/ui/badge'
import { Card, CardContent } from '@/components/ui/card'
import { titleCase } from '@/lib/text'

/**
 * The Higher Authority's queue, one row per PROPOSAL (client's lead, 1 Aug 2026).
 *
 * It used to be one card per request, with Approve/Reject on each and no sight of the booking
 * — the GM was deciding fragments. Now every pending ask on a booking collects into one row he
 * opens, decides and edits in one sitting (components/approval-bundle.tsx).
 */

type BundleSummary = {
  eventId: string
  eventCode: string
  guestName: string
  eventType: string
  status: string
  firstDate: string | null
  proposalTotalPaise: number
  pendingCount: number
  bySection: { section: string; n: number }[]
  oldestRaisedAt: string
  raisedByNames: string[]
}

type Dashboard = {
  pendingCount: number
  byKind: { kind: string; n: number }[]
  upcomingHighValue: { id: string; code: string; guestName: string; firstDate: string | null; proposalTotalPaise: number }[]
}

export const SECTION_LABEL: Record<string, string> = {
  food: 'Food',
  rooms: 'Rooms',
  discount: 'Discount',
  timing: 'Venue & timing',
  other: 'Other',
}

/**
 * Each section keeps a distinct hue AND its own words. Colour alone never carries the meaning
 * — a GM who cannot separate amber from emerald still reads "Rooms 2" (WCAG 1.4.1).
 */
export const SECTION_STYLES: Record<string, string> = {
  food: 'bg-amber-100 text-amber-900 dark:bg-amber-950 dark:text-amber-100',
  rooms: 'bg-sky-100 text-sky-900 dark:bg-sky-950 dark:text-sky-100',
  discount: 'bg-emerald-100 text-emerald-900 dark:bg-emerald-950 dark:text-emerald-100',
  timing: 'bg-violet-100 text-violet-900 dark:bg-violet-950 dark:text-violet-100',
  other: 'bg-slate-100 text-slate-900 dark:bg-slate-800 dark:text-slate-100',
}

/** Age of the oldest ask in a bundle — a bundle waits as long as its most patient request. */
function age(iso: string): string {
  if (!iso) return ''
  const ms = Date.now() - new Date(iso).getTime()
  if (ms < 3_600_000) return 'just now'
  if (ms < 86_400_000) return `${Math.floor(ms / 3_600_000)}h ago`
  return `${Math.floor(ms / 86_400_000)}d ago`
}

export function ApprovalsQueue({ canDecide }: { canDecide: boolean }) {
  const [bundles, setBundles] = useState<BundleSummary[]>([])
  const [dash, setDash] = useState<Dashboard | null>(null)
  const [loading, setLoading] = useState(true)

  const load = useCallback(async () => {
    const [b, d] = await Promise.all([
      api<{ bundles: BundleSummary[] }>('/approvals/bundles'),
      api<Dashboard>('/approvals/dashboard'),
    ])
    setBundles(b.bundles)
    setDash(d)
  }, [])

  useEffect(() => {
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
              <div className="text-xs text-muted-foreground">Proposals awaiting you</div>
              <div className="text-2xl font-semibold tabular-nums">{bundles.length}</div>
              <div className="mt-1 text-xs text-muted-foreground">
                {dash.pendingCount} request{dash.pendingCount === 1 ? '' : 's'} in total
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
                        <span className="font-medium tabular-nums">{e.code}</span> · {titleCase(e.guestName)}
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

      <h2 className="text-lg font-semibold">Pending proposals</h2>

      {loading ? (
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="size-4 animate-spin" /> Loading…
        </div>
      ) : bundles.length === 0 ? (
        <p className="text-sm text-muted-foreground">Nothing awaiting approval. 🎉</p>
      ) : (
        <ul className="space-y-2">
          {bundles.map((b) => (
            <li key={b.eventId}>
              <Link
                href={canDecide ? `/approvals/${b.eventId}` : `/bookings/${b.eventId}`}
                className="block rounded-lg border bg-card p-3 transition-colors hover:border-primary/50 hover:bg-muted/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0 space-y-1.5">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-medium tabular-nums">{b.eventCode}</span>
                      <span className="text-sm text-muted-foreground">{titleCase(b.guestName)}</span>
                      <Badge variant="outline" className="text-xs">{titleCase(b.eventType)}</Badge>
                      {b.status !== 'confirmed' && b.status !== 'enquiry' && (
                        <Badge variant="outline" className="text-xs">{titleCase(b.status)}</Badge>
                      )}
                    </div>
                    <div className="flex flex-wrap gap-1">
                      {b.bySection.map((s) => (
                        <span
                          key={s.section}
                          className={`rounded-full px-2 py-0.5 text-xs ${SECTION_STYLES[s.section] ?? SECTION_STYLES.other}`}
                        >
                          {SECTION_LABEL[s.section] ?? s.section} {s.n}
                        </span>
                      ))}
                    </div>
                    <div className="text-xs text-muted-foreground">
                      {b.pendingCount} item{b.pendingCount === 1 ? '' : 's'} · raised by{' '}
                      {b.raisedByNames.join(', ')} · oldest {age(b.oldestRaisedAt)}
                      {b.firstDate && ` · event ${b.firstDate}`}
                    </div>
                  </div>
                  <div className="flex shrink-0 items-center gap-2">
                    <span className="tabular-nums text-sm">{formatPaise(b.proposalTotalPaise)}</span>
                    <ChevronRight className="size-4 text-muted-foreground" aria-hidden />
                  </div>
                </div>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
