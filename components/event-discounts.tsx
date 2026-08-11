'use client'

import { useCallback, useEffect, useState } from 'react'
import { Plus, Trash2 } from 'lucide-react'
import { toast } from 'sonner'
import { api } from '@/lib/http'
import { formatPaise } from '@/lib/money'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { cn } from '@/lib/utils'

/**
 * Discounts, shown on the Payment review at the end of the proposal — that is where the bill is
 * read, so it is where it is adjusted (client, 25 Jul 2026).
 *
 * A discount is **an amount of money** off a head — Venue / Menu / Rooms, or Overall for the
 * whole bill (client's lead, 4 Aug 2026, replacing the percentage input). What is typed is what
 * the guest gets; the percentage survives only as the cap's arithmetic. The COMBINED effective
 * discount stays ≤ 10% of the total bill (venue + food + rooms, no tax of either kind) and
 * applies immediately; crossing the cap holds it behind one `discount_over_cap` request until
 * the Higher Authority approves it (BR-D2).
 *
 * The cap is never stated on this panel (client, 11 Aug 2026) — see the note beside the list.
 * It is enforced regardless; the only thing that changed is who gets told about it, and when.
 */

type DiscountRow = {
  id: string
  head: string
  percentBp: number | null
  amountPaise: number
  remark: string
  status: 'effective' | 'pending' | 'rejected'
  givenAt: string
}
type Bases = { venue: number; menu: number; room: number; overall: number }
type Cap = {
  capPct: number
  capBasePaise: number
  capPaise: number
  usedPaise: number
  headroomPaise: number
}

const DISC_STATUS: Record<string, string> = {
  effective: 'text-emerald-600',
  pending: 'text-amber-600',
  rejected: 'text-muted-foreground line-through',
}
const HEADS = [
  { value: 'venue', label: 'Venue' },
  { value: 'menu', label: 'Menu' },
  { value: 'room', label: 'Rooms' },
  { value: 'overall', label: 'Overall' },
]

