'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { Check, Loader2, Plus, Sparkles, Trash2 } from 'lucide-react'
import { toast } from 'sonner'
import { api } from '@/lib/http'
import { formatPaise, rupeesToPaise } from '@/lib/money'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Badge } from '@/components/ui/badge'
import { Checkbox } from '@/components/ui/checkbox'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { cn } from '@/lib/utils'

export type CatalogCategory = {
  id: string
  name: string
  pickCount: number | null
  freeIncreaseEligible: boolean
  items: string[]
}
export type CatalogTier = { id: string; name: string; categories: CatalogCategory[] }

type MenuCategorySnapshot = {
  categoryName: string
  basePick: number | null
  extraPicks: number
  effectivePick: number | null
  exceptionId: string | null
  exceptionPending: boolean
  selected: string[]
  complete: boolean
}
type MenuSnapshot = {
  tierId: string
  tierName: string
  baseRatePaise: number
  surchargePaise: number
  perPlatePaise: number
  isComplete: boolean
  isTentative: boolean
  freeIncreaseCategoryName: string | null
  freeIncreaseUsed: boolean
  categories: MenuCategorySnapshot[]
  foodTotalPaise: number
}
type Addon = { id: string; description: string; ratePaise: number; qty: number }
type MenuResponse = {
  subEvent: { id: string; pax: number; isWedding: boolean; editable: boolean }
  menu: MenuSnapshot | null
  addons: Addon[]
}

