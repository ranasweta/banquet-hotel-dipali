'use client'

import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { AlertTriangle, ArrowLeft, ChevronDown, ChevronRight, Loader2, Plus, Trash2 } from 'lucide-react'
import { toast } from 'sonner'
import { api } from '@/lib/http'
import { formatPaise } from '@/lib/money'
import { titleCase } from '@/lib/text'
import { DiscountGrid, type GridDraft, type LineDraft } from '@/components/discount-grid'
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
 * One proposal, decided whole (client's lead, 1 Aug 2026; redesigned 8 Sep 2026).
 *
 * WHAT THE 8 SEP REDESIGN CHANGED, and why. The screen was right about the unit of decision and
 * wrong about everything under it:
 *
 *   • THE PROPOSAL WAS ONE UNBROKEN SCROLL. Every function printed its whole dish list, open,
 *     one after another, and the rooms and the price sheet came after all of them. A booking
 *     with four functions ran to several screens of checkboxes the GM had not asked to see.
 *     Each function, Rooms, and Prices is now a section he opens — closed by default, with the
 *     count of requests on it in the header, so the page opens as a page and not as a list.
 *
 *   • HE DECIDED AT THE TOP AND THE EVIDENCE WAS AT THE BOTTOM. Every ask carried an
 *     Approve/Decline pair in a list above a proposal he had to go and find for himself. The
 *     buttons are gone. Each request now carries one button that OPENS the section it is about
 *     and scrolls him to it — a menu increase to that function's menu, an over-cap price to the
 *     price sheet — and he answers by editing what he finds there (client, 8 Sep 2026: "if he
 *     keeps it he can simply save the changes, or if he doesn't then simply change the numbers
 *     by clicking the discounted, then click save & approve").
 *
 *   • A PRICE HE WAS ASKED TO APPROVE DID NOT APPEAR ON THE SCREEN. An over-cap discount is
 *     held pending, so every reader — the price sheet included — showed the line at its actual
 *     price with "Requested" beside the label and no figure anywhere. He was deciding a
 *     ₹1,41,000 hall from the sentence "discount of ₹10,000 over the cap". The asked-for price
 *     is now printed on the request, printed on the line, and PREFILLED into the box, so
 *     approving as asked is the do-nothing answer and typing over it is the deliberate one.
 *
 *   • THERE WERE TWO SAVE BUTTONS FOR ONE DECISION — the price grid saved on its own, the asks
 *     on another. The grid runs in controlled mode here and its column goes in with everything
 *     else under one "Save & approve", in one transaction.
 *
 * There is no Decline. Every pending ask is approved when he saves, because his edits ARE the
 * answer: a dish he unticks is a menu increase refused, and the actual price typed back into a
 * cell is a discount refused. The underlying services still take a rejection — nothing about
 * `settleException` changed — this screen simply no longer offers a verdict separate from the
 * booking, which is what made it possible to approve a request and leave the proposal saying
 * something else.
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
  /** Per-lodge inventory. `roomTypes` is a flat list across all lodges and must NOT drive the
   *  category picker — Residency has no dormitory, Palace no semi-deluxe. */
  roomRates: { unitId: string; roomType: string; rackRatePaise: number }[]
  lodgingUnits: { id: string; name: string }[]
}
type Catalog = { pools: { categoryName: string; items: string[] }[] }

/** One cell of an over-cap discount request: what the line lists at, and what is being asked. */
type AskedPrice = { key: string; label: string; actualPaise: number; discountedPaise: number }

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

/**
 * Which section of the proposal answers a request, and what the button on it says.
 *
 * This is the whole navigation model: the request index at the top of the page is an index, and
 * the decision is made where the thing being decided actually lives.
 */
function targetOf(a: Ask): { section: string; label: string } | null {
  const subEventId = a.payload.subEventId as string | undefined
  if (a.kind === 'menu_increase' && subEventId) return { section: `fn:${subEventId}`, label: 'Review in the menu' }
  if (a.source === 'change_request' && subEventId) return { section: `fn:${subEventId}`, label: 'Review the schedule' }
  if (a.kind === 'room_allocation_35plus') return { section: 'rooms', label: 'Review in rooms' }
  if (a.section === 'discount') return { section: 'pricing', label: 'Review in pricing' }
  return null
}

/** The cells of an over-cap discount request, when it carries any. */
function askedPrices(a: Ask): AskedPrice[] {
  if (a.kind !== 'discount_over_cap') return []
  return ((a.payload.lines ?? []) as AskedPrice[]).filter((l) => l && typeof l.discountedPaise === 'number')
}

/** ISO date + n days, without pulling in a date library for one sum. */
function addDays(iso: string, n: number): string {
  if (!iso) return ''
  const d = new Date(`${iso}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + n)
  return d.toISOString().slice(0, 10)
}

/**
 * One collapsible part of the proposal.
 *
 * Closed by default and open when the GM asks for it, from its own header or from the button on
 * a request above. `count` is how many requests are waiting inside — it is drawn as a violet
 * pill AND spoken in words, because it is the only thing on a closed header saying there is
 * something in there to decide.
 */
function Section({
  id,
  title,
  meta,
  count,
  open,
  flash,
  onToggle,
  children,
}: {
  id: string
  title: string
  meta?: string
  count: number
  open: boolean
  flash: boolean
  onToggle: () => void
  children: ReactNode
}) {
  return (
    <Card id={`section-${id}`} className={cn('scroll-mt-4', flash && 'ring-2 ring-violet-500')}>
      <CardContent className="p-0">
        <button
          type="button"
          onClick={onToggle}
          aria-expanded={open}
          aria-controls={`body-${id}`}
          className="flex w-full items-center gap-2 px-4 py-3 text-left hover:bg-muted/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          {open ? (
            <ChevronDown className="size-4 shrink-0 text-muted-foreground" aria-hidden />
          ) : (
            <ChevronRight className="size-4 shrink-0 text-muted-foreground" aria-hidden />
          )}
          <span className="min-w-0 flex-1">
            <span className="font-medium">{title}</span>
            {meta && <span className="ml-2 text-sm tabular-nums text-muted-foreground">{meta}</span>}
          </span>
          {count > 0 && (
            <span className="shrink-0 rounded-full bg-violet-600 px-2 py-0.5 text-xs font-medium text-white">
              {count} requested
            </span>
          )}
        </button>
        {open && (
          <div id={`body-${id}`} className="space-y-4 border-t px-4 py-4">
            {children}
          </div>
        )}
      </CardContent>
    </Card>
  )
}

export function ApprovalBundle({ eventId }: { eventId: string }) {
  const router = useRouter()
  const [detail, setDetail] = useState<Detail | null>(null)
  const [options, setOptions] = useState<Options | null>(null)
  const [catalog, setCatalog] = useState<Catalog | null>(null)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [confirming, setConfirming] = useState(false)

  // ── Draft state. Empty means "unchanged" — only what the GM touches is sent. ────────
  const [fnEdits, setFnEdits] = useState<Record<string, Partial<Fn>>>({})
  const [menuEdits, setMenuEdits] = useState<Record<string, string[]>>({})
  const [roomDraft, setRoomDraft] = useState<RoomLine[] | null>(null)
  /** The price sheet's Discounted column, reported up by the grid. `null` = a cell is not a price. */
  const [priceDraft, setPriceDraft] = useState<LineDraft[] | null>([])
  const [priceRemark, setPriceRemark] = useState('')
  /** What that column comes to, so the save bar can state it without a second copy of the sum. */
  const [priceTotals, setPriceTotals] = useState<{ givenPaise: number; basePaise: number }>({ givenPaise: 0, basePaise: 0 })
  const [reason, setReason] = useState('')
  /** Keyed by ROW INDEX: two lines can share a shape yet each takes real rooms. */
  const [free, setFree] = useState<Record<number, { available: number; total: number }>>({})

  // ── What is open, and what was just jumped to ──────────────────────────────────────
  const [open, setOpen] = useState<Record<string, boolean>>({})
  const [flash, setFlash] = useState<string | null>(null)
  /** The section a request's button asked for. `n` re-fires it when the same one is clicked twice. */
  const [jump, setJump] = useState<{ section: string; n: number } | null>(null)
  /** Bumped after a save so the price grid re-reads a sheet the save has moved. */
  const [gridKey, setGridKey] = useState(0)

  const load = useCallback(async () => {
    const [d, o, c] = await Promise.all([
      api<Detail>(`/approvals/bundles/${eventId}?settled=1`),
      api<Options>('/booking-options'),
      api<Catalog>('/menu/catalog'),
    ])
    setDetail(d)
    setOptions(o)
    setCatalog(c)
  }, [eventId])

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setLoading(true)
    load()
      .catch((e) => toast.error(e instanceof Error ? e.message : 'Failed to load'))
      .finally(() => setLoading(false))
  }, [load])

  const asked = useMemo(() => requestedDishes(detail?.asks ?? []), [detail])
  const pending = useMemo(() => detail?.asks.filter((a) => a.status === 'pending') ?? [], [detail])
  const settled = detail?.asks.filter((a) => a.status !== 'pending') ?? []

  /** How many pending requests sit inside each section, for the closed headers. */
  const countBySection = useMemo(() => {
    const m: Record<string, number> = {}
    for (const a of pending) {
      const t = targetOf(a)
      if (t) m[t.section] = (m[t.section] ?? 0) + 1
    }
    return m
  }, [pending])

  /** Opens a section and takes the GM to it. The ring fades; the section stays open. */
  const jumpTo = useCallback((section: string) => {
    setOpen((o) => ({ ...o, [section]: true }))
    setFlash(section)
    setJump((j) => ({ section, n: (j?.n ?? 0) + 1 }))
    setTimeout(() => setFlash((f) => (f === section ? null : f)), 2500)
  }, [])

  /**
   * The scroll, in an effect rather than in the click handler, so it runs AFTER the commit that
   * opened the section. Scrolling from the handler measures a card that is still collapsed: the
   * browser lands on its header, the body then renders underneath, and the GM arrives at the
   * top of a section whose content is below the fold — which is the one thing the button exists
   * to prevent.
   *
   * And then it follows the section down as it grows. One scroll is not enough either: a
   * section's content arrives after it opens — the price grid fetches its sheet, the room lines
   * their availability — and while it is still loading the page is too short to scroll that far,
   * so the browser stops at the bottom of a page that is about to get longer. Measured: 197px
   * of a 1,290px scroll, leaving the requested price 150px below the fold. The observer is
   * dropped after two seconds, so it can never fight a GM who has started scrolling himself.
   */
  useEffect(() => {
    if (!jump) return
    const el = document.getElementById(`section-${jump.section}`)
    if (!el) return
    /**
     * The section header, unless the thing he was sent to see would not fit under it. A
     * Sangeet's menu is several screens of checkboxes and the requested dish can sit anywhere
     * in it; landing on the card's name and leaving "Kimchi Salad · Requested" below the fold
     * is the errand half-run. Measured against the SECTION, not the viewport, so it is one
     * scroll and not a guess about where a smooth scroll has got to.
     */
    const scroll = () => {
      const marked = el.querySelector('[data-requested]')
      // 96px: the fixed Save bar, which is not screen a row can land in.
      const room = window.innerHeight - 96
      if (marked && marked.getBoundingClientRect().top - el.getBoundingClientRect().top > room) {
        marked.scrollIntoView({ behavior: 'smooth', block: 'center' })
      } else {
        el.scrollIntoView({ behavior: 'smooth', block: 'start' })
      }
    }
    scroll()
    const observer = new ResizeObserver(scroll)
    observer.observe(el)
    const timer = setTimeout(() => observer.disconnect(), 2000)
    return () => {
      clearTimeout(timer)
      observer.disconnect()
    }
  }, [jump])

  /** Stable for the grid's effect dependency — it reports its column up on every keystroke. */
  const onPriceDraft = useCallback((d: GridDraft) => {
    setPriceDraft(d.lines)
    setPriceRemark(d.remark)
    setPriceTotals({ givenPaise: d.givenPaise, basePaise: d.basePaise })
  }, [])

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

  /**
   * The categories a lodge actually holds. Offering every category at every lodge let the GM
   * approve "Residency dormitory", which does not exist anywhere in the building — the save
   * then failed on the inventory cap, reporting no rooms free for a room type the lodge has
   * never had. The picker now cannot express the impossible booking in the first place.
   */
  const typesFor = useCallback(
    (unitId: string | null) =>
      [...new Set((options?.roomRates ?? []).filter((r) => r.unitId === unitId).map((r) => r.roomType))].sort(),
    [options],
  )

  /**
   * What each room line can actually have, live from the lodging inventory.
   *
   * The save already refuses an over-booking — `getRoomAvailability` inside the same
   * transaction, reading the very rows the lodging calendar draws — but refusing at Save is a
   * poor way to tell a GM that Regency holds 27 deluxe. This mirrors the booking wizard so he
   * sees the ceiling while he types. It is feedback, never the control: the server still decides.
   */
  const completeRooms = rooms
    .map((r, i) => ({ r, i }))
    .filter(({ r }) => r.unitId && r.roomType && r.checkIn && r.checkOut && r.checkOut > r.checkIn)
  const roomSignature = completeRooms
    .map(({ r }) => `${r.unitId}|${r.roomType}|${r.checkIn}|${r.checkOut}|${r.count}`)
    .join(',')

  useEffect(() => {
    // Everything, including the reset, happens in the debounce callback: a setState in the
    // effect body itself cascades a render on every keystroke.
    const t = setTimeout(() => {
      if (!roomSignature) {
        setFree({})
        return
      }
      api<{ lines: { available: number; total: number }[] }>('/rooms/availability', {
        method: 'POST',
        body: JSON.stringify({
          event_id: eventId,
          lines: completeRooms.map(({ r }) => ({
            unit_id: r.unitId, room_type: r.roomType,
            count: Number.isInteger(r.count) && r.count > 0 ? r.count : 0,
            check_in: r.checkIn, check_out: r.checkOut,
          })),
        }),
      })
        .then((res) => {
          const next: Record<number, { available: number; total: number }> = {}
          completeRooms.forEach(({ i }, k) => {
            const l = res.lines[k]
            if (l) next[i] = { available: l.available, total: l.total }
          })
          setFree(next)
        })
        // A failed lookup must never block the decision — the save still enforces the cap.
        .catch(() => setFree({}))
    }, 400)
    return () => clearTimeout(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [roomSignature, eventId])

  /** Changing lodge re-points the category, since the old one may not exist at the new lodge. */
  function changeRoomUnit(i: number, unitId: string) {
    const types = typesFor(unitId)
    const cur = rooms[i]!
    const next = [...rooms]
    next[i] = { ...cur, unitId, roomType: types.includes(cur.roomType) ? cur.roomType : (types[0] ?? '') }
    setRoomDraft(next)
  }

  const priceChanges = priceDraft?.length ?? 0
  const dirty =
    Object.keys(fnEdits).length > 0 ||
    Object.keys(menuEdits).length > 0 ||
    roomDraft !== null ||
    priceChanges > 0

  async function save() {
    if (!detail) return
    if (detail.isLocked && !reason.trim()) {
      toast.error('This booking is locked — give a reason for the change.')
      return
    }
    if (priceDraft === null) {
      toast.error('A discounted price must be a number, and never more than the actual price.')
      return
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
    if (priceDraft.length) {
      edits.lineDiscounts = priceDraft
      if (priceRemark.trim()) edits.discountRemark = priceRemark.trim()
    }
    if (reason.trim()) edits.reason = reason.trim()

    setSaving(true)
    try {
      const res = await api<{ result: { settled: unknown[]; changes: string[]; invoiceReissued: boolean; invoiceNo: string | null; remaining: number } }>(
        `/approvals/bundles/${eventId}/decide`,
        {
          method: 'POST',
          body: JSON.stringify({
            // Every pending ask is approved. His edits above are how he says no — see the note
            // at the top of this file.
            decisions: pending.map((a) => ({ id: a.id, source: a.source, action: 'approve' })),
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
        setFnEdits({}); setMenuEdits({}); setRoomDraft(null); setReason('')
        setPriceDraft([]); setPriceRemark('')
        setGridKey((k) => k + 1)
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
  const toggle = (section: string) => setOpen((o) => ({ ...o, [section]: !o[section] }))

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

      {/* ── 1. The requests, as an index ─────────────────────────────────────── */}
      <section className="space-y-3">
        <h2 className="text-lg font-semibold">
          Awaiting you{pending.length > 0 && <span className="ml-2 text-sm font-normal text-muted-foreground">{pending.length} item(s)</span>}
        </h2>
        {pending.length === 0 ? (
          <p className="text-sm text-muted-foreground">Nothing pending on this booking. You can still edit the proposal below.</p>
        ) : (
          <ul className="space-y-2">
            {pending.map((a) => {
              const target = targetOf(a)
              const prices = askedPrices(a)
              // Raised BY a confirmation, not by someone asking for something (12 Sep 2026).
              // These prices are already in force and the booking is already held, so calling
              // them "Requested" would have the GM believe the guest is still waiting on him.
              const atConfirm = a.payload.raisedAtConfirm === true
              return (
                <li key={a.id} className={cn('rounded-lg border p-3', PURPLE_ROW)}>
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div className="min-w-0 space-y-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className={cn('rounded-full px-2 py-0.5 text-xs', SECTION_STYLES[a.section])}>
                          {SECTION_LABEL[a.section] ?? a.section}
                        </span>
                        <span
                          className={cn(
                            'rounded-full px-2 py-0.5 text-xs font-medium text-white',
                            atConfirm ? 'bg-amber-600' : 'bg-violet-600',
                          )}
                        >
                          {atConfirm ? 'Already given' : 'Requested'}
                        </span>
                      </div>
                      <p className="text-sm">{a.summary}</p>
                      {/* The prices themselves, cell by cell. A discount request used to reach
                          this screen as its own headline figure and nothing else, so the price
                          being asked for — the only thing the GM is deciding — was nowhere on
                          the page (client, 8 Sep 2026). */}
                      {prices.length > 0 && (
                        <ul className="space-y-0.5 text-sm">
                          {prices.map((l) => (
                            <li key={l.key} className="flex flex-wrap items-baseline gap-x-2 tabular-nums">
                              <span className="text-muted-foreground">{l.label}</span>
                              <span className="text-muted-foreground">{formatPaise(l.actualPaise)}</span>
                              <span aria-hidden>→</span>
                              <span className="font-medium text-violet-700 dark:text-violet-300">
                                {formatPaise(l.discountedPaise)}
                              </span>
                            </li>
                          ))}
                        </ul>
                      )}
                      {atConfirm && (
                        <p className="text-xs text-muted-foreground">
                          Given within the cap, and the bill moved under it since. The booking is
                          confirmed at these prices and the guest has them — approving changes
                          nothing. To refuse, type the actual price back in Prices.
                        </p>
                      )}
                      <p className="text-xs text-muted-foreground">raised by {a.raisedByName}</p>
                    </div>
                    {target && (
                      <Button size="sm" variant="outline" className="shrink-0" onClick={() => jumpTo(target.section)}>
                        {target.label} <ChevronRight className="size-3.5" aria-hidden />
                      </Button>
                    )}
                  </div>
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

      {/* ── 2. The proposal, editable, one section at a time ─────────────────── */}
      <section className="space-y-3">
        <div>
          <h2 className="text-lg font-semibold">The proposal</h2>
          <p className="text-sm text-muted-foreground">
            Open a section to change it. Everything you change here is written straight to the
            booking when you save.
          </p>
        </div>

        {p.functions.map((f) => {
          const edit = fnEdits[f.id] ?? {}
          const set = (patch: Partial<Fn>) => setFnEdits({ ...fnEdits, [f.id]: { ...edit, ...patch } })
          const id = `fn:${f.id}`
          return (
            <Section
              key={f.id}
              id={id}
              title={edit.name ?? f.name}
              meta={`${edit.date ?? f.date} · ${(edit.startTime ?? f.startTime).slice(0, 5)}–${(edit.endTime ?? f.endTime).slice(0, 5)} · ${edit.pax ?? f.pax} pax · ${formatPaise(f.subtotalPaise)}`}
              count={countBySection[id] ?? 0}
              open={Boolean(open[id])}
              flash={flash === id}
              onToggle={() => toggle(id)}
            >
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
                              const dishId = `dish-${f.id}-${seg.name}-${dish}`.replace(/\s+/g, '-')
                              return (
                                <label
                                  key={dish}
                                  htmlFor={dishId}
                                  data-requested={isAsked || undefined}
                                  className={cn(
                                    'flex cursor-pointer items-center gap-2 rounded px-2 py-1 text-sm hover:bg-muted/60',
                                    isAsked && PURPLE_ROW,
                                  )}
                                >
                                  <Checkbox
                                    id={dishId}
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
            </Section>
          )
        })}

        {/* Rooms */}
        <Section
          id="rooms"
          title="Rooms"
          meta={
            rooms.length === 0
              ? 'none on this booking'
              : `${rooms.reduce((n, r) => n + (Number.isFinite(r.count) ? r.count : 0), 0)} rooms · ${formatPaise(p.totals.roomsPaise)} + ${formatPaise(p.totals.roomsTaxPaise)} tax`
          }
          count={countBySection.rooms ?? 0}
          open={Boolean(open.rooms)}
          flash={flash === 'rooms'}
          onToggle={() => toggle('rooms')}
        >
          {rooms.length === 0 ? (
            <p className="text-sm text-muted-foreground">No rooms on this booking.</p>
          ) : (
            <div className="space-y-2">
              {rooms.map((r, i) => {
                const avail = free[i]
                const over = avail != null && r.count > avail.available
                return (
                  <div key={r.id || i} className="space-y-1">
                    <div className="grid items-end gap-2 sm:grid-cols-[1fr_1fr_5rem_1fr_1fr_auto]">
                      <div>
                        <Label className="text-xs" htmlFor={`unit-${i}`}>Lodge</Label>
                        <select
                          id={`unit-${i}`}
                          className="mt-1 h-8 w-full rounded-md border bg-background px-2 text-sm"
                          value={r.unitId ?? ''}
                          onChange={(e) => changeRoomUnit(i, e.target.value)}
                        >
                          {options.lodgingUnits.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
                        </select>
                      </div>
                      <div>
                        <Label className="text-xs" htmlFor={`type-${i}`}>Category</Label>
                        {/* Only this lodge's categories — see typesFor. */}
                        <select
                          id={`type-${i}`}
                          className="mt-1 h-8 w-full rounded-md border bg-background px-2 text-sm"
                          value={r.roomType}
                          onChange={(e) => { const next = [...rooms]; next[i] = { ...r, roomType: e.target.value }; setRoomDraft(next) }}
                        >
                          {typesFor(r.unitId).map((t) => <option key={t} value={t}>{t.replace(/_/g, ' ')}</option>)}
                        </select>
                      </div>
                      <div>
                        <Label className="text-xs" htmlFor={`count-${i}`}>Rooms</Label>
                        <Input
                          id={`count-${i}`} type="number" min={1} max={avail?.available || undefined}
                          className={cn('mt-1 h-8 tabular-nums', over && 'border-destructive')}
                          aria-invalid={over || undefined}
                          value={r.count}
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
                        {/* At least one night. Equal dates is a stay of zero nights, which the
                            server refuses — better to make it unpickable than to explain it. */}
                        <Input
                          id={`out-${i}`} type="date" className="mt-1 h-8" value={r.checkOut}
                          min={r.checkIn ? addDays(r.checkIn, 1) : undefined}
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
                    {/* Live from the lodging inventory — the same rows the lodging calendar draws. */}
                    {avail && (
                      <p className={cn('text-xs', over ? 'text-destructive' : 'text-muted-foreground')}>
                        {over
                          ? `Only ${avail.available} of ${avail.total} free over these nights — this line asks for ${r.count}.`
                          : `${avail.available} of ${avail.total} free over these nights.`}
                      </p>
                    )}
                  </div>
                )
              })}
            </div>
          )}
          <Button
            variant="outline" size="sm"
            onClick={() => {
              const unitId = options.lodgingUnits[0]?.id ?? null
              // Check-out defaults a day past check-in: a stay of zero nights is not a stay,
              // and the server rejects it.
              const checkIn = p.event.plannedFrom ?? p.functions[0]?.date ?? ''
              const checkOut = p.event.plannedTo && p.event.plannedTo > checkIn ? p.event.plannedTo : addDays(checkIn, 1)
              setRoomDraft([
                ...rooms,
                {
                  id: '', unitId, roomType: typesFor(unitId)[0] ?? '',
                  count: 1, checkIn, checkOut, nights: 1, ratePaise: 0, amountPaise: 0,
                },
              ])
            }}
          >
            <Plus className="size-3.5" aria-hidden /> Add a room line
          </Button>
        </Section>

        {/* The bill in two columns, the same tool the counter uses (client, 20 Aug 2026:
            "same thing do with the GM one too so that whole site should be unified as same
            discount method"). His prices are not held to the 10% cap and take effect at once —
            the server decides that, so this screen does not have to claim it.

            Controlled: the grid reports its column up and saves nothing itself. Until 8 Sep it
            had its own Save button, on the theory that "a price is a price" and should not hide
            behind the same button as a menu revision. In the field that meant a GM answering a
            price request pressed Save here, then Save again at the foot of the page, and a
            half-done decision was one forgotten click away. */}
        <Section
          id="pricing"
          title="Prices & discounts"
          meta={`${formatPaise(p.totals.totalPaise)} total${priceChanges > 0 ? ` · ${priceChanges} price(s) changed` : ''}`}
          count={countBySection.pricing ?? 0}
          open={Boolean(open.pricing)}
          flash={flash === 'pricing'}
          onToggle={() => toggle('pricing')}
        >
          <DiscountGrid eventId={eventId} editable reloadKey={gridKey} onDraftChange={onPriceDraft} />
        </Section>
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
              {pending.length} request{pending.length === 1 ? '' : 's'} will be approved as the proposal now stands
              {priceChanges > 0 && ` · ${priceChanges} price(s) re-set`}
              {dirty && priceChanges === 0 && ' · proposal edited'}
              {detail.willReissueInvoice && dirty && ' · the guest’s document will be re-issued'}
            </p>
            {/* THE DISCOUNT, IN BOTH CURRENCIES, WHEREVER HE IS ON THE PAGE (client, 8 Sep 2026:
                "my GM can think in money and percentage as well"). The price sheet states the
                same figure in full, but it sits under a table that can run to twenty rows — so
                a GM typing at row six had the consequence of what he was typing off his screen.
                This bar is fixed, so it never is. */}
            {priceTotals.basePaise > 0 && (
              <p className="text-xs">
                <span className="text-muted-foreground">Discount on this booking</span>{' '}
                <span className="font-medium tabular-nums">
                  {formatPaise(priceTotals.givenPaise)} ·{' '}
                  {((priceTotals.givenPaise / priceTotals.basePaise) * 100).toFixed(1)}%
                </span>{' '}
                <span className="text-muted-foreground tabular-nums">
                  of {formatPaise(priceTotals.basePaise)}
                </span>
              </p>
            )}
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
              disabled={saving || priceDraft === null || (pending.length === 0 && !dirty)}
            >
              {saving && <Loader2 className="size-4 animate-spin" aria-hidden />}
              Save &amp; approve
            </Button>
          )}
        </div>
      </div>
    </div>
  )
}
