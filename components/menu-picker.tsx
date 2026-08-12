'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ArrowLeftRight, Check, ChefHat, ChevronDown, ChevronRight, Loader2, Plus, Sparkles, Trash2, X } from 'lucide-react'
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
import { menuItemKey } from '@/lib/menu-name'
import { cn } from '@/lib/utils'

export type CatalogCategory = {
  id: string
  name: string
  pickCount: number | null
  freeIncreaseEligible: boolean
  items: string[]
}
export type CatalogTier = { id: string; name: string; baseRatePaise: number; categories: CatalogCategory[] }
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
  /** Increase pressed here: picking is unbounded and the tail of `selected` are extras. */
  increaseUnlocked: boolean
  /** Which of `selected` are extras — rendered apart. */
  extras: string[]
  notes: Record<string, string>
  complete: boolean
}

/** What this function's submit button would carry to the Higher Authority. */
type IncreaseSummary = {
  subEventId: string
  subEventName?: string
  totalExtras: number
  freeCovered?: number
  awaitingSubmission: number
  alreadySubmitted?: number
  segments: { categoryName: string; basePick: number; extraPicks: number; submitted: number; items: string[] }[]
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
  // Ordered, not a Set: everything picked beyond a segment's base count is an extra, and
  // which dishes those are is decided by the order they were clicked in (see lib/menus.ts).
  const [selected, setSelected] = useState<Record<string, string[]>>({})
  const [busy, setBusy] = useState(false)
  const [dirty, setDirty] = useState(false)
  const [swapOpen, setSwapOpen] = useState<string | null>(null)
  // categoryName -> itemName -> preference note ("dal spicy"). Free text, never priced.
  const [notes, setNotes] = useState<Record<string, Record<string, string>>>({})
  const [increases, setIncreases] = useState<IncreaseSummary | null>(null)
  const [delicacy, setDelicacy] = useState('')
  const [delicacies, setDelicacies] = useState<ChefRequestRow[]>([])
  const [saving, setSaving] = useState(false)
  const [savedAt, setSavedAt] = useState<Date | null>(null)
  /**
   * Every local edit bumps `revision`. A save against a remote database takes seconds, and
   * the manager keeps clicking through them: without this, the server snapshot that arrives
   * afterwards overwrites everything picked in the meantime, and the dishes visibly roll
   * back. The ref is what `save` reads (it must not close over a stale render); the state
   * is what restarts the debounce.
   */
  const [revision, setRevision] = useState(0)
  const revisionRef = useRef(0)
  const selectedRef = useRef(selected)
  const notesRef = useRef(notes)
  const savingRef = useRef(false)
  const pendingRef = useRef(false)

  useEffect(() => { selectedRef.current = selected }, [selected])
  useEffect(() => { notesRef.current = notes }, [notes])

  /** Marks the menu edited: restarts the debounce and invalidates any save in flight. */
  const touch = useCallback(() => {
    revisionRef.current += 1
    setRevision(revisionRef.current)
    setDirty(true)
  }, [])

  /** Snapshot taken before a tier switch, so the wipe it causes can be undone. */
  const [undoTier, setUndoTier] = useState<
    { tierId: string; selected: Record<string, string[]>; notes: Record<string, Record<string, string>> } | null
  >(null)

  const loadDelicacies = useCallback(async () => {
    const r = await api<{ requests: ChefRequestRow[] }>(`/sub-events/${subEventId}/chef-requests`)
    setDelicacies(r.requests)
  }, [subEventId])

  const loadIncreases = useCallback(async () => {
    const r = await api<IncreaseSummary>(`/sub-events/${subEventId}/menu/increase/submit`)
    setIncreases(r)
  }, [subEventId])

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    loadDelicacies().catch(() => setDelicacies([]))
  }, [loadDelicacies])

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    loadIncreases().catch(() => setIncreases(null))
  }, [loadIncreases])

  /**
   * Takes the server's snapshot as authoritative. Split out of `load` because a save now
   * carries the same snapshot back in its own response — one round trip instead of a write
   * followed by a read, which is the whole point.
   */
  const adopt = useCallback((data: MenuResponse) => {
    setResp(data)
    if (data.menu) {
      setTierId(data.menu.tierId)
      const next: Record<string, string[]> = {}
      const nextNotes: Record<string, Record<string, string>> = {}
      for (const c of data.menu.categories) {
        next[c.categoryName] = [...c.selected]
        if (c.notes && Object.keys(c.notes).length) nextNotes[c.categoryName] = { ...c.notes }
      }
      setSelected(next)
      setNotes(nextNotes)
      setDirty(false)
    }
  }, [])

  const load = useCallback(async () => {
    const data = await api<MenuResponse>(`/sub-events/${subEventId}/menu`)
    adopt(data)
    return data
  }, [subEventId, adopt])

  useEffect(() => {
    // Async fetch seeds state after the await; the rule can't see past the promise.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    load().catch((e) => toast.error(e instanceof Error ? e.message : 'Failed to load menu'))
  }, [load])

  const tier = useMemo(() => tiers.find((t) => t.id === tierId), [tiers, tierId])
  const savedForThisTier = resp?.menu?.tierId === tierId ? resp!.menu : null
  /** Has Increase been pressed on this segment? Unlocked segments have no ceiling. */
  const isUnlocked = (categoryName: string): boolean =>
    savedForThisTier?.categories.find((c) => c.categoryName === categoryName)?.increaseUnlocked ?? false

  const editable = canEdit && (resp?.subEvent.editable ?? false)
  const pax = resp?.subEvent.pax ?? 0

  /** Effective pick for a category: base + any snapshot extra (only when saved for this tier). */
  const effectivePick = (cat: CatalogCategory): number | null => {
    if (cat.pickCount == null) return null
    const snap = savedForThisTier?.categories.find((c) => c.categoryName === cat.name)
    return cat.pickCount + (snap?.extraPicks ?? 0)
  }

  function chooseTier(id: string) {
    if (id === tierId) return
    // Switching tiers starts a fresh selection, so keep the old one to hand: with auto-save
    // on, an accidental switch would otherwise wipe a menu that took days to assemble.
    const hadChoices = Object.values(selected).some((s) => s.length > 0)
    if (hadChoices) {
      setUndoTier({ tierId, selected, notes })
      toast('Menu tier changed — the previous choices were cleared.', {
        action: { label: 'Undo', onClick: () => restoreTier() },
        duration: 10_000,
      })
    }

    setTierId(id)
    const existing = resp?.menu?.tierId === id ? resp!.menu : null
    const next: Record<string, string[]> = {}
    const nextNotes: Record<string, Record<string, string>> = {}
    if (existing) {
      for (const c of existing.categories) {
        next[c.categoryName] = [...c.selected]
        if (c.notes && Object.keys(c.notes).length) nextNotes[c.categoryName] = { ...c.notes }
      }
    }
    setSelected(next)
    setNotes(nextNotes)
    touch()
  }

  /** Puts back the tier and the choices that were cleared by the last switch. */
  function restoreTier() {
    setUndoTier((prev) => {
      if (!prev) return null
      setTierId(prev.tierId)
      setSelected(prev.selected)
      setNotes(prev.notes)
      touch()
      return null
    })
  }

  function toggleItem(cat: CatalogCategory, item: string, on: boolean) {
    setSelected((prev) => {
      const list = prev[cat.name] ?? []
      if (on) {
        if (list.includes(item)) return prev
        // An unlocked segment has no ceiling — that is what Increase buys. A locked one
        // still stops at its printed count.
        if (!isUnlocked(cat.name) && cat.pickCount != null && list.length >= cat.pickCount) return prev
        return { ...prev, [cat.name]: [...list, item] }
      }
      return { ...prev, [cat.name]: list.filter((i) => i !== item) }
    })
    touch()
  }

  /** A preference note on one dish — "dal spicy". Kitchen instruction only, never a charge. */
  function setItemNote(categoryName: string, item: string, note: string) {
    setNotes((prev) => {
      const forCat = { ...(prev[categoryName] ?? {}) }
      if (note.trim()) forCat[item] = note
      else delete forCat[item]
      return { ...prev, [categoryName]: forCat }
    })
    touch()
  }

  const save = useCallback(async () => {
    if (!tier) return
    // One save at a time. Two overlapping PUTs can land out of order, and the older payload
    // would win — silently dropping whatever was picked in between.
    if (savingRef.current) {
      pendingRef.current = true
      return
    }
    savingRef.current = true
    setSaving(true)
    try {
      // Keep sending until what we sent IS what is on screen. A save takes seconds against a
      // remote database and the manager carries on clicking; adopting the server's snapshot
      // after that would roll their choices back.
      for (;;) {
        pendingRef.current = false
        const rev = revisionRef.current
        const snapSelected = selectedRef.current
        const snapNotes = notesRef.current

        const selections: Record<string, string[]> = {}
        for (const c of tier.categories) {
          if (c.pickCount == null) continue // all-included: server fills the full list
          selections[c.name] = [...(snapSelected[c.name] ?? [])]
        }
        const saved = await api<{ snapshot: MenuResponse; increases: IncreaseSummary }>(
          `/sub-events/${subEventId}/menu`,
          {
            method: 'PUT',
            body: JSON.stringify({ tier_id: tier.id, selections, notes: snapNotes }),
          },
        )

        // Edited while that was in flight — go round again rather than overwrite them.
        if (revisionRef.current !== rev || pendingRef.current) continue

        // Settled. The save already carried the new state back, so there is nothing to fetch:
        // this used to be two more round trips after every click. `adopt` applies the
        // server's snapshot exactly as `load()` did.
        adopt(saved.snapshot)
        setIncreases(saved.increases)
        setSavedAt(new Date())
        onChanged?.()
        break
      }
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Save failed')
    } finally {
      savingRef.current = false
      setSaving(false)
    }
    // Reads its payload from refs, so it never closes over a stale render and stays stable
    // across edits — the debounce below is what re-triggers it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tier, subEventId])

  /**
   * Auto-save. Picking a menu can span days, so nothing waits on a Save button — every
   * change is persisted a beat after it settles, and the header says where it stands.
   */
  useEffect(() => {
    if (!dirty || !editable || !tier) return
    // `revision` is in the deps so each click restarts the window instead of firing one save
    // from the first click of a burst.
    //
    // Two seconds rather than the original 0.7. A manager picking dishes for a guest works in
    // runs — five or six ticks in a conversation, then a pause — and the shorter window cut
    // those runs into several saves apiece. Two seconds swallows a run whole and still lands
    // well inside the pause before the next one. It is only safe because of the flush below:
    // widening the window widens what an unmount would otherwise throw away.
    const t = setTimeout(() => { void save() }, 2000)
    return () => clearTimeout(t)
  }, [dirty, revision, editable, tier, save])

  /**
   * Flush on the way out. The debounce above cancels its own timer when the picker unmounts —
   * closing the function, moving to the next step, leaving the wizard — so without this the
   * last couple of seconds of picking would be silently dropped, and the longer the window the
   * more there is to lose. Refs, so the effect can stay mount-only and still see current state.
   */
  const dirtyRef = useRef(dirty)
  const saveRef = useRef(save)
  useEffect(() => { dirtyRef.current = dirty }, [dirty])
  useEffect(() => { saveRef.current = save }, [save])
  useEffect(
    () => () => {
      // Not awaited: unmount cannot wait. The request outlives the component for any
      // navigation inside the app, which is every case this covers.
      if (dirtyRef.current) void saveRef.current()
    },
    [],
  )

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

  /**
   * Increase does not add "+1". It UNLOCKS the segment: from here the guest may take as
   * many dishes from it as they like, and everything past the printed count shows as an
   * extra. Two extras per FUNCTION are free; the rest go to the GM when this function's
   * submit button is pressed.
   */
  async function increase(category: string) {
    setBusy(true)
    try {
      const res = await api<{ freeRemaining: number }>(
        `/sub-events/${subEventId}/menu/increase`,
        { method: 'POST', body: JSON.stringify({ category }) },
      )
      // In parallel: they are independent, and sequentially they double the wait after
      // every press — the same reason `save` reads them together.
      await Promise.all([load(), loadIncreases()])
      toast.success(
        res.freeRemaining > 0
          ? `${category} unlocked — ${res.freeRemaining} free extra${res.freeRemaining === 1 ? '' : 's'} left on this function`
          : `${category} unlocked — further dishes will need the GM's approval`,
      )
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not unlock the segment')
    } finally {
      setBusy(false)
    }
  }

  /** Sends this function's extras beyond the free two to the Higher Authority. */
  async function submitIncreases() {
    setBusy(true)
    try {
      const res = await api<{ submitted: number }>(
        `/sub-events/${subEventId}/menu/increase/submit`,
        { method: 'POST' },
      )
      // In parallel: they are independent, and sequentially they double the wait after
      // every press — the same reason `save` reads them together.
      await Promise.all([load(), loadIncreases()])
      toast.success(
        res.submitted > 0
          ? `${res.submitted} extra dish${res.submitted === 1 ? '' : 'es'} sent to the GM`
          : 'Nothing outstanding — everything is inside the free allowance',
      )
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not send the increases')
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
        {/* No rate shown while dishes are being chosen: pricing is internal to this step
            (client, 20 Jul 2026). The per-plate figure — already carrying the wedding
            surcharge (BR-M5) — appears once on Payment review and on the Draft. */}
        {savedForThisTier && (
          <div className="text-right text-xs text-muted-foreground tabular-nums">
            {pax} pax
          </div>
        )}
      </div>

      {!tier ? (
        <p className="text-sm text-muted-foreground">Pick a tier to build the menu.</p>
      ) : (
        <div className="space-y-3">
          {tier.categories.map((cat) => {
            const cap = effectivePick(cat)
            const chosen = selected[cat.name] ?? []
            const allIncluded = cat.pickCount == null
            const unlocked = isUnlocked(cat.name)
            // Extras are the picks past the printed count — the tail of the array.
            const base = cat.pickCount ?? 0
            const extraCount = allIncluded ? 0 : Math.max(0, chosen.length - base)
            const count = allIncluded ? cat.items.length : chosen.length
            const need = allIncluded ? cat.items.length : cap ?? 0
            const complete = allIncluded || chosen.length >= base
            const snap = savedForThisTier?.categories.find((c) => c.categoryName === cat.name)
            return (
              <div key={cat.id} className="rounded-lg border p-3">
                {/* Wraps rather than overflows: on a phone a two-line category name ("Veg
                    Appetizer") used to push the count and the swap/increase buttons past the
                    right edge of the card, where they could not be reached. */}
                <div className="mb-2 flex flex-wrap items-center justify-between gap-x-2 gap-y-1.5">
                  <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
                    <span className="font-medium">{cat.name}</span>
                    {allIncluded ? (
                      <Badge variant="outline" className="text-muted-foreground">all included</Badge>
                    ) : (
                      <Badge variant="outline">pick {cap}</Badge>
                    )}
                    {/* Only the count of extras taken, never the word "unlimited" — a guest
                        reading it over the manager's shoulder would take that as "free",
                        when everything past the free two is the Authority's to price. */}
                    {unlocked && extraCount > 0 && (
                      <Badge
                        variant="outline"
                        className="border-violet-400 text-violet-700 dark:border-violet-600 dark:text-violet-300"
                      >
                        +{extraCount}
                      </Badge>
                    )}
                    {cat.freeIncreaseEligible && !allIncluded && !unlocked && (
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
                  <div className="flex shrink-0 items-center gap-2">
                    <span
                      className={cn(
                        'inline-flex shrink-0 items-center gap-1 whitespace-nowrap rounded-full px-2 py-0.5 text-xs font-medium tabular-nums',
                        complete
                          ? 'bg-emerald-50 text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-400'
                          : 'bg-muted text-muted-foreground',
                      )}
                    >
                      {complete && <Check className="size-3" />}
                      {unlocked ? `${count} picked` : `${count} of ${need}`}
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
                    {editable && !allIncluded && savedForThisTier && !unlocked && (
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
                    const isChecked = allIncluded || chosen.includes(item)
                    // An unlocked segment has no ceiling; a locked one stops at its count.
                    const atCeiling =
                      !allIncluded && !unlocked && chosen.length >= base && !chosen.includes(item)
                    // Picked past the printed count — the guest's addition, coloured apart.
                    const isExtra = !allIncluded && chosen.indexOf(item) >= base
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
                          {/* Extras read apart from the base picks, so it is obvious at a
                              glance what the guest has added beyond the tier. */}
                          <span className={cn(isExtra && 'font-medium text-violet-700 dark:text-violet-400')}>
                            {item}
                          </span>
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
                            <Badge variant="outline" className="text-primary">swapped</Badge>
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
                    atCeiling={!unlocked && chosen.length >= base}
                    onPick={(item) => toggleItem(cat, item, true)}
                    onClose={() => setSwapOpen(null)}
                  />
                )}
              </div>
            )
          })}
        </div>
      )}

      {/* Extra dishes — the same shape as a chef delicacy request, and pressed the same way:
          when this function is finished, not when the event locks. Pre-filled with what has
          actually been ticked, so the GM decides on dishes rather than on a number. */}
      {tier && increases && increases.totalExtras > 0 && (
        <div className="rounded-lg border border-violet-300 p-3 dark:border-violet-800">
          <div className="mb-1 flex items-center gap-2 text-sm font-medium">
            <Plus className="size-4 text-violet-600 dark:text-violet-400" aria-hidden />
            Extra dishes
            <span className="text-xs font-normal text-muted-foreground">
              two per function are free — the rest need the GM
            </span>
          </div>

          <ul className="mb-2 space-y-1 text-sm">
            {increases.segments.map((seg) => (
              <li key={seg.categoryName} className="flex items-baseline justify-between gap-2">
                <span className="min-w-0">
                  <span className="text-muted-foreground">{seg.categoryName}</span>{' '}
                  <span className="text-violet-700 dark:text-violet-400">{seg.items.join(', ')}</span>
                </span>
                {seg.submitted > 0 && (
                  <span className="shrink-0 text-xs text-muted-foreground">{seg.submitted} sent</span>
                )}
              </li>
            ))}
          </ul>

          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="text-xs text-muted-foreground">
              {increases.totalExtras} extra{increases.totalExtras === 1 ? '' : 's'} ·{' '}
              {increases.freeCovered ?? 0} free
              {increases.awaitingSubmission > 0
                ? ` · ${increases.awaitingSubmission} awaiting the GM`
                : ' · nothing outstanding'}
            </p>
            {editable && (
              <Button
                size="sm"
                variant="outline"
                disabled={busy || increases.awaitingSubmission === 0}
                onClick={submitIncreases}
              >
                Send {increases.awaitingSubmission > 0 ? increases.awaitingSubmission : ''} to the GM
              </Button>
            )}
          </div>
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
                          ? 'bg-muted text-muted-foreground'
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
        <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
          {/* Saved as you go — a menu can take days to settle, so nothing waits on a button. */}
          {saving ? (
            <span className="inline-flex items-center gap-1"><Loader2 className="size-3 animate-spin" /> Saving…</span>
          ) : dirty ? (
            <span>Unsaved changes…</span>
          ) : savedAt ? (
            <span className="inline-flex items-center gap-1 text-emerald-600 dark:text-emerald-400">
              <Check className="size-3" /> Saved automatically
            </span>
          ) : (
            <span>Changes save automatically</span>
          )}
          {undoTier && (
            <Button size="xs" variant="ghost" onClick={restoreTier}>
              Undo tier change
            </Button>
          )}
          {savedForThisTier && (
            <span>
              · {savedForThisTier.isComplete ? 'All categories complete' : 'Incomplete — you can finish later'}
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

      <BarEditor subEventId={subEventId} editable={editable} onChanged={onChanged} />
    </div>
  )
}

type BarLine = { id: string; brandId: string; brandName: string; ratePaise: number; bottles: number; totalPaise: number }
type BarBrand = { id: string; name: string; pricePerBottlePaise: number }

/**
 * The bar for one function (client, 12 Aug 2026): a brand off the Auditor's priced list and a
 * number of bottles. Nothing is typed twice — the price comes from the catalogue, so it cannot
 * be remembered wrong here, and the line reaches the bill on its own.
 *
 * Collapsed until asked for, because most bookings take no alcohol and an empty panel on every
 * function is noise. It opens by itself when the function already has bottles on it, so a
 * closed panel always means an empty one.
 */
function BarEditor({
  subEventId,
  editable,
  onChanged,
}: {
  subEventId: string
  editable: boolean
  onChanged?: () => void | Promise<void>
}) {
  const [open, setOpen] = useState(false)
  const [lines, setLines] = useState<BarLine[]>([])
  const [brands, setBrands] = useState<BarBrand[]>([])
  const [loaded, setLoaded] = useState(false)
  const [query, setQuery] = useState('')
  const [brandId, setBrandId] = useState('')
  const [bottles, setBottles] = useState('1')
  const [busy, setBusy] = useState(false)

  const load = useCallback(async () => {
    const r = await api<{ lines: BarLine[]; brands: BarBrand[] }>(`/sub-events/${subEventId}/bar`)
    setLines(r.lines)
    setBrands(r.brands)
    setLoaded(true)
    // Bottles already on the function: show them rather than hide them behind a click.
    if (r.lines.length > 0) setOpen(true)
  }, [subEventId])

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    load().catch(() => setLoaded(true))
  }, [load])

  async function run(fn: () => Promise<unknown>, done: string) {
    setBusy(true)
    try {
      await fn()
      await load()
      await onChanged?.()
      toast.success(done)
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'That did not work')
    } finally {
      setBusy(false)
    }
  }

  const total = lines.reduce((s, l) => s + l.totalPaise, 0)
  // Searched, not scrolled: the list is a liquor cabinet, not a menu segment.
  const matches = brands
    .filter((b) => !query.trim() || b.name.toLowerCase().includes(query.trim().toLowerCase()))
    .slice(0, 8)

  if (!loaded) return null

  return (
    <div className="rounded-lg border border-dashed p-3">
      <button
        type="button"
        className="flex w-full items-center gap-2 text-left text-sm font-medium focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
        onClick={() => setOpen((v) => !v)}
      >
        {open ? <ChevronDown className="size-4" /> : <ChevronRight className="size-4" />}
        Alcohol
        {lines.length > 0 && (
          <span className="ml-auto tabular-nums text-muted-foreground">
            {lines.length} brand{lines.length === 1 ? '' : 's'} · {formatPaise(total)}
          </span>
        )}
      </button>

      {open && (
        <div className="mt-3 space-y-3">
          {lines.length === 0 ? (
            <p className="text-xs text-muted-foreground">
              None on this function. Prices come from the bar list the Auditor keeps.
            </p>
          ) : (
            <ul className="space-y-1">
              {lines.map((l) => (
                <li key={l.id} className="flex items-center justify-between gap-2 text-sm">
                  <span>
                    {l.brandName}{' '}
                    <span className="text-muted-foreground">
                      × {l.bottles} bottle{l.bottles === 1 ? '' : 's'} @ {formatPaise(l.ratePaise)}
                    </span>
                  </span>
                  <span className="flex items-center gap-2 tabular-nums">
                    {formatPaise(l.totalPaise)}
                    {editable && (
                      <Button
                        size="icon-xs"
                        variant="ghost"
                        disabled={busy}
                        title={`Remove ${l.brandName}`}
                        onClick={() => run(() => api(`/bar-lines/${l.id}`, { method: 'DELETE' }), `${l.brandName} removed`)}
                      >
                        <Trash2 className="size-3" />
                      </Button>
                    )}
                  </span>
                </li>
              ))}
            </ul>
          )}

          {editable && brands.length === 0 && (
            <p className="text-xs text-muted-foreground">
              The bar list is empty — the Auditor adds brands and their per-bottle price under Menu master.
            </p>
          )}

          {editable && brands.length > 0 && (
            <div className="space-y-2 rounded-md bg-muted/40 p-2">
              <Input
                placeholder="Search a brand…"
                value={query}
                onChange={(e) => {
                  setQuery(e.target.value)
                  setBrandId('')
                }}
                className="h-9"
              />
              {query.trim() && !brandId && (
                <ul className="max-h-40 overflow-y-auto rounded-md border bg-background">
                  {matches.length === 0 ? (
                    <li className="p-2 text-xs text-muted-foreground">No brand by that name.</li>
                  ) : (
                    matches.map((b) => (
                      <li key={b.id}>
                        <button
                          type="button"
                          className="flex w-full items-center justify-between gap-2 p-2 text-left text-sm hover:bg-muted"
                          onClick={() => {
                            setBrandId(b.id)
                            setQuery(b.name)
                          }}
                        >
                          <span className="truncate">{b.name}</span>
                          <span className="tabular-nums text-muted-foreground">{formatPaise(b.pricePerBottlePaise)}</span>
                        </button>
                      </li>
                    ))
                  )}
                </ul>
              )}
              <div className="flex flex-wrap items-end gap-2">
                <div className="w-24">
                  <Input
                    placeholder="Bottles"
                    inputMode="numeric"
                    value={bottles}
                    onChange={(e) => setBottles(e.target.value)}
                  />
                </div>
                <Button
                  variant="outline"
                  disabled={busy || !brandId || !Number.isInteger(Number(bottles)) || Number(bottles) < 1}
                  onClick={async () => {
                    const name = brands.find((b) => b.id === brandId)?.name ?? 'Brand'
                    await run(
                      () =>
                        api(`/sub-events/${subEventId}/bar`, {
                          method: 'PUT',
                          body: JSON.stringify({ brand_id: brandId, bottles: Number(bottles) }),
                        }),
                      // Ordering a brand already on the function replaces its count rather than
                      // adding a second line, so the message says "set", not "added".
                      `${name} set to ${bottles} bottle${Number(bottles) === 1 ? '' : 's'}`,
                    )
                    setBrandId('')
                    setQuery('')
                    setBottles('1')
                  }}
                >
                  <Plus className="size-4" /> Add
                </Button>
              </div>
            </div>
          )}
        </div>
      )}
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
  chosen: string[]
  atCeiling: boolean
  onPick: (item: string) => void
  onClose: () => void
}) {
  const [q, setQ] = useState('')
  // Compare by identity, not spelling: the tier may list "Aam Pana (Seasonal)" while the pool
  // carries "Aam Panna", and offering that as something new is just noise.
  const own = new Set([...ownItems, ...chosen].map(menuItemKey))
  const others = pool.filter((i) => !own.has(menuItemKey(i)))
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
              disabled={atCeiling || chosen.includes(item)}
              onClick={() => onPick(item)}
              title={chosen.includes(item) ? 'Already chosen' : 'Uses one pick'}
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
