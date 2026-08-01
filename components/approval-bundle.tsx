'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { AlertTriangle, ArrowLeft, Check, Loader2, Plus, Trash2, X } from 'lucide-react'
import { toast } from 'sonner'
import { api } from '@/lib/http'
import { formatPaise } from '@/lib/money'
import { titleCase } from '@/lib/text'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Badge } from '@/components/ui/badge'
import { Card, CardContent } from '@/components/ui/card'
import { Checkbox } from '@/components/ui/checkbox'
import { Separator } from '@/components/ui/separator'
import { SECTION_LABEL, SECTION_STYLES } from '@/components/approvals-queue'

/**
 * One proposal, decided whole (client's lead, 1 Aug 2026).
 *
 * Top half: every pending ask on this booking, grouped by section, each defaulting to APPROVED
 * — "if he wants to approve them then he can keep them ticked". Bottom half: the proposal
 * itself, live and editable, with the asked-for items marked in purple where they actually sit,
 * so the GM decides a menu by looking at the menu.
 *
 * Purple is never the only signal. Every requested row also carries the word "Requested" and,
 * in the dish list, sits beside its own checkbox — a GM who cannot separate violet from grey
 * still reads what is being asked (WCAG 1.4.1, "colour is not the only means").
 */

type Ask = {
  id: string
  source: 'exception' | 'change_request'
  kind: string
  section: string
  status: string
  summary: string
  raisedByName: string
  raisedAt: string
  payload: Record<string, unknown>
}

type Dish = { name: string; note: string | null; isExtra: boolean }
type Segment = { name: string; basePick: number | null; extraPicks: number; picked: number; dishes: Dish[] }
type Menu = { tierId: string; tierName: string; perPlatePaise: number; segments: Segment[] }
type Fn = {
  id: string; venueId: string | null; bundleId: string | null; name: string; date: string
  startTime: string; endTime: string; pax: number; venueName: string | null
  venueRatePaise: number | null; menu: Menu | null; foodAmountPaise: number; subtotalPaise: number
}
type RoomLine = { id: string; unitId: string | null; roomType: string; count: number; checkIn: string; checkOut: string; nights: number; ratePaise: number; amountPaise: number }
type Lodge = { name: string; lines: RoomLine[]; rooms: number; subtotalPaise: number }
type DiscountRow = { id: string; head: string; percentBp: number | null; amountPaise: number; remark: string; status: string }

type Detail = {
  event: {
    eventId: string; eventCode: string; guestName: string; eventType: string; status: string
    firstDate: string | null; proposalTotalPaise: number; pendingCount: number
  }
  asks: Ask[]
  proposal: {
    event: { code: string; guestName: string; plannedFrom: string | null; plannedTo: string | null; status: string }
    functions: Fn[]
    lodges: Lodge[]
    discounts: DiscountRow[]
    totals: { proposalPaise: number; roomsPaise: number; roomsTaxPaise: number; discountPaise: number; totalPaise: number }
  }
  isLocked: boolean
  willReissueInvoice: boolean
}

type Options = {
  venues: { id: string; name: string; propertyName: string; priceable: boolean }[]
  bundles: { id: string; name: string; members: string }[]
  roomTypes: string[]
  lodgingUnits: { id: string; name: string }[]
}
type Catalog = { pools: { categoryName: string; items: string[] }[] }

/** Every dish this bundle's pending menu-increase asks are about, keyed `subEventId|category`. */
function requestedDishes(asks: Ask[]): Map<string, Set<string>> {
  const map = new Map<string, Set<string>>()
  for (const a of asks) {
    if (a.kind !== 'menu_increase' || a.status !== 'pending') continue
    const subEventId = a.payload.subEventId as string | undefined
    const items = (a.payload.items ?? []) as { categoryName: string; dishes: string[] }[]
    if (!subEventId) continue
    for (const i of items) {
      const key = `${subEventId}|${i.categoryName}`
      const set = map.get(key) ?? new Set<string>()
      for (const d of i.dishes ?? []) set.add(d)
      map.set(key, set)
    }
  }
  return map
}

