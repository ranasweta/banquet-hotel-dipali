'use client'

import { useCallback, useEffect, useState } from 'react'
import { ChevronDown, ChevronRight, Loader2, Pencil, Plus, RotateCcw, Trash2 } from 'lucide-react'
import { toast } from 'sonner'
import { api } from '@/lib/http'
import { formatPaise, rupeesToPaise } from '@/lib/money'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Badge } from '@/components/ui/badge'
import { Checkbox } from '@/components/ui/checkbox'
import { cn } from '@/lib/utils'

/**
 * The menu master: the hotel's printed card, kept current.
 *
 * The thing this screen has to make obvious is that **re-pricing a tier does not re-price a
 * booked event**. Menus snapshot their rate at save (BR-M1) and read it effective on the
 * event's own date, so a rate dated 1 April prices April's weddings and leaves March's
 * alone. Every price control here is therefore dated, and the confirmation says how many
 * saved menus are unaffected rather than leaving the manager to hope.
 */

type Item = { id: string; name: string; isActive: boolean }
type Category = {
  id: string
  name: string
  pickCount: number | null
  freeIncreaseEligible: boolean
  sortOrder: number
  items: Item[]
}
type Price = { effectiveFrom: string; baseRatePaise: number; weddingSurchargePaise: number; current: boolean }
type Tier = { id: string; name: string; prices: Price[]; categories: Category[]; savedMenus: number }

const today = () => new Date().toLocaleDateString('en-CA')

export function MenuMaster({ canEdit, canDelete }: { canEdit: boolean; canDelete: boolean }) {
  const [tiers, setTiers] = useState<Tier[] | null>(null)
  const [open, setOpen] = useState<Set<string>>(new Set())
  const [busy, setBusy] = useState(false)
  const [newTier, setNewTier] = useState(false)

  const load = useCallback(async () => {
    const r = await api<{ tiers: Tier[] }>('/menu/master')
    setTiers(r.tiers)
  }, [])

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    load().catch((e: Error) => toast.error(e.message))
  }, [load])

  /** Every write funnels through here so one failure can't leave the screen out of step. */
  const run = useCallback(
    async (fn: () => Promise<unknown>, done: string) => {
      setBusy(true)
      try {
        await fn()
        await load()
        toast.success(done)
        return true
      } catch (e) {
        toast.error(e instanceof Error ? e.message : 'That did not work')
        return false
      } finally {
        setBusy(false)
      }
    },
    [load],
  )

  if (!tiers) {
    return (
      <p className="flex items-center gap-2 p-4 text-sm text-muted-foreground">
        <Loader2 className="size-4 animate-spin" aria-hidden /> Loading the catalog…
      </p>
    )
  }

  return (
    <div className="space-y-4">
      {canEdit && (
        <div className="flex justify-end">
          <Button size="sm" variant="outline" onClick={() => setNewTier((v) => !v)} disabled={busy}>
            <Plus className="size-4" /> New tier
          </Button>
        </div>
      )}

      {newTier && canEdit && (
        <NewTierForm
          busy={busy}
          onCancel={() => setNewTier(false)}
          onSubmit={async (body) => {
            const okDone = await run(
              () => api('/menu/master/tiers', { method: 'POST', body: JSON.stringify(body) }),
              `${body.name} added`,
            )
            if (okDone) setNewTier(false)
          }}
        />
      )}

      <div className="space-y-3">
        {tiers.map((t) => {
          const current = t.prices.find((p) => p.current)
          const scheduled = t.prices.filter((p) => p.effectiveFrom > today())
          const isOpen = open.has(t.id)
          return (
            <section key={t.id} className="rounded-lg border bg-card">
              <header className="flex flex-wrap items-center gap-x-3 gap-y-2 p-4">
                <button
                  type="button"
                  onClick={() =>
                    setOpen((prev) => {
                      const next = new Set(prev)
                      if (next.has(t.id)) next.delete(t.id)
                      else next.add(t.id)
                      return next
                    })
                  }
                  aria-expanded={isOpen}
                  className="flex min-w-0 flex-1 items-center gap-2 text-left focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
                >
                  {isOpen ? <ChevronDown className="size-4 shrink-0" aria-hidden /> : <ChevronRight className="size-4 shrink-0" aria-hidden />}
                  <span className="truncate font-[family-name:var(--font-serif)] text-lg font-semibold">{t.name}</span>
                  <span className="text-sm text-muted-foreground">
                    {t.categories.length} segment{t.categories.length === 1 ? '' : 's'}
                  </span>
                </button>

                <div className="flex items-center gap-2">
                  {current ? (
                    <span className="tabular-nums text-sm font-medium">
                      {formatPaise(current.baseRatePaise)} <span className="text-muted-foreground">/ plate</span>
                    </span>
                  ) : (
                    <Badge variant="outline" className="text-destructive">no rate — cannot be booked</Badge>
                  )}
                  {scheduled.length > 0 && (
                    <Badge variant="outline" className="text-amber-600">
                      {formatPaise(scheduled[scheduled.length - 1]!.baseRatePaise)} from {scheduled[scheduled.length - 1]!.effectiveFrom}
                    </Badge>
                  )}
                  {t.savedMenus > 0 && (
                    <span className="text-xs text-muted-foreground">{t.savedMenus} saved menu{t.savedMenus === 1 ? '' : 's'}</span>
                  )}
                </div>
              </header>

              {isOpen && (
                <div className="space-y-5 border-t p-4">
                  <PricePanel tier={t} canEdit={canEdit} busy={busy} run={run} />
                  <SegmentPanel tier={t} canEdit={canEdit} canDelete={canDelete} busy={busy} run={run} />
                </div>
              )}
            </section>
          )
        })}
      </div>
    </div>
  )
}

