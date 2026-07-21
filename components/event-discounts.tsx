'use client'

import { useCallback, useEffect, useState } from 'react'
import { Plus, Trash2 } from 'lucide-react'
import { toast } from 'sonner'
import { api } from '@/lib/http'
import { formatPaise, rupeesToPaise } from '@/lib/money'
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
 * Discounts, shown on Payment review (client, 20 Jul 2026) rather than tucked under Billing
 * — that is where the money is read, so it is where it should be adjustable.
 *
 * The rule is unchanged: the COMBINED discount across every head stays ≤ 10% of the
 * proposal total and applies immediately; crossing the cap records the discount but holds
 * it behind one `discount_over_cap` request per proposal, so it takes effect only on
 * approval (BR-D2). Note the cap is measured against `proposal_total_paise`, which excludes
 * rooms by design — see SEED_ASSUMPTIONS §F10.
 *
 * Fetches its own list so the section can sit wherever it is needed without the parent
 * having to know about discounts.
 */

type DiscountRow = {
  id: string
  head: string
  amountPaise: number
  remark: string
  status: 'effective' | 'pending' | 'rejected'
  givenAt: string
}

const DISC_STATUS: Record<string, string> = {
  effective: 'text-emerald-600',
  pending: 'text-amber-600',
  rejected: 'text-muted-foreground line-through',
}

export function EventDiscounts({ eventId, editable }: { eventId: string; editable: boolean }) {
  const [discs, setDiscs] = useState<DiscountRow[]>([])
  const [head, setHead] = useState('venue')
  const [amount, setAmount] = useState('')
  const [remark, setRemark] = useState('')
  const [busy, setBusy] = useState(false)

  const load = useCallback(async () => {
    try {
      const d = await api<{ discounts: DiscountRow[] }>(`/events/${eventId}/discounts`)
      setDiscs(d.discounts)
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed to load discounts')
    }
  }, [eventId])

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load()
  }, [load])

  async function add() {
    const rupees = Number(amount)
    if (!Number.isFinite(rupees) || rupees <= 0 || !remark.trim()) {
      toast.error('Enter a positive amount and a remark')
      return
    }
    setBusy(true)
    try {
      const res = await api<{ deferred: boolean }>(`/events/${eventId}/discounts`, {
        method: 'POST',
        body: JSON.stringify({ head, amount_paise: rupeesToPaise(rupees), remark: remark.trim() }),
      })
      toast[res.deferred ? 'info' : 'success'](
        res.deferred ? 'Over the 10% cap — sent to the GM for approval.' : 'Discount applied',
      )
      setAmount('')
      setRemark('')
      await load()
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
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not remove')
    }
  }

  return (
    <div>
      <h3 className="mb-2 text-sm font-medium">Discounts</h3>
      {discs.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          None. The combined discount stays ≤ 10% of the proposal (over that needs GM approval).
        </p>
      ) : (
        <ul className="mb-2 space-y-1 text-sm">
          {discs.map((x) => (
            <li key={x.id} className="flex items-center justify-between gap-2">
              <span>
                <span className="capitalize">{x.head}</span> · {x.remark}
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
            <Select
              value={head}
              onValueChange={(v) => {
                if (v) setHead(v)
              }}
              items={[
                { value: 'venue', label: 'Venue' },
                { value: 'menu', label: 'Menu' },
                { value: 'overall', label: 'Overall' },
              ]}
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="venue">Venue</SelectItem>
                <SelectItem value="menu">Menu</SelectItem>
                <SelectItem value="overall">Overall</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="w-28 space-y-1">
            <Label className="text-xs">Amount ₹</Label>
            <Input inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} />
          </div>
          <div className="grow space-y-1">
            <Label className="text-xs">Remark (required)</Label>
            <Input value={remark} onChange={(e) => setRemark(e.target.value)} />
          </div>
          <Button variant="outline" onClick={add} disabled={busy}>
            <Plus className="size-4" /> Add
          </Button>
        </div>
      )}
    </div>
  )
}