const PURPLE_ROW = 'border-l-2 border-violet-500 bg-violet-50 dark:bg-violet-950/40'

export function ApprovalBundle({ eventId }: { eventId: string }) {
  const router = useRouter()
  const [detail, setDetail] = useState<Detail | null>(null)
  const [options, setOptions] = useState<Options | null>(null)
  const [catalog, setCatalog] = useState<Catalog | null>(null)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [confirming, setConfirming] = useState(false)

  // ── Draft state. Empty means "unchanged" — only what the GM touches is sent. ────────
  const [verdicts, setVerdicts] = useState<Record<string, 'approve' | 'reject'>>({})
  const [remarks, setRemarks] = useState<Record<string, string>>({})
  const [fnEdits, setFnEdits] = useState<Record<string, Partial<Fn>>>({})
  const [menuEdits, setMenuEdits] = useState<Record<string, string[]>>({})
  const [roomDraft, setRoomDraft] = useState<RoomLine[] | null>(null)
  const [removedDiscounts, setRemovedDiscounts] = useState<string[]>([])
  const [newDiscount, setNewDiscount] = useState({ head: 'overall', rupees: '', remark: '' })
  const [reason, setReason] = useState('')

  const load = useCallback(async () => {
    const [d, o, c] = await Promise.all([
      api<Detail>(`/approvals/bundles/${eventId}?settled=1`),
      api<Options>('/booking-options'),
      api<Catalog>('/menu/catalog'),
    ])
    setDetail(d)
    setOptions(o)
    setCatalog(c)
    // Every pending ask starts approved — the GM's default answer is yes, and a decline is the
    // deliberate act. He untick it, or edits the proposal underneath, to say otherwise.
    setVerdicts(Object.fromEntries(d.asks.filter((a) => a.status === 'pending').map((a) => [a.id, 'approve' as const])))
  }, [eventId])

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setLoading(true)
    load()
      .catch((e) => toast.error(e instanceof Error ? e.message : 'Failed to load'))
      .finally(() => setLoading(false))
  }, [load])

  const asked = useMemo(() => requestedDishes(detail?.asks ?? []), [detail])
  const pending = detail?.asks.filter((a) => a.status === 'pending') ?? []
  const settled = detail?.asks.filter((a) => a.status !== 'pending') ?? []

  /** The dish list currently shown for a segment: the GM's draft if he touched it, else saved. */
  const dishesFor = useCallback(
    (fnId: string, seg: Segment) => menuEdits[`${fnId}|${seg.name}`] ?? seg.dishes.map((d) => d.name),
    [menuEdits],
  )

  function toggleDish(fnId: string, seg: Segment, dish: string) {
    const key = `${fnId}|${seg.name}`
    const cur = menuEdits[key] ?? seg.dishes.map((d) => d.name)
    setMenuEdits({ ...menuEdits, [key]: cur.includes(dish) ? cur.filter((d) => d !== dish) : [...cur, dish] })
  }

  const rooms = roomDraft ?? detail?.proposal.lodges.flatMap((l) => l.lines) ?? []

  const dirty =
    Object.keys(fnEdits).length > 0 ||
    Object.keys(menuEdits).length > 0 ||
    roomDraft !== null ||
    removedDiscounts.length > 0 ||
    Boolean(newDiscount.rupees.trim())

  async function save() {
    if (!detail) return
    if (detail.isLocked && !reason.trim()) {
      toast.error('This booking is locked — give a reason for the change.')
      return
    }
    if (newDiscount.rupees.trim() && !newDiscount.remark.trim()) {
      toast.error('A discount needs a remark.')
      return
    }
    for (const a of pending) {
      if (verdicts[a.id] === 'reject' && !(remarks[a.id] ?? '').trim()) {
        toast.error('A declined request needs a reason.')
        return
      }
    }

    const edits: Record<string, unknown> = {}
    const functions = Object.entries(fnEdits).map(([id, e]) => ({ id, ...e }))
    if (functions.length) edits.functions = functions
    const menus = Object.entries(menuEdits).map(([key, dishes]) => {
      const [subEventId, categoryName] = key.split('|')
      return { subEventId, categoryName, dishes }
    })
    if (menus.length) edits.menus = menus
    if (roomDraft) {
      edits.rooms = roomDraft.map((r) => ({
        unitId: r.unitId, roomType: r.roomType, count: r.count, checkIn: r.checkIn, checkOut: r.checkOut,
      }))
    }
    if (removedDiscounts.length) edits.removeDiscountIds = removedDiscounts
    if (newDiscount.rupees.trim()) {
      // Rupees in the field, paise on the wire — money is BIGINT paise everywhere but the UI.
      const paise = Math.round(Number(newDiscount.rupees) * 100)
      if (!Number.isFinite(paise) || paise <= 0) {
        toast.error('Enter a discount amount in rupees.')
        return
      }
      edits.addDiscounts = [{ head: newDiscount.head, amountPaise: paise, remark: newDiscount.remark.trim() }]
    }
    if (reason.trim()) edits.reason = reason.trim()

    setSaving(true)
    try {
      const res = await api<{ result: { settled: unknown[]; changes: string[]; invoiceReissued: boolean; invoiceNo: string | null; remaining: number } }>(
        `/approvals/bundles/${eventId}/decide`,
        {
          method: 'POST',
          body: JSON.stringify({
            decisions: pending.map((a) => ({
              id: a.id,
              source: a.source,
              action: verdicts[a.id] ?? 'approve',
              remark: (remarks[a.id] ?? '').trim() || undefined,
            })),
            edits: Object.keys(edits).length ? edits : undefined,
          }),
        },
      )
      const r = res.result
      toast.success(
        `${detail.event.eventCode}: ${r.settled.length} decided` +
          (r.changes.length ? `, ${r.changes.length} change(s) applied` : '') +
          (r.invoiceReissued ? ` — document re-issued as ${r.invoiceNo}` : ''),
      )
      if (r.remaining === 0) router.push('/approvals')
      else {
        setConfirming(false)
        setFnEdits({}); setMenuEdits({}); setRoomDraft(null); setRemovedDiscounts([])
        setNewDiscount({ head: 'overall', rupees: '', remark: '' }); setReason('')
        await load()
      }
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not save')
      setConfirming(false)
    } finally {
      setSaving(false)
    }
  }

  if (loading) {
    return (
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <Loader2 className="size-4 animate-spin" /> Loading proposal…
      </div>
    )
  }
  if (!detail || !options || !catalog) return <p className="text-sm text-muted-foreground">Not found.</p>

  const p = detail.proposal

  return (
    <div className="space-y-6 pb-32">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="space-y-1">
          <Link href="/approvals" className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
            <ArrowLeft className="size-3.5" aria-hidden /> All proposals
          </Link>
          <h1 className="text-2xl font-semibold">
            <span className="tabular-nums">{detail.event.eventCode}</span> · {titleCase(detail.event.guestName)}
          </h1>
          <div className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
            <Badge variant="outline">{titleCase(detail.event.eventType)}</Badge>
            <Badge variant="outline">{titleCase(detail.event.status)}</Badge>
            <Link href={`/bookings/${eventId}`} className="hover:underline">Open the booking →</Link>
          </div>
        </div>
        <div className="text-right">
          <div className="text-xs text-muted-foreground">Proposal total</div>
          <div className="text-xl font-semibold tabular-nums">{formatPaise(p.totals.totalPaise)}</div>
        </div>
      </div>

      {detail.isLocked && (
        <div className="flex gap-3 rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm dark:border-amber-800 dark:bg-amber-950/50">
          <AlertTriangle className="mt-0.5 size-4 shrink-0 text-amber-700 dark:text-amber-400" aria-hidden />
          <div>
            <p className="font-medium">This booking is {titleCase(detail.event.status)} — normally frozen.</p>
            <p className="text-muted-foreground">
              You can still change it, and the reason you give is recorded against every edit.
              {detail.willReissueInvoice && ' The guest already holds a document, so saving issues a new version of it.'}
            </p>
          </div>
        </div>
      )}

      {/* ── 1. The asks ─────────────────────────────────────────────────────── */}
      <section className="space-y-3">
        <h2 className="text-lg font-semibold">
          Awaiting you{pending.length > 0 && <span className="ml-2 text-sm font-normal text-muted-foreground">{pending.length} item(s)</span>}
        </h2>
        {pending.length === 0 ? (
          <p className="text-sm text-muted-foreground">Nothing pending on this booking. You can still edit the proposal below.</p>
        ) : (
          <ul className="space-y-2">
            {pending.map((a) => {
              const verdict = verdicts[a.id] ?? 'approve'
              return (
                <li key={a.id} className={cn('rounded-lg border p-3', PURPLE_ROW)}>
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div className="min-w-0 space-y-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className={cn('rounded-full px-2 py-0.5 text-xs', SECTION_STYLES[a.section])}>
                          {SECTION_LABEL[a.section] ?? a.section}
                        </span>
                        <span className="rounded-full bg-violet-600 px-2 py-0.5 text-xs font-medium text-white">Requested</span>
                      </div>
                      <p className="text-sm">{a.summary}</p>
                      <p className="text-xs text-muted-foreground">raised by {a.raisedByName}</p>
                    </div>
                    <div className="flex shrink-0 gap-1.5" role="group" aria-label={`Decision for ${a.summary}`}>
                      <Button
                        size="sm"
                        variant={verdict === 'approve' ? 'default' : 'outline'}
                        onClick={() => setVerdicts({ ...verdicts, [a.id]: 'approve' })}
                        aria-pressed={verdict === 'approve'}
                      >
                        <Check className="size-3.5" aria-hidden /> Approve
                      </Button>
                      <Button
                        size="sm"
                        variant={verdict === 'reject' ? 'destructive' : 'outline'}
                        onClick={() => setVerdicts({ ...verdicts, [a.id]: 'reject' })}
                        aria-pressed={verdict === 'reject'}
                      >
                        <X className="size-3.5" aria-hidden /> Decline
                      </Button>
                    </div>
                  </div>
                  {verdict === 'reject' && (
                    <div className="mt-2">
                      <Label htmlFor={`remark-${a.id}`} className="text-xs">Reason for declining (required)</Label>
                      <Input
                        id={`remark-${a.id}`}
                        value={remarks[a.id] ?? ''}
                        onChange={(e) => setRemarks({ ...remarks, [a.id]: e.target.value })}
                        className="mt-1 h-8"
                        placeholder="The guest was told 300 pax — hold the count"
                      />
                    </div>
                  )}
                </li>
              )
            })}
          </ul>
        )}

        {settled.length > 0 && (
          <details className="rounded-lg border p-3">
            <summary className="cursor-pointer text-sm text-muted-foreground">
              {settled.length} already decided on this booking
            </summary>
            <ul className="mt-2 space-y-1.5 text-sm">
              {settled.map((a) => (
                <li key={a.id} className="flex flex-wrap items-center gap-2 text-muted-foreground">
                  <span className={cn('rounded-full px-2 py-0.5 text-xs', SECTION_STYLES[a.section])}>
                    {SECTION_LABEL[a.section] ?? a.section}
                  </span>
                  <span>{a.summary}</span>
                  <Badge variant="outline" className="text-xs">{titleCase(a.status)}</Badge>
                </li>
              ))}
            </ul>
          </details>
        )}
      </section>

      <Separator />

      {/* ── 2. The proposal, editable ────────────────────────────────────────── */}
      <section className="space-y-4">
        <div>
          <h2 className="text-lg font-semibold">The proposal</h2>
          <p className="text-sm text-muted-foreground">
            Everything the Booking Manager filled in. Change anything here and it is written straight
            to the booking — purple marks what is being asked for.
          </p>
        </div>

        {p.functions.map((f) => {
          const edit = fnEdits[f.id] ?? {}
          const set = (patch: Partial<Fn>) => setFnEdits({ ...fnEdits, [f.id]: { ...edit, ...patch } })
          return (
            <Card key={f.id}>
              <CardContent className="space-y-4 py-4">
                <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                  <div>
                    <Label htmlFor={`name-${f.id}`} className="text-xs">Function</Label>
                    <Input id={`name-${f.id}`} className="mt-1 h-8" value={edit.name ?? f.name} onChange={(e) => set({ name: e.target.value })} />
                  </div>
                  <div>
                    <Label htmlFor={`date-${f.id}`} className="text-xs">Date</Label>
                    <Input id={`date-${f.id}`} type="date" className="mt-1 h-8" value={edit.date ?? f.date} onChange={(e) => set({ date: e.target.value })} />
                  </div>
                  <div className="flex gap-2">
                    <div className="flex-1">
                      <Label htmlFor={`start-${f.id}`} className="text-xs">From</Label>
                      <Input id={`start-${f.id}`} type="time" className="mt-1 h-8" value={(edit.startTime ?? f.startTime).slice(0, 5)} onChange={(e) => set({ startTime: e.target.value })} />
                    </div>
                    <div className="flex-1">
                      <Label htmlFor={`end-${f.id}`} className="text-xs">To</Label>
                      <Input id={`end-${f.id}`} type="time" className="mt-1 h-8" value={(edit.endTime ?? f.endTime).slice(0, 5)} onChange={(e) => set({ endTime: e.target.value })} />
                    </div>
                  </div>
                  <div>
                    <Label htmlFor={`pax-${f.id}`} className="text-xs">Pax</Label>
                    <Input id={`pax-${f.id}`} type="number" min={1} className="mt-1 h-8 tabular-nums" value={edit.pax ?? f.pax} onChange={(e) => set({ pax: Number(e.target.value) })} />
                  </div>
                </div>

                <div className="grid gap-3 sm:grid-cols-2">
                  <div>
                    <Label htmlFor={`venue-${f.id}`} className="text-xs">Venue</Label>
                    <select
                      id={`venue-${f.id}`}
                      className="mt-1 h-8 w-full rounded-md border bg-background px-2 text-sm"
                      value={edit.bundleId ?? edit.venueId ?? f.bundleId ?? f.venueId ?? ''}
                      onChange={(e) => {
                        const v = e.target.value
                        const isBundle = options.bundles.some((b) => b.id === v)
                        set(isBundle ? { bundleId: v, venueId: null } : { venueId: v, bundleId: null })
                      }}
                    >
                      <optgroup label="Venues">
                        {options.venues.filter((v) => v.priceable).map((v) => (
                          <option key={v.id} value={v.id}>{v.propertyName} — {v.name}</option>
                        ))}
                      </optgroup>
                      <optgroup label="Bundles">
                        {options.bundles.map((b) => (
                          <option key={b.id} value={b.id}>{b.name} ({b.members})</option>
                        ))}
                      </optgroup>
                    </select>
                  </div>
                  <div className="flex items-end justify-end gap-4 text-sm">
                    <span className="text-muted-foreground">Venue</span>
                    <span className="tabular-nums">{f.venueRatePaise == null ? 'on approval' : formatPaise(f.venueRatePaise)}</span>
                    <span className="text-muted-foreground">Food</span>
                    <span className="tabular-nums">{formatPaise(f.foodAmountPaise)}</span>
                  </div>
                </div>

                {f.menu && (
                  <div className="space-y-3 rounded-md border p-3">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <span className="text-sm font-medium">{f.menu.tierName}</span>
                      <span className="text-xs text-muted-foreground tabular-nums">
                        {formatPaise(f.menu.perPlatePaise)} / plate × {edit.pax ?? f.pax} pax
                      </span>
                    </div>
                    {f.menu.segments.map((seg) => {
                      const chosen = dishesFor(f.id, seg)
                      const askedHere = asked.get(`${f.id}|${seg.name}`) ?? new Set<string>()
                      const pool = catalog.pools.find((x) => x.categoryName === seg.name)?.items ?? []
                      // Every dish the guest has, plus everything else on offer for this heading.
                      const all = [...new Set([...seg.dishes.map((d) => d.name), ...pool])].sort()
                      const included = seg.basePick == null
                      return (
                        <div key={seg.name} className="space-y-1.5">
                          <div className="flex flex-wrap items-center gap-2">
                            <span className="text-sm font-medium">{seg.name}</span>
                            <span className="text-xs text-muted-foreground tabular-nums">
                              {included ? 'all included' : `${chosen.length} of ${seg.basePick} + ${Math.max(0, chosen.length - seg.basePick!)} extra`}
                            </span>
                            {askedHere.size > 0 && (
                              <span className="rounded-full bg-violet-600 px-2 py-0.5 text-xs font-medium text-white">
                                {askedHere.size} requested
                              </span>
                            )}
                          </div>
                          {included ? (
                            <p className="text-xs text-muted-foreground">
                              {seg.dishes.map((d) => d.name).join(', ') || '—'}
                            </p>
                          ) : (
                            <div className="grid gap-1 sm:grid-cols-2 lg:grid-cols-3">
                              {all.map((dish) => {
                                const isAsked = askedHere.has(dish)
                                const id = `dish-${f.id}-${seg.name}-${dish}`.replace(/\s+/g, '-')
                                return (
                                  <label
                                    key={dish}
                                    htmlFor={id}
                                    className={cn(
                                      'flex cursor-pointer items-center gap-2 rounded px-2 py-1 text-sm hover:bg-muted/60',
                                      isAsked && PURPLE_ROW,
                                    )}
                                  >
                                    <Checkbox
                                      id={id}
                                      checked={chosen.includes(dish)}
                                      onCheckedChange={() => toggleDish(f.id, seg, dish)}
                                    />
                                    <span className="min-w-0 truncate">{dish}</span>
                                    {isAsked && (
                                      <span className="ml-auto shrink-0 text-[10px] font-medium uppercase tracking-wide text-violet-700 dark:text-violet-300">
                                        Requested
                                      </span>
                                    )}
                                  </label>
                                )
                              })}
                            </div>
                          )}
                        </div>
                      )
                    })}
                  </div>
                )}
              </CardContent>
            </Card>
          )
        })}

        {/* Rooms */}
        <Card>
          <CardContent className="space-y-3 py-4">
            <div className="flex items-center justify-between">
              <h3 className="font-medium">Rooms</h3>
              <span className="text-sm tabular-nums text-muted-foreground">
                {formatPaise(p.totals.roomsPaise)} + {formatPaise(p.totals.roomsTaxPaise)} tax
              </span>
            </div>
            {rooms.length === 0 ? (
              <p className="text-sm text-muted-foreground">No rooms on this booking.</p>
            ) : (
              <div className="space-y-2">
                {rooms.map((r, i) => (
                  <div key={r.id || i} className="grid items-end gap-2 sm:grid-cols-[1fr_1fr_5rem_1fr_1fr_auto]">
                    <div>
                      <Label className="text-xs" htmlFor={`unit-${i}`}>Lodge</Label>
                      <select
                        id={`unit-${i}`}
                        className="mt-1 h-8 w-full rounded-md border bg-background px-2 text-sm"
                        value={r.unitId ?? ''}
                        onChange={(e) => {
                          const next = [...rooms]; next[i] = { ...r, unitId: e.target.value }; setRoomDraft(next)
                        }}
                      >
                        {options.lodgingUnits.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
                      </select>
                    </div>
                    <div>
                      <Label className="text-xs" htmlFor={`type-${i}`}>Category</Label>
                      <select
                        id={`type-${i}`}
                        className="mt-1 h-8 w-full rounded-md border bg-background px-2 text-sm"
                        value={r.roomType}
                        onChange={(e) => { const next = [...rooms]; next[i] = { ...r, roomType: e.target.value }; setRoomDraft(next) }}
                      >
                        {options.roomTypes.map((t) => <option key={t} value={t}>{t.replace(/_/g, ' ')}</option>)}
                      </select>
                    </div>
                    <div>
                      <Label className="text-xs" htmlFor={`count-${i}`}>Rooms</Label>
                      <Input
                        id={`count-${i}`} type="number" min={1} className="mt-1 h-8 tabular-nums" value={r.count}
                        onChange={(e) => { const next = [...rooms]; next[i] = { ...r, count: Number(e.target.value) }; setRoomDraft(next) }}
                      />
                    </div>
                    <div>
                      <Label className="text-xs" htmlFor={`in-${i}`}>Check-in</Label>
                      <Input
                        id={`in-${i}`} type="date" className="mt-1 h-8" value={r.checkIn}
                        onChange={(e) => { const next = [...rooms]; next[i] = { ...r, checkIn: e.target.value }; setRoomDraft(next) }}
                      />
                    </div>
                    <div>
                      <Label className="text-xs" htmlFor={`out-${i}`}>Check-out</Label>
                      <Input
                        id={`out-${i}`} type="date" className="mt-1 h-8" value={r.checkOut}
                        onChange={(e) => { const next = [...rooms]; next[i] = { ...r, checkOut: e.target.value }; setRoomDraft(next) }}
                      />
                    </div>
                    <Button
                      variant="ghost" size="sm" className="h-8"
                      aria-label={`Remove ${r.count} × ${r.roomType}`}
                      onClick={() => setRoomDraft(rooms.filter((_, j) => j !== i))}
                    >
                      <Trash2 className="size-3.5" aria-hidden />
                    </Button>
                  </div>
                ))}
              </div>
            )}
            <Button
              variant="outline" size="sm"
              onClick={() =>
                setRoomDraft([
                  ...rooms,
                  {
                    id: '', unitId: options.lodgingUnits[0]?.id ?? null, roomType: options.roomTypes[0] ?? 'deluxe',
                    count: 1, checkIn: p.event.plannedFrom ?? p.functions[0]?.date ?? '',
                    checkOut: p.event.plannedTo ?? p.functions[0]?.date ?? '', nights: 1, ratePaise: 0, amountPaise: 0,
                  },
                ])
              }
            >
              <Plus className="size-3.5" aria-hidden /> Add a room line
            </Button>
          </CardContent>
        </Card>

        {/* Discounts */}
        <Card>
          <CardContent className="space-y-3 py-4">
            <div className="flex items-center justify-between">
              <h3 className="font-medium">Discounts</h3>
              <span className="text-sm tabular-nums text-muted-foreground">−{formatPaise(p.totals.discountPaise)}</span>
            </div>
            {p.discounts.length === 0 ? (
              <p className="text-sm text-muted-foreground">None given.</p>
            ) : (
              <ul className="space-y-1.5">
                {p.discounts.map((d) => {
                  const gone = removedDiscounts.includes(d.id)
                  return (
                    <li key={d.id} className={cn('flex flex-wrap items-center gap-2 text-sm', gone && 'opacity-50 line-through')}>
                      <Badge variant="outline" className="text-xs">{titleCase(d.head)}</Badge>
                      <span className="tabular-nums">{d.percentBp != null ? `${d.percentBp / 100}%` : ''} {formatPaise(d.amountPaise)}</span>
                      <span className="text-muted-foreground">{d.remark}</span>
                      {d.status === 'pending' && (
                        <span className="rounded-full bg-violet-600 px-2 py-0.5 text-xs font-medium text-white">Requested</span>
                      )}
                      <Button
                        variant="ghost" size="sm" className="ml-auto h-7"
                        aria-label={gone ? `Restore ${d.head} discount` : `Remove ${d.head} discount`}
                        onClick={() => setRemovedDiscounts(gone ? removedDiscounts.filter((x) => x !== d.id) : [...removedDiscounts, d.id])}
                      >
                        {gone ? 'Undo' : <Trash2 className="size-3.5" aria-hidden />}
                      </Button>
                    </li>
                  )
                })}
              </ul>
            )}
            <Separator />
            <div className="grid items-end gap-2 sm:grid-cols-[8rem_8rem_1fr]">
              <div>
                <Label htmlFor="disc-head" className="text-xs">Apply to</Label>
                <select
                  id="disc-head" className="mt-1 h-8 w-full rounded-md border bg-background px-2 text-sm"
                  value={newDiscount.head} onChange={(e) => setNewDiscount({ ...newDiscount, head: e.target.value })}
                >
                  <option value="overall">Whole bill</option>
                  <option value="menu">Menu</option>
                  <option value="venue">Venue</option>
                  <option value="room">Rooms</option>
                </select>
              </div>
              <div>
                <Label htmlFor="disc-amt" className="text-xs">Amount ₹</Label>
                <Input
                  id="disc-amt" inputMode="decimal" className="mt-1 h-8 tabular-nums" placeholder="25000"
                  value={newDiscount.rupees} onChange={(e) => setNewDiscount({ ...newDiscount, rupees: e.target.value })}
                />
              </div>
              <div>
                <Label htmlFor="disc-remark" className="text-xs">Remark (required)</Label>
                <Input
                  id="disc-remark" className="mt-1 h-8" placeholder="Repeat client — agreed with the owner"
                  value={newDiscount.remark} onChange={(e) => setNewDiscount({ ...newDiscount, remark: e.target.value })}
                />
              </div>
            </div>
            <p className="text-xs text-muted-foreground">
              A rupee discount you give here is not held to the 10% cap and takes effect at once — it is
              your approval. It flows through the bill, the balance and the advance everywhere.
            </p>
          </CardContent>
        </Card>
      </section>

      {/* ── 3. Save ──────────────────────────────────────────────────────────── */}
      <div className="fixed inset-x-0 bottom-0 z-40 border-t bg-background/95 p-3 backdrop-blur lg:pl-64">
        <div className="mx-auto flex max-w-5xl flex-wrap items-end justify-between gap-3">
          <div className="min-w-0 flex-1 space-y-1">
            {detail.isLocked && (
              <div>
                <Label htmlFor="reason" className="text-xs">
                  Reason for changing a {titleCase(detail.event.status).toLowerCase()} booking (required)
                </Label>
                <Input
                  id="reason" className="mt-1 h-8" value={reason} onChange={(e) => setReason(e.target.value)}
                  placeholder="Guest added 20 rooms after the bill was raised"
                />
              </div>
            )}
            <p className="text-xs text-muted-foreground">
              {pending.filter((a) => (verdicts[a.id] ?? 'approve') === 'approve').length} approving,{' '}
              {pending.filter((a) => verdicts[a.id] === 'reject').length} declining
              {dirty && ' · proposal edited'}
              {detail.willReissueInvoice && dirty && ' · the guest’s document will be re-issued'}
            </p>
          </div>
          {confirming ? (
            <div className="flex items-center gap-2">
              <span className="text-sm">Save these changes?</span>
              <Button size="sm" onClick={save} disabled={saving}>
                {saving && <Loader2 className="size-3.5 animate-spin" aria-hidden />} Yes, save
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setConfirming(false)} disabled={saving}>Cancel</Button>
            </div>
          ) : (
            <Button
              onClick={() => (detail.isLocked ? setConfirming(true) : save())}
              disabled={saving || (pending.length === 0 && !dirty)}
            >
              {saving && <Loader2 className="size-4 animate-spin" aria-hidden />}
              Save decision
            </Button>
          )}
        </div>
      </div>
    </div>
  )
}