// ── Prices ───────────────────────────────────────────────────────────────────

function PricePanel({
  tier, canEdit, busy, run,
}: {
  tier: Tier; canEdit: boolean; busy: boolean
  run: (fn: () => Promise<unknown>, done: string) => Promise<boolean>
}) {
  const current = tier.prices.find((p) => p.current)
  const [editing, setEditing] = useState(false)
  const [from, setFrom] = useState(today())
  const [rate, setRate] = useState('')
  const [surcharge, setSurcharge] = useState('')
  const [impact, setImpact] = useState<{ savedMenus: number; upcomingUnbilled: number } | null>(null)

  /** Opens the editor pre-filled with the rate in force, so a surcharge-only change doesn't
   *  mean retyping the rate. Seeded here rather than in an effect: the values are already
   *  in props, so there is nothing to wait for. */
  function openEditor() {
    setRate(current ? String(current.baseRatePaise / 100) : '')
    setSurcharge(current ? String(current.weddingSurchargePaise / 100) : '50')
    setFrom(today())
    setEditing(true)
  }

  // Ask what the change would touch before it is made, not after.
  useEffect(() => {
    if (!editing || !from) return
    let live = true
    api<{ savedMenus: number; upcomingUnbilled: number }>(`/menu/master/tiers/${tier.id}/price?effective_from=${from}`)
      .then((r) => { if (live) setImpact(r) })
      .catch(() => { if (live) setImpact(null) })
    return () => { live = false }
  }, [editing, from, tier.id])

  return (
    <div>
      <div className="mb-2 flex items-center justify-between gap-2">
        <h3 className="text-sm font-semibold">Per-plate rate</h3>
        {canEdit && !editing && (
          <Button size="xs" variant="ghost" onClick={openEditor} disabled={busy}>
            <Pencil className="size-3" /> change rate
          </Button>
        )}
      </div>

      {editing && canEdit && (
        <div className="mb-3 space-y-3 rounded-md border border-primary/40 bg-muted/40 p-3">
          <div className="grid gap-3 sm:grid-cols-3">
            <label className="text-sm">
              <span className="text-xs text-muted-foreground">Effective from</span>
              <Input type="date" min={today()} value={from} onChange={(e) => setFrom(e.target.value)} />
            </label>
            <label className="text-sm">
              <span className="text-xs text-muted-foreground">Rate per plate (₹)</span>
              <Input inputMode="decimal" value={rate} onChange={(e) => setRate(e.target.value)} placeholder="650" />
            </label>
            <label className="text-sm">
              <span className="text-xs text-muted-foreground">Wedding surcharge (₹)</span>
              <Input inputMode="decimal" value={surcharge} onChange={(e) => setSurcharge(e.target.value)} placeholder="50" />
            </label>
          </div>

          {/* The reassurance that matters: a re-price is not a re-bill. */}
          <p className="text-xs text-muted-foreground">
            {impact ? (
              <>
                <strong className="text-foreground">{impact.savedMenus} saved menu{impact.savedMenus === 1 ? '' : 's'}</strong> on this
                tier keep the rate they were saved with — a menu snapshots its price and never
                re-reads it.{' '}
                {impact.upcomingUnbilled > 0 && (
                  <>
                    {impact.upcomingUnbilled} unbilled function{impact.upcomingUnbilled === 1 ? ' falls' : 's fall'} on or after{' '}
                    {from}; {impact.upcomingUnbilled === 1 ? 'it takes' : 'they take'} the new rate only if its menu is saved again.
                  </>
                )}
              </>
            ) : (
              'Dated changes only — earlier bills are never re-priced.'
            )}
          </p>

          <div className="flex gap-2">
            <Button
              size="sm"
              disabled={busy || !rate.trim() || !from}
              onClick={async () => {
                const r = Number(rate)
                const s = Number(surcharge || 0)
                if (!Number.isFinite(r) || r <= 0) return toast.error('Enter a rate above zero')
                if (!Number.isFinite(s) || s < 0) return toast.error('The surcharge cannot be negative')
                const done = await run(
                  () =>
                    api(`/menu/master/tiers/${tier.id}/price`, {
                      method: 'PUT',
                      body: JSON.stringify({
                        effective_from: from,
                        base_rate_paise: rupeesToPaise(r),
                        wedding_surcharge_paise: rupeesToPaise(s),
                      }),
                    }),
                  `${tier.name} priced from ${from}`,
                )
                if (done) setEditing(false)
              }}
            >
              Save rate
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setEditing(false)} disabled={busy}>Cancel</Button>
          </div>
        </div>
      )}

      {tier.prices.length === 0 ? (
        <p className="text-sm text-muted-foreground">No rate on record — this tier cannot be booked until it has one.</p>
      ) : (
        <ul className="space-y-1 text-sm">
          {tier.prices.map((p) => (
            <li key={p.effectiveFrom} className="flex flex-wrap items-baseline gap-x-3">
              <span className="w-24 shrink-0 tabular-nums text-muted-foreground">{p.effectiveFrom}</span>
              <span className="tabular-nums font-medium">{formatPaise(p.baseRatePaise)}</span>
              <span className="text-xs text-muted-foreground">+ {formatPaise(p.weddingSurchargePaise)} wedding</span>
              {p.current && <Badge variant="outline" className="text-emerald-600">in force</Badge>}
              {p.effectiveFrom > today() && <Badge variant="outline" className="text-amber-600">scheduled</Badge>}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

// ── Segments and dishes ──────────────────────────────────────────────────────

function SegmentPanel({
  tier, canEdit, canDelete, busy, run,
}: {
  tier: Tier; canEdit: boolean; canDelete: boolean; busy: boolean
  run: (fn: () => Promise<unknown>, done: string) => Promise<boolean>
}) {
  const [adding, setAdding] = useState(false)
  const [name, setName] = useState('')
  const [pick, setPick] = useState('')

  return (
    <div>
      <div className="mb-2 flex items-center justify-between gap-2">
        <h3 className="text-sm font-semibold">Segments</h3>
        {canEdit && (
          <Button size="xs" variant="ghost" onClick={() => setAdding((v) => !v)} disabled={busy}>
            <Plus className="size-3" /> add segment
          </Button>
        )}
      </div>

      {adding && canEdit && (
        <div className="mb-3 flex flex-wrap items-end gap-2 rounded-md border bg-muted/40 p-3">
          <label className="text-sm">
            <span className="text-xs text-muted-foreground">Segment</span>
            <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Soup" />
          </label>
          <label className="text-sm">
            <span className="text-xs text-muted-foreground">Pick count (blank = all included)</span>
            <Input inputMode="numeric" value={pick} onChange={(e) => setPick(e.target.value)} placeholder="2" className="w-48" />
          </label>
          <Button
            size="sm"
            disabled={busy || !name.trim()}
            onClick={async () => {
              const done = await run(
                () =>
                  api('/menu/master/categories', {
                    method: 'POST',
                    body: JSON.stringify({
                      tier_id: tier.id,
                      name: name.trim(),
                      pick_count: pick.trim() ? Number(pick) : null,
                      sort_order: tier.categories.length,
                    }),
                  }),
                `${name.trim()} added`,
              )
              if (done) { setAdding(false); setName(''); setPick('') }
            }}
          >
            Add
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setAdding(false)} disabled={busy}>Cancel</Button>
        </div>
      )}

      {tier.categories.length === 0 ? (
        <p className="text-sm text-muted-foreground">No segments yet.</p>
      ) : (
        <div className="space-y-2">
          {tier.categories.map((c) => (
            <SegmentRow key={c.id} cat={c} canEdit={canEdit} canDelete={canDelete} busy={busy} run={run} />
          ))}
        </div>
      )}
    </div>
  )
}

function SegmentRow({
  cat, canEdit, canDelete, busy, run,
}: {
  cat: Category; canEdit: boolean; canDelete: boolean; busy: boolean
  run: (fn: () => Promise<unknown>, done: string) => Promise<boolean>
}) {
  const [editing, setEditing] = useState(false)
  const [name, setName] = useState(cat.name)
  const [pick, setPick] = useState(cat.pickCount == null ? '' : String(cat.pickCount))
  const [free, setFree] = useState(cat.freeIncreaseEligible)
  const [newDish, setNewDish] = useState('')

  const allIncluded = cat.pickCount == null

  return (
    <div className="rounded-md border p-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-medium">{cat.name}</span>
        <Badge variant="outline" className={allIncluded ? 'text-muted-foreground' : undefined}>
          {allIncluded ? 'all included' : `pick ${cat.pickCount}`}
        </Badge>
        {cat.freeIncreaseEligible && <Badge variant="outline" className="text-amber-600">free-increase eligible</Badge>}
        <span className="text-xs text-muted-foreground">
          {cat.items.filter((i) => i.isActive).length} dish{cat.items.filter((i) => i.isActive).length === 1 ? '' : 'es'}
        </span>

        <span className="ml-auto flex gap-1">
          {canEdit && (
            <Button size="xs" variant="ghost" onClick={() => setEditing((v) => !v)} disabled={busy}>
              <Pencil className="size-3" /> edit
            </Button>
          )}
          {canDelete && (
            <Button
              size="xs"
              variant="ghost"
              className="text-destructive"
              disabled={busy}
              onClick={async () => {
                // No dialog: a browser confirm() blocks the whole tab, and the destructive
                // styling plus the dish count above is the warning.
                await run(
                  () => api(`/menu/master/categories/${cat.id}`, { method: 'DELETE' }),
                  `${cat.name} removed`,
                )
              }}
            >
              <Trash2 className="size-3" /> delete
            </Button>
          )}
        </span>
      </div>

      {editing && canEdit && (
        <div className="mt-3 flex flex-wrap items-end gap-2 rounded-md bg-muted/40 p-2">
          <label className="text-sm">
            <span className="text-xs text-muted-foreground">Name</span>
            <Input value={name} onChange={(e) => setName(e.target.value)} />
          </label>
          <label className="text-sm">
            <span className="text-xs text-muted-foreground">Pick count (blank = all)</span>
            <Input inputMode="numeric" value={pick} onChange={(e) => setPick(e.target.value)} className="w-36" />
          </label>
          <label className="flex items-center gap-2 pb-2 text-sm">
            <Checkbox checked={free} disabled={!pick.trim()} onCheckedChange={(v) => setFree(Boolean(v))} />
            <span className={cn(!pick.trim() && 'text-muted-foreground')}>free-increase eligible</span>
          </label>
          <Button
            size="sm"
            disabled={busy || !name.trim()}
            onClick={async () => {
              const done = await run(
                () =>
                  api(`/menu/master/categories/${cat.id}`, {
                    method: 'PUT',
                    body: JSON.stringify({
                      name: name.trim(),
                      pick_count: pick.trim() ? Number(pick) : null,
                      // An all-included segment has nothing to increase; the DB refuses the
                      // combination, so don't let the form send it.
                      free_increase_eligible: pick.trim() ? free : false,
                      sort_order: cat.sortOrder,
                    }),
                  }),
                `${name.trim()} updated`,
              )
              if (done) setEditing(false)
            }}
          >
            Save
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setEditing(false)} disabled={busy}>Cancel</Button>
        </div>
      )}

      <ul className="mt-2 grid gap-1 sm:grid-cols-2">
        {cat.items.map((i) => (
          <li key={i.id} className="flex items-center gap-2 text-sm">
            <span className={cn('min-w-0 flex-1 truncate', !i.isActive && 'text-muted-foreground line-through')}>
              {i.name}
            </span>
            {canEdit && (
              <Button
                size="xs"
                variant="ghost"
                disabled={busy}
                title={i.isActive ? 'Retire from the picker' : 'Bring back'}
                onClick={() =>
                  run(
                    () => api(`/menu/master/items/${i.id}`, { method: 'PUT', body: JSON.stringify({ is_active: !i.isActive }) }),
                    i.isActive ? `${i.name} retired` : `${i.name} restored`,
                  )
                }
              >
                {i.isActive ? <Trash2 className="size-3" /> : <RotateCcw className="size-3" />}
              </Button>
            )}
          </li>
        ))}
      </ul>

      {canEdit && (
        <div className="mt-2 flex gap-2">
          <Input
            value={newDish}
            onChange={(e) => setNewDish(e.target.value)}
            placeholder="Add a dish…"
            className="h-9"
            onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur() }}
          />
          <Button
            size="sm"
            variant="outline"
            disabled={busy || !newDish.trim()}
            onClick={async () => {
              const done = await run(
                () => api('/menu/master/items', { method: 'POST', body: JSON.stringify({ category_id: cat.id, name: newDish.trim() }) }),
                `${newDish.trim()} added`,
              )
              if (done) setNewDish('')
            }}
          >
            <Plus className="size-3" /> add
          </Button>
        </div>
      )}
    </div>
  )
}

// ── New tier ─────────────────────────────────────────────────────────────────

function NewTierForm({
  busy, onCancel, onSubmit,
}: {
  busy: boolean
  onCancel: () => void
  onSubmit: (body: { name: string; effective_from: string; base_rate_paise: number; wedding_surcharge_paise: number }) => Promise<void>
}) {
  const [name, setName] = useState('')
  const [rate, setRate] = useState('')
  const [surcharge, setSurcharge] = useState('50')
  const [from, setFrom] = useState(today())

  return (
    <div className="grid gap-3 rounded-lg border border-primary/40 bg-card p-4 sm:grid-cols-4">
      <label className="text-sm">
        <span className="text-xs text-muted-foreground">Tier name</span>
        <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Platinum" />
      </label>
      <label className="text-sm">
        <span className="text-xs text-muted-foreground">Rate per plate (₹)</span>
        <Input inputMode="decimal" value={rate} onChange={(e) => setRate(e.target.value)} placeholder="1250" />
      </label>
      <label className="text-sm">
        <span className="text-xs text-muted-foreground">Wedding surcharge (₹)</span>
        <Input inputMode="decimal" value={surcharge} onChange={(e) => setSurcharge(e.target.value)} />
      </label>
      <label className="text-sm">
        <span className="text-xs text-muted-foreground">Effective from</span>
        <Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
      </label>
      <div className="flex gap-2 sm:col-span-4">
        <Button
          size="sm"
          disabled={busy || !name.trim() || !rate.trim()}
          onClick={() => {
            const r = Number(rate)
            const s = Number(surcharge || 0)
            if (!Number.isFinite(r) || r <= 0) return toast.error('Enter a rate above zero')
            void onSubmit({
              name: name.trim(),
              effective_from: from,
              base_rate_paise: rupeesToPaise(r),
              wedding_surcharge_paise: rupeesToPaise(s),
            })
          }}
        >
          Create tier
        </Button>
        <Button size="sm" variant="ghost" onClick={onCancel} disabled={busy}>Cancel</Button>
      </div>
      <p className="text-xs text-muted-foreground sm:col-span-4">
        A tier needs a rate before it can be booked.
      </p>
    </div>
  )
}
