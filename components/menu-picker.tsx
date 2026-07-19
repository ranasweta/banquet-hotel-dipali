'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { ArrowLeftRight, Check, ChefHat, Loader2, Plus, Sparkles, Trash2, X } from 'lucide-react'
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
/** The pooled master menu: every tier's items for a sub-heading. Drives Swap. */
export type MenuPool = { categoryName: string; items: string[] }

type MenuCategorySnapshot = {
  categoryName: string
  basePick: number | null
  extraPicks: number
  effectivePick: number | null
  exceptionId: string | null
  exceptionPending: boolean
  exceptionStatus: string | null
  exceptionRemark: string | null
  selected: string[]
  notes: Record<string, string>
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
/** A chef-delicacy request on this function — priced per plate by the Chef. */
type ChefRequestRow = {
  id: string
  description: string
  status: 'pending' | 'priced' | 'declined'
  chargePaise: number | null
  remark: string | null
}
type MenuResponse = {
  subEvent: { id: string; pax: number; isWedding: boolean; editable: boolean }
  menu: MenuSnapshot | null
  addons: Addon[]
}

export function MenuPicker({
  subEventId,
  tiers,
  pools = [],
  canEdit,
  onChanged,
}: {
  subEventId: string
  tiers: CatalogTier[]
  pools?: MenuPool[]
  canEdit: boolean
  onChanged?: () => void
}) {
  const [resp, setResp] = useState<MenuResponse | null>(null)
  const [tierId, setTierId] = useState('')
  const [selected, setSelected] = useState<Record<string, Set<string>>>({})
  const [busy, setBusy] = useState(false)
  const [dirty, setDirty] = useState(false)
  const [swapOpen, setSwapOpen] = useState<string | null>(null)
  // categoryName -> itemName -> preference note ("dal spicy"). Free text, never priced.
  const [notes, setNotes] = useState<Record<string, Record<string, string>>>({})
  const [delicacy, setDelicacy] = useState('')
  const [delicacies, setDelicacies] = useState<ChefRequestRow[]>([])

  const loadDelicacies = useCallback(async () => {
    const r = await api<{ requests: ChefRequestRow[] }>(`/sub-events/${subEventId}/chef-requests`)
    setDelicacies(r.requests)
  }, [subEventId])

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    loadDelicacies().catch(() => setDelicacies([]))
  }, [loadDelicacies])

  const load = useCallback(async () => {
    const data = await api<MenuResponse>(`/sub-events/${subEventId}/menu`)
    setResp(data)
    if (data.menu) {
      setTierId(data.menu.tierId)
      const next: Record<string, Set<string>> = {}
      const nextNotes: Record<string, Record<string, string>> = {}
      for (const c of data.menu.categories) {
        next[c.categoryName] = new Set(c.selected)
        if (c.notes && Object.keys(c.notes).length) nextNotes[c.categoryName] = { ...c.notes }
      }
      setSelected(next)
      setNotes(nextNotes)
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

  /** A preference note on one dish — "dal spicy". Kitchen instruction only, never a charge. */
  function setItemNote(categoryName: string, item: string, note: string) {
    setNotes((prev) => {
      const forCat = { ...(prev[categoryName] ?? {}) }
      if (note.trim()) forCat[item] = note
      else delete forCat[item]
      return { ...prev, [categoryName]: forCat }
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
        body: JSON.stringify({ tier_id: tier.id, selections, notes }),
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

  /**
   * The other kind of increase: instead of one more pick from the printed list, the guest
   * asks for something off-menu. Only the Chef prices it, and that charge is per plate.
   */
  async function requestDelicacy() {
    const description = delicacy.trim()
    if (!description) return
    setBusy(true)
    try {
      await api(`/sub-events/${subEventId}/chef-requests`, {
        method: 'POST',
        body: JSON.stringify({ description }),
      })
      setDelicacy('')
      await loadDelicacies()
      toast.success('Sent to the Chef to price')
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not send the request')
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
              {/* The wedding surcharge is folded into the per-plate rate and deliberately not
                  called out — the guest knows the scheme; it's a back-office line (BR-M5). */}
              <span className="font-medium">{formatPaise(savedForThisTier.perPlatePaise)}</span>
              <span className="text-muted-foreground"> / plate</span>
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
                    {snap?.exceptionStatus === 'rejected' && (
                      <Badge
                        variant="outline"
                        className="text-red-600"
                        title={snap.exceptionRemark ?? undefined}
                      >
                        increase rejected{snap.exceptionRemark ? `: ${snap.exceptionRemark}` : ''}
                      </Badge>
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
                    {editable && !allIncluded && (
                      <Button
                        size="xs"
                        variant="ghost"
                        disabled={busy}
                        onClick={() => setSwapOpen((c) => (c === cat.name ? null : cat.name))}
                      >
                        <ArrowLeftRight className="size-3" /> swap
                      </Button>
                    )}
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
                      <div key={item}>
                        <label
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
                        {isChecked && (
                          <ItemNote
                            value={notes[cat.name]?.[item] ?? ''}
                            editable={editable}
                            onChange={(v) => setItemNote(cat.name, item, v)}
                          />
                        )}
                      </div>
                    )
                  })}

                  {/* Items swapped in from another tier's list — shown so they can be undone. */}
                  {!allIncluded &&
                    [...chosen]
                      .filter((item) => !cat.items.includes(item))
                      .map((item) => (
                        <div key={item}>
                          <label className="flex cursor-pointer items-center gap-2 rounded-md px-2 py-1 text-sm hover:bg-muted/50">
                            <Checkbox
                              checked
                              disabled={!editable}
                              onCheckedChange={(v) => toggleItem(cat, item, Boolean(v))}
                            />
                            <span>{item}</span>
                            <Badge variant="outline" className="text-violet-600">swapped</Badge>
                          </label>
                          <ItemNote
                            value={notes[cat.name]?.[item] ?? ''}
                            editable={editable}
                            onChange={(v) => setItemNote(cat.name, item, v)}
                          />
                        </div>
                      ))}
                </div>

                {swapOpen === cat.name && !allIncluded && (
                  <SwapPanel
                    pool={pools.find((p) => p.categoryName === cat.name)?.items ?? []}
                    ownItems={cat.items}
                    chosen={chosen}
                    atCeiling={cap != null && chosen.size >= cap}
                    onPick={(item) => toggleItem(cat, item, true)}
                    onClose={() => setSwapOpen(null)}
                  />
                )}
              </div>
            )
          })}
        </div>
      )}

      {/* Chef delicacy — the off-menu ask. Priced per plate by the Chef, never here. */}
      {tier && (
        <div className="rounded-lg border p-3">
          <div className="mb-1 flex items-center gap-2 text-sm font-medium">
            <ChefHat className="size-4 text-muted-foreground" aria-hidden />
            Chef delicacy
            <span className="font-normal text-xs text-muted-foreground">
              something off the menu — the Chef sets a per-plate charge
            </span>
          </div>
          {delicacies.length > 0 && (
            <ul className="mb-2 space-y-1 text-sm">
              {delicacies.map((r) => (
                <li key={r.id} className="flex items-center justify-between gap-2">
                  <span className="min-w-0 truncate">{r.description}</span>
                  <span
                    className={cn(
                      'shrink-0 rounded-full px-2 py-0.5 text-xs font-medium',
                      r.status === 'priced'
                        ? 'bg-emerald-100 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300'
                        : r.status === 'declined'
                          ? 'bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-400'
                          : 'bg-amber-100 text-amber-700 dark:bg-amber-950 dark:text-amber-300',
                    )}
                    title={r.remark ?? undefined}
                  >
                    {r.status === 'priced'
                      ? `${formatPaise(r.chargePaise ?? 0)}/plate`
                      : r.status === 'declined'
                        ? 'declined'
                        : 'awaiting chef'}
                  </span>
                </li>
              ))}
            </ul>
          )}
          {editable && (
            <div className="flex gap-2">
              <Input
                value={delicacy}
                onChange={(e) => setDelicacy(e.target.value)}
                placeholder="e.g. sushi counter for the head table"
                className="h-8"
              />
              <Button size="sm" variant="outline" disabled={busy || !delicacy.trim()} onClick={requestDelicacy}>
                Ask the chef
              </Button>
            </div>
          )}
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

/**
 * Swap: the pooled master menu for one sub-heading — every tier's items, not just this tier's.
 * Choosing one spends a pick from that sub-heading exactly like a normal choice (the tier's
 * per-plate rate is unaffected), so a Gold dessert can sit on a Silver plate.
 */
function SwapPanel({
  pool,
  ownItems,
  chosen,
  atCeiling,
  onPick,
  onClose,
}: {
  pool: string[]
  ownItems: string[]
  chosen: Set<string>
  atCeiling: boolean
  onPick: (item: string) => void
  onClose: () => void
}) {
  const [q, setQ] = useState('')
  const own = new Set(ownItems)
  const others = pool.filter((i) => !own.has(i))
  const shown = q.trim() ? others.filter((i) => i.toLowerCase().includes(q.trim().toLowerCase())) : others

  return (
    <div className="mt-2 rounded-md border bg-muted/30 p-2">
      <div className="mb-2 flex items-center justify-between gap-2">
        <span className="text-xs font-medium">
          From the full menu · {others.length} more
          {atCeiling && <span className="ml-1 text-amber-600">— picks used up, remove one first</span>}
        </span>
        <Button size="xs" variant="ghost" onClick={onClose}><X className="size-3" /></Button>
      </div>
      <Input
        value={q}
        onChange={(e) => setQ(e.target.value)}
        placeholder="Search the full menu…"
        className="mb-2 h-8"
      />
      {shown.length === 0 ? (
        <p className="px-1 py-2 text-xs text-muted-foreground">
          {others.length === 0 ? 'Nothing extra on other menus for this heading.' : 'No match.'}
        </p>
      ) : (
        <div className="flex max-h-56 flex-wrap gap-1 overflow-y-auto">
          {shown.map((item) => (
            <Button
              key={item}
              size="xs"
              variant="outline"
              disabled={atCeiling || chosen.has(item)}
              onClick={() => onPick(item)}
              title={chosen.has(item) ? 'Already chosen' : 'Uses one pick'}
            >
              {item}
            </Button>
          ))}
        </div>
      )}
    </div>
  )
}

/**
 * A free-text preference on a chosen dish — "dal spicy", "rasgulla less sugary". It reaches
 * the kitchen through the day sheet and never changes the price: only a chef-delicacy request
 * or a pick increase can move the per-plate rate.
 */
function ItemNote({
  value,
  editable,
  onChange,
}: {
  value: string
  editable: boolean
  onChange: (v: string) => void
}) {
  const [open, setOpen] = useState(Boolean(value))
  if (!editable && !value) return null
  if (!open) {
    return (
      <button
        type="button"
        className="ml-8 text-xs text-muted-foreground underline-offset-2 hover:underline"
        onClick={() => setOpen(true)}
      >
        + preference
      </button>
    )
  }
  return (
    <Input
      value={value}
      disabled={!editable}
      onChange={(e) => onChange(e.target.value)}
      onBlur={() => { if (!value.trim()) setOpen(false) }}
      placeholder="e.g. less spicy, less sugar"
      className="ml-8 h-7 w-[calc(100%-2rem)] text-xs"
    />
  )
}