export function MenuPicker({
  subEventId,
  tiers,
  canEdit,
  onChanged,
}: {
  subEventId: string
  tiers: CatalogTier[]
  canEdit: boolean
  onChanged?: () => void
}) {
  const [resp, setResp] = useState<MenuResponse | null>(null)
  const [tierId, setTierId] = useState('')
  const [selected, setSelected] = useState<Record<string, Set<string>>>({})
  const [busy, setBusy] = useState(false)
  const [dirty, setDirty] = useState(false)

  const load = useCallback(async () => {
    const data = await api<MenuResponse>(`/sub-events/${subEventId}/menu`)
    setResp(data)
    if (data.menu) {
      setTierId(data.menu.tierId)
      const next: Record<string, Set<string>> = {}
      for (const c of data.menu.categories) next[c.categoryName] = new Set(c.selected)
      setSelected(next)
      setDirty(false)
    }
    return data
  }, [subEventId])

  useEffect(() => {
    // Async fetch seeds state after the await; the rule can't see past the promise.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    load().catch((e) => toast.error(e instanceof Error ? e.message : 'Failed to load menu'))
  }, [load])

  const tier = useMemo(() => tiers.find((t) => t.id === tierId), [tiers, tierId])
  const savedForThisTier = resp?.menu?.tierId === tierId ? resp!.menu : null
  const editable = canEdit && (resp?.subEvent.editable ?? false)
  const pax = resp?.subEvent.pax ?? 0

  /** Effective pick for a category: base + any snapshot extra (only when saved for this tier). */
  const effectivePick = (cat: CatalogCategory): number | null => {
    if (cat.pickCount == null) return null
    const snap = savedForThisTier?.categories.find((c) => c.categoryName === cat.name)
    return cat.pickCount + (snap?.extraPicks ?? 0)
  }

  function chooseTier(id: string) {
    setTierId(id)
    // Switching tiers starts a fresh selection (the snapshot for the old tier is dropped on save).
    const existing = resp?.menu?.tierId === id ? resp!.menu : null
    const next: Record<string, Set<string>> = {}
    if (existing) for (const c of existing.categories) next[c.categoryName] = new Set(c.selected)
    setSelected(next)
    setDirty(existing == null)
  }

  function toggleItem(cat: CatalogCategory, item: string, on: boolean) {
    setSelected((prev) => {
      const set = new Set(prev[cat.name] ?? [])
      const cap = effectivePick(cat)
      if (on) {
        if (cap != null && set.size >= cap) return prev // at ceiling; ignore
        set.add(item)
      } else {
        set.delete(item)
      }
      return { ...prev, [cat.name]: set }
    })
    setDirty(true)
  }

  async function save() {
    if (!tier) return
    setBusy(true)
    try {
      const selections: Record<string, string[]> = {}
      for (const c of tier.categories) {
        if (c.pickCount == null) continue // all-included: server fills the full list
        selections[c.name] = [...(selected[c.name] ?? [])]
      }
      await api(`/sub-events/${subEventId}/menu`, {
        method: 'PUT',
        body: JSON.stringify({ tier_id: tier.id, selections }),
      })
      await load()
      onChanged?.()
      toast.success('Menu saved')
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Save failed')
    } finally {
      setBusy(false)
    }
  }

  async function increase(category: string) {
    setBusy(true)
    try {
      const res = await api<{ applied: 'free' | 'exception' }>(
        `/sub-events/${subEventId}/menu/increase`,
        { method: 'POST', body: JSON.stringify({ category }) },
      )
      await load()
      if (res.applied === 'free') toast.success(`Free extra choice added to ${category}`)
      else toast.info(`${category} increase sent to the GM for approval`)
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not request increase')
    } finally {
      setBusy(false)
    }
  }

  if (!resp) {
    return (
      <div className="flex items-center gap-2 p-4 text-sm text-muted-foreground">
        <Loader2 className="size-4 animate-spin" /> Loading menu…
      </div>
    )
  }

  return (
    <div className="space-y-4">
      {/* Tier + price header */}
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="w-56 space-y-1.5">
          <div className="text-xs font-medium text-muted-foreground">Menu tier</div>
          <Select
            value={tierId}
            onValueChange={editable ? (v) => { if (v) chooseTier(v) } : undefined}
            items={tiers.map((t) => ({ value: t.id, label: t.name }))}
          >
            <SelectTrigger disabled={!editable}>
              <SelectValue placeholder="Choose a tier" />
            </SelectTrigger>
            <SelectContent>
              {tiers.map((t) => (
                <SelectItem key={t.id} value={t.id}>
                  {t.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        {savedForThisTier && (
          <div className="text-right text-sm">
            <div className="tabular-nums">
              <span className="font-medium">{formatPaise(savedForThisTier.perPlatePaise)}</span>
              <span className="text-muted-foreground"> / plate</span>
              {savedForThisTier.surchargePaise > 0 && (
                <Badge variant="outline" className="ml-2 text-amber-600">
                  incl. wedding +{formatPaise(savedForThisTier.surchargePaise)}
                </Badge>
              )}
            </div>
            <div className="text-xs text-muted-foreground tabular-nums">
              {pax} pax → {formatPaise(savedForThisTier.foodTotalPaise)} food
            </div>
          </div>
        )}
      </div>

      {!tier ? (
        <p className="text-sm text-muted-foreground">Pick a tier to build the menu.</p>
      ) : (
        <div className="space-y-3">
          {tier.categories.map((cat) => {
            const cap = effectivePick(cat)
            const chosen = selected[cat.name] ?? new Set<string>()
            const allIncluded = cat.pickCount == null
            const count = allIncluded ? cat.items.length : chosen.size
            const need = allIncluded ? cat.items.length : cap ?? 0
            const complete = allIncluded || chosen.size >= (cap ?? 0)
            const snap = savedForThisTier?.categories.find((c) => c.categoryName === cat.name)
            return (
              <div key={cat.id} className="rounded-lg border p-3">
                <div className="mb-2 flex items-center justify-between gap-2">
                  <div className="flex items-center gap-2">
                    <span className="font-medium">{cat.name}</span>
                    {allIncluded ? (
                      <Badge variant="outline" className="text-muted-foreground">all included</Badge>
                    ) : (
                      <Badge variant="outline">pick {cap}</Badge>
                    )}
                    {cat.freeIncreaseEligible && !allIncluded && (
                      <Sparkles className="size-3.5 text-amber-500" aria-label="free increase eligible" />
                    )}
                    {snap?.exceptionPending && (
                      <Badge variant="outline" className="text-amber-600">awaiting approval</Badge>
                    )}
                  </div>
                  <div className="flex items-center gap-2">
                    <span
                      className={cn(
                        'text-xs tabular-nums',
                        complete ? 'text-emerald-600' : 'text-muted-foreground',
                      )}
                    >
                      {complete && <Check className="mr-0.5 inline size-3" />}
                      {count} / {need}
                    </span>
                    {editable && !allIncluded && savedForThisTier && (
                      <Button
                        size="xs"
                        variant="ghost"
                        disabled={busy}
                        onClick={() => increase(cat.name)}
                      >
                        <Plus className="size-3" /> increase
                      </Button>
                    )}
                  </div>
                </div>
                <div className="grid grid-cols-1 gap-1.5 sm:grid-cols-2">
                  {cat.items.map((item) => {
                    const isChecked = allIncluded || chosen.has(item)
                    const atCeiling = !allIncluded && cap != null && chosen.size >= cap && !chosen.has(item)
                    return (
                      <label
                        key={item}
                        className={cn(
                          'flex items-center gap-2 rounded-md px-2 py-1 text-sm',
                          allIncluded ? 'text-muted-foreground' : 'cursor-pointer hover:bg-muted/50',
                          atCeiling && 'opacity-50',
                        )}
                      >
                        <Checkbox
                          checked={isChecked}
                          disabled={!editable || allIncluded || atCeiling}
                          onCheckedChange={(v) => toggleItem(cat, item, Boolean(v))}
                        />
                        <span>{item}</span>
                      </label>
                    )
                  })}
                </div>
              </div>
            )
          })}
        </div>
      )}

      {editable && tier && (
        <div className="flex items-center gap-2">
          <Button onClick={save} disabled={busy || !dirty}>
            {busy && <Loader2 className="size-4 animate-spin" />}
            Save menu
          </Button>
          {savedForThisTier && (
            <span className="text-xs text-muted-foreground">
              {savedForThisTier.isComplete ? 'All categories complete' : 'Incomplete — you can finish later'}
              {savedForThisTier.isTentative && ' · tentative'}
            </span>
          )}
        </div>
      )}

      <AddonEditor
        subEventId={subEventId}
        addons={resp.addons}
        editable={editable}
        onChanged={async () => {
          await load()
          onChanged?.()
        }}
      />
    </div>
  )
}

function AddonEditor({
  subEventId,
  addons,
  editable,
  onChanged,
}: {
  subEventId: string
  addons: { id: string; description: string; ratePaise: number; qty: number }[]
  editable: boolean
  onChanged: () => void | Promise<void>
}) {
  const [desc, setDesc] = useState('')
  const [rate, setRate] = useState('')
  const [qty, setQty] = useState('1')
  const [busy, setBusy] = useState(false)

  async function add() {
    const rupees = Number(rate)
    const q = Number(qty)
    if (!desc.trim() || !Number.isFinite(rupees) || rupees < 0 || !Number.isInteger(q) || q < 1) {
      toast.error('Enter a description, a non-negative rate and a whole quantity')
      return
    }
    setBusy(true)
    try {
      await api(`/sub-events/${subEventId}/addons`, {
        method: 'POST',
        body: JSON.stringify({ description: desc.trim(), rate_paise: rupeesToPaise(rupees), qty: q }),
      })
      setDesc('')
      setRate('')
      setQty('1')
      await onChanged()
      toast.success('Add-on added')
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not add')
    } finally {
      setBusy(false)
    }
  }

  async function remove(id: string) {
    setBusy(true)
    try {
      await api(`/addons/${id}`, { method: 'DELETE' })
      await onChanged()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not remove')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="rounded-lg border border-dashed p-3">
      <div className="mb-2 text-sm font-medium">Add-ons (outside the tier)</div>
      {addons.length === 0 ? (
        <p className="text-xs text-muted-foreground">None. Paan counter, extra live counter, etc.</p>
      ) : (
        <ul className="mb-2 space-y-1">
          {addons.map((a) => (
            <li key={a.id} className="flex items-center justify-between gap-2 text-sm">
              <span>
                {a.description} <span className="text-muted-foreground">× {a.qty}</span>
              </span>
              <span className="flex items-center gap-2 tabular-nums">
                {formatPaise(a.ratePaise * a.qty)}
                {editable && (
                  <Button size="icon-xs" variant="ghost" disabled={busy} onClick={() => remove(a.id)}>
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
          <div className="grow">
            <Input placeholder="Description" value={desc} onChange={(e) => setDesc(e.target.value)} />
          </div>
          <div className="w-28">
            <Input placeholder="Rate ₹" inputMode="decimal" value={rate} onChange={(e) => setRate(e.target.value)} />
          </div>
          <div className="w-16">
            <Input placeholder="Qty" inputMode="numeric" value={qty} onChange={(e) => setQty(e.target.value)} />
          </div>
          <Button variant="outline" onClick={add} disabled={busy}>
            <Plus className="size-4" /> Add
          </Button>
        </div>
      )}
    </div>
  )
}