export function EventDiscounts({ eventId, editable, onChanged }: { eventId: string; editable: boolean; onChanged?: () => void | Promise<void> }) {
  const [discs, setDiscs] = useState<DiscountRow[]>([])
  const [bases, setBases] = useState<Bases | null>(null)
  const [cap, setCap] = useState<Cap | null>(null)
  // Whether the cap binds this user — read from the server rather than assumed, so the
  // Authority is not told his own discount needs his approval.
  const [uncapped, setUncapped] = useState(false)
  const [head, setHead] = useState('venue')
  const [rupees, setRupees] = useState('')
  const [remark, setRemark] = useState('')
  const [busy, setBusy] = useState(false)

  const load = useCallback(async () => {
    try {
      const d = await api<{ discounts: DiscountRow[]; bases: Bases; cap: Cap; uncapped: boolean }>(`/events/${eventId}/discounts`)
      setDiscs(d.discounts)
      setBases(d.bases)
      setCap(d.cap)
      setUncapped(d.uncapped)
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed to load discounts')
    }
  }, [eventId])

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load()
  }, [load])

  const amountPaise = Math.round(Number(rupees) * 100)
  const valid = Number.isFinite(amountPaise) && amountPaise > 0
  const headBase = bases ? bases[head as keyof Bases] : 0
  // What this money comes to as a percentage — of the head it is taken off, and of the whole
  // bill, which is the one the cap actually measures. Shown because the manager types rupees
  // but is bound by a percentage, and nobody should have to reconcile the two in their head.
  const headPct = valid && headBase > 0 ? (amountPaise / headBase) * 100 : null
  const billPct = valid && cap && cap.capBasePaise > 0 ? (amountPaise / cap.capBasePaise) * 100 : null
  const wouldExceed = Boolean(valid && cap && !uncapped && cap.usedPaise + amountPaise > cap.capPaise)

  async function add() {
    if (!valid || !remark.trim()) {
      toast.error('Enter an amount in rupees and a remark')
      return
    }
    setBusy(true)
    try {
      const res = await api<{ deferred: boolean }>(`/events/${eventId}/discounts`, {
        method: 'POST',
        body: JSON.stringify({ head, amount_paise: amountPaise, remark: remark.trim() }),
      })
      toast[res.deferred ? 'info' : 'success'](
        res.deferred ? `Over the ${cap?.capPct ?? 10}% cap — sent to the GM for approval.` : 'Discount applied',
      )
      setRupees('')
      setRemark('')
      await load()
      await onChanged?.()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not add discount')
    } finally {
      setBusy(false)
    }
  }

  async function remove(id: string) {
    try {
      await api(`/discounts/${id}`, { method: 'DELETE' })
      await load()
      await onChanged?.()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not remove')
    }
  }

  return (
    <div>
      <h3 className="mb-2 text-sm font-medium">Discounts</h3>
      {/* The cap is NOT stated here (client, 11 Aug 2026). This panel sits on the Payment
          review, which is read with the guest at the counter — a standing headroom figure told
          them what could still be asked for, and "over that needs GM approval" told them there
          was a bigger discount to push for. The cap is unchanged and still enforced server-side;
          it is simply not announced until the manager types an amount that crosses it, which is
          the one moment the warning is for them rather than an invitation to the guest. */}
      {discs.length === 0 ? (
        <p className="text-sm text-muted-foreground">None.</p>
      ) : (
        <ul className="mb-2 space-y-1 text-sm">
          {discs.map((x) => (
            <li key={x.id} className="flex items-center justify-between gap-2">
              <span>
                <span className="capitalize">{x.head}</span>
                {x.percentBp != null && <span className="text-muted-foreground"> · {x.percentBp / 100}%</span>} · {x.remark}
                <Badge variant="outline" className={cn('ml-2 capitalize', DISC_STATUS[x.status])}>
                  {x.status}
                </Badge>
              </span>
              <span className="flex items-center gap-2 tabular-nums">
                − {formatPaise(x.amountPaise)}
                {editable && (
                  <Button size="icon-xs" variant="ghost" onClick={() => remove(x.id)} aria-label="Remove discount">
                    <Trash2 className="size-3" />
                  </Button>
                )}
              </span>
            </li>
          ))}
        </ul>
      )}
      {editable && (
        <div className="flex flex-wrap items-end gap-2">
          <div className="w-32 space-y-1">
            <Label className="text-xs">Head</Label>
            <Select value={head} onValueChange={(v) => { if (v) setHead(v) }} items={HEADS}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {HEADS.map((h) => (
                  <SelectItem key={h.value} value={h.value}>{h.label}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="w-28 space-y-1">
            <Label className="text-xs">Amount ₹</Label>
            <Input inputMode="decimal" value={rupees} onChange={(e) => setRupees(e.target.value)} placeholder="e.g. 50000" />
          </div>
          {/* basis-48, not bare grow: on a phone the head and percent already eat the row, and a
              growing-from-zero remark became a sliver a few characters wide. With a basis it
              wraps onto its own full-width line instead. */}
          <div className="grow basis-48 space-y-1">
            <Label className="text-xs">Remark (required)</Label>
            <Input value={remark} onChange={(e) => setRemark(e.target.value)} />
          </div>
          <Button variant="outline" onClick={add} disabled={busy}>
            <Plus className="size-4" /> Add
          </Button>
          {valid && (
            <p className="w-full text-xs text-muted-foreground">
              <span className="font-medium text-foreground">− {formatPaise(amountPaise)}</span> off {head}
              {headPct != null && ` — ${headPct.toFixed(1)}% of ${formatPaise(headBase)}`}
              {billPct != null && `, ${billPct.toFixed(1)}% of the total bill`}
              {wouldExceed && (
                <span className="ml-1 font-medium text-amber-600">
                  · over the {cap?.capPct ?? 10}% cap — this goes to the GM for approval.
                </span>
              )}
            </p>
          )}
        </div>
      )}
    </div>
  )
}
