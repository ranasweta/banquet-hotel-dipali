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
 * A discount is a **percentage of a head** — Venue / Menu / Rooms, or Overall for the whole
 * bill. Its rupee value is live: it recomputes from the current subtotal, so a pax or room
 * change flows straight through. The COMBINED effective discount stays ≤ 10% of the total bill
 * (venue + food + rooms, pre-tax) and applies immediately; crossing the cap holds it behind one
 * `discount_over_cap` request until the Higher Authority approves it (BR-D2).
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
  // The cap the server will actually apply, and whether it binds this user — read from the
  // server rather than assumed, so the Authority is not told his own discount needs his approval.
  const [cap, setCap] = useState<{ pct: number; uncapped: boolean }>({ pct: 10, uncapped: false })
  const [head, setHead] = useState('venue')
  const [percent, setPercent] = useState('')
  const [remark, setRemark] = useState('')
  const [busy, setBusy] = useState(false)

  const load = useCallback(async () => {
    try {
      const d = await api<{ discounts: DiscountRow[]; bases: Bases; capPct: number; uncapped: boolean }>(`/events/${eventId}/discounts`)
      setDiscs(d.discounts)
      setBases(d.bases)
      setCap({ pct: d.capPct, uncapped: d.uncapped })
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed to load discounts')
    }
  }, [eventId])

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load()
  }, [load])

  const pct = Number(percent)
  const headBase = bases ? bases[head as keyof Bases] : 0
  // Live preview of what this % works out to against the chosen head's current subtotal.
  const previewPaise =
    Number.isFinite(pct) && pct > 0 && pct <= 100 ? Math.round((headBase * pct) / 100) : null

  async function add() {
    if (!Number.isFinite(pct) || pct <= 0 || pct > 100 || !remark.trim()) {
      toast.error('Enter a percentage (1–100) and a remark')
      return
    }
    setBusy(true)
    try {
      const res = await api<{ deferred: boolean }>(`/events/${eventId}/discounts`, {
        method: 'POST',
        body: JSON.stringify({ head, percent_bp: Math.round(pct * 100), remark: remark.trim() }),
      })
      toast[res.deferred ? 'info' : 'success'](
        res.deferred ? `Over the ${cap.pct}% cap — sent to the GM for approval.` : 'Discount applied',
      )
      setPercent('')
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
      {discs.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          {cap.uncapped
            ? 'None. Your discounts take effect at once — the cap does not apply to you.'
            : `None. The combined discount stays ≤ ${cap.pct}% of the total bill (over that needs GM approval).`}
        </p>
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
          <div className="w-24 space-y-1">
            <Label className="text-xs">Percent %</Label>
            <Input inputMode="decimal" value={percent} onChange={(e) => setPercent(e.target.value)} placeholder="e.g. 20" />
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
          {previewPaise != null && (
            <p className="w-full text-xs text-muted-foreground">
              {pct}% of {head} ({formatPaise(headBase)}) = <span className="font-medium text-foreground">− {formatPaise(previewPaise)}</span>
            </p>
          )}
        </div>
      )}
    </div>
  )
}
