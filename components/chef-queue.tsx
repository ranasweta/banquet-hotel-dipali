'use client'

import { useCallback, useEffect, useState } from 'react'
import Link from 'next/link'
import { ChefHat, Loader2 } from 'lucide-react'
import { toast } from 'sonner'
import { api } from '@/lib/http'
import { formatPaise, rupeesToPaise } from '@/lib/money'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { cn } from '@/lib/utils'

type Row = {
  id: string
  description: string
  status: 'pending' | 'priced' | 'declined'
  chargePaise: number | null
  remark: string | null
  requestedByName: string
  pricedByName: string | null
  eventId: string
  eventCode: string
  guestName: string
  subEventName: string
  eventDate: string
  pax: number
}

/**
 * The Chef's queue of delicacy requests. The charge entered here is PER PLATE — the row shows
 * what it means for the whole function (rate × pax) before it is committed, because pricing
 * immediately moves the event's proposal total.
 */
export function ChefQueue({ canPrice }: { canPrice: boolean }) {
  const [rows, setRows] = useState<Row[] | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [amount, setAmount] = useState<Record<string, string>>({})
  const [remark, setRemark] = useState<Record<string, string>>({})

  const load = useCallback(async () => {
    const r = await api<{ requests: Row[] }>('/chef-requests')
    setRows(r.requests)
  }, [])

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    load().catch((e) => toast.error(e instanceof Error ? e.message : 'Failed to load requests'))
  }, [load])

  async function submit(row: Row, decline: boolean) {
    const rupees = Number(amount[row.id])
    if (!decline && (!amount[row.id] || Number.isNaN(rupees) || rupees < 0)) {
      return toast.error('Enter the per-plate charge in rupees')
    }
    setBusy(row.id)
    try {
      await api(`/chef-requests/${row.id}/price`, {
        method: 'POST',
        body: JSON.stringify(
          decline
            ? { decline: true, remark: remark[row.id] || undefined }
            : { charge_paise: rupeesToPaise(rupees), remark: remark[row.id] || undefined },
        ),
      })
      toast.success(decline ? 'Request declined' : 'Priced — the proposal total is updated')
      await load()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not save')
    } finally {
      setBusy(null)
    }
  }

  if (!rows) {
    return (
      <div className="flex items-center gap-2 p-4 text-sm text-muted-foreground">
        <Loader2 className="size-4 animate-spin" /> Loading requests…
      </div>
    )
  }

  const pending = rows.filter((r) => r.status === 'pending')
  const done = rows.filter((r) => r.status !== 'pending')

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <ChefHat className="size-4 text-muted-foreground" aria-hidden />
            Waiting to be priced
            {pending.length > 0 && (
              <span className="inline-flex h-5 min-w-5 items-center justify-center rounded-full bg-amber-100 px-1.5 text-xs font-semibold text-amber-700 dark:bg-amber-950 dark:text-amber-300">
                {pending.length}
              </span>
            )}
          </CardTitle>
        </CardHeader>
        <CardContent>
          {pending.length === 0 ? (
            <p className="py-3 text-sm text-muted-foreground">Nothing waiting — every request is priced.</p>
          ) : (
            <ul className="divide-y">
              {pending.map((r) => {
                const rupees = Number(amount[r.id])
                const preview = amount[r.id] && !Number.isNaN(rupees) && rupees >= 0 ? rupeesToPaise(rupees) * r.pax : null
                return (
                  <li key={r.id} className="py-3">
                    <div className="font-medium">{r.description}</div>
                    <div className="text-xs text-muted-foreground">
                      {r.eventCode} · {r.guestName} · {r.subEventName} · {r.eventDate} · {r.pax} pax · asked by {r.requestedByName}
                    </div>
                    {canPrice ? (
                      <div className="mt-2 flex flex-wrap items-center gap-2">
                        <Input
                          type="number"
                          min={0}
                          className="h-8 w-40"
                          placeholder="₹ per plate"
                          value={amount[r.id] ?? ''}
                          onChange={(e) => setAmount((a) => ({ ...a, [r.id]: e.target.value }))}
                        />
                        <Input
                          className="h-8 w-56"
                          placeholder="Remark (optional)"
                          value={remark[r.id] ?? ''}
                          onChange={(e) => setRemark((x) => ({ ...x, [r.id]: e.target.value }))}
                        />
                        <Button size="sm" disabled={busy === r.id} onClick={() => submit(r, false)}>
                          {busy === r.id && <Loader2 className="mr-2 size-4 animate-spin" />}
                          Set price
                        </Button>
                        <Button size="sm" variant="outline" disabled={busy === r.id} onClick={() => submit(r, true)}>
                          Decline
                        </Button>
                        {preview != null && (
                          <span className="text-xs text-muted-foreground">
                            adds {formatPaise(preview)} to this function
                          </span>
                        )}
                      </div>
                    ) : (
                      <p className="mt-1 text-xs text-muted-foreground">Waiting on the Chef to price this.</p>
                    )}
                  </li>
                )
              })}
            </ul>
          )}
        </CardContent>
      </Card>

      {done.length > 0 && (
        <Card>
          <CardHeader><CardTitle>Decided</CardTitle></CardHeader>
          <CardContent>
            <ul className="divide-y text-sm">
              {done.map((r) => (
                <li key={r.id} className="flex items-center justify-between gap-3 py-2">
                  <span className="min-w-0">
                    <Link href={`/bookings/${r.eventId}`} className="font-medium hover:underline">{r.description}</Link>
                    <span className="block text-xs text-muted-foreground">
                      {r.eventCode} · {r.subEventName}
                      {r.remark ? ` · ${r.remark}` : ''}
                      {r.pricedByName ? ` · by ${r.pricedByName}` : ''}
                    </span>
                  </span>
                  <span
                    className={cn(
                      'shrink-0 rounded-full px-2 py-0.5 text-xs font-medium',
                      r.status === 'priced'
                        ? 'bg-emerald-100 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300'
                        : 'bg-muted text-muted-foreground',
                    )}
                  >
                    {r.status === 'priced' ? `${formatPaise(r.chargePaise ?? 0)}/plate` : 'declined'}
                  </span>
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      )}
    </div>
  )
}
