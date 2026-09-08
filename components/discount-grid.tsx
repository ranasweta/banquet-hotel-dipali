'use client'

import { Fragment, useCallback, useEffect, useState, type ReactNode } from 'react'
import { Trash2 } from 'lucide-react'
import { toast } from 'sonner'
import { api } from '@/lib/http'
import { formatPaise } from '@/lib/money'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { cn } from '@/lib/utils'

/**
 * The bill, in two columns: ACTUAL — what the line lists at — and DISCOUNTED — what the guest is
 * being charged for it (client, 20 Aug 2026).
 *
 * WHY IT LOOKS LIKE THIS. The panel it replaces asked for a head and a rupee figure and took
 * that figure off the end of the bill; the line prices on screen never moved. Staff standing at
 * the counter looking at "Venue — Imperial ₹75,000" and wanting to give it for ₹60,000 had to do
 * the subtraction in their head, type ₹15,000 somewhere else, and trust the total. They asked for
 * the obvious thing: the real price, and beside it a box already holding the real price, that
 * they type over with what the guest is actually paying. Nothing is subtracted anywhere — what
 * is in the Discounted column IS the payable — and the guest can read both columns and see what
 * they were given.
 *
 * ONE MASTER TOGGLE, not a tick per line (client, asked and answered): a booking with three
 * functions and four room categories has ten discountable lines, and ten checkboxes to reach one
 * price is not a counter tool. The column is always VISIBLE and prefilled; the toggle is what
 * makes it editable.
 *
 * The tax row has no cell, deliberately — the client struck it out by name. It is not fixed
 * either: it is charged on what is collected, so it moves when the room lines above it move.
 *
 * Every figure here comes from the server (`GET /events/:id/discounts`). Nothing on this screen
 * is recomputed locally: once a room's 5%/18% band is decided by its DISCOUNTED nightly rate, a
 * second copy of that arithmetic in the browser is a counter and a bill quietly disagreeing
 * about what the guest owes.
 */

type SheetLine = {
  key: string
  label: string
  actualPaise: number
  discountedPaise: number
  pending: boolean
  /** The price a still-undecided request asks for; null when nothing is pending on this line. */
  requestedPaise: number | null
}
type SheetRoomLine = SheetLine & { count: number; nights: number; ratePaise: number; gstRateBp: number; taxPaise: number }
type SheetFunction = {
  subEventId: string
  name: string
  eventDate: string
  startTime: string
  endTime: string
  pax: number
  venue: SheetLine
  food: SheetLine | null
  delicacyPaise: number
  actualSubtotalPaise: number
  discountedSubtotalPaise: number
}
type SheetRoomGroup = {
  unitId: string | null
  lodgeName: string | null
  lines: SheetRoomLine[]
  actualSubtotalPaise: number
  discountedSubtotalPaise: number
}
export type Sheet = {
  functions: SheetFunction[]
  roomGroups: SheetRoomGroup[]
  roomsTaxBands: { gstRateBp: number; actualPaise: number; discountedPaise: number }[]
  roomsTaxActualPaise: number
  roomsTaxPaise: number
  actualTotalPaise: number
  discountedTotalPaise: number
  lineDiscountPaise: number
  pendingDiscountPaise: number
  lumpDiscountPaise: number
  missing: { subEventId: string; name: string }[]
}
type LumpRow = { id: string; head: string; amountPaise: number; remark: string; status: string }
type Cap = {
  capPct: number
  capBasePaise: number
  capPaise: number
  usedPaise: number
  pendingPaise: number
  headroomPaise: number
}
export type LineDraft = { key: string; discountedPaise: number }
/**
 * What the page above needs to commit this column and to say what it comes to. `lines` is null
 * when a cell is not a price, so the page can grey its own Save rather than post a NaN.
 */
export type GridDraft = {
  lines: LineDraft[] | null
  remark: string
  /** Everything the column would give, lump rows included — the figure the cap is tested on. */
  givenPaise: number
  /** The bill at list price, so a share of it can be stated without a second copy of the sum. */
  basePaise: number
}

/**
 * Rupees as a person types them: "750", not "750.00", but "755.56" when the paise matter.
 * Used for the derived box, so a round rate does not arrive full of zeros.
 */
function rupeeText(paise: number): string {
  const r = paise / 100
  return Number.isInteger(r) ? String(r) : r.toFixed(2)
}
/** A share of the bill, to one decimal — a percentage read at a glance, never money. */
function pctOf(paise: number, basePaise: number): string {
  if (basePaise <= 0) return '—'
  return `${((paise / basePaise) * 100).toFixed(1)}%`
}

const toPaise = (text: string): number | null => {
  if (text.trim() === '') return null
  const n = Math.round(Number(text) * 100)
  return Number.isFinite(n) ? n : null
}

/** A row of the grid: a label, the actual, and the cell (editable or not) beside it. */
function MoneyRow({
  label,
  sub,
  actualPaise,
  line,
  draft,
  rateDraft,
  unit,
  editing,
  onDraft,
  onRateDraft,
  tone = 'normal',
  indent = false,
}: {
  label: ReactNode
  sub?: ReactNode
  actualPaise: number
  line?: SheetLine
  draft?: string
  rateDraft?: string
  /** What one unit of this line is, when it has one: 800 plates, or 66 room-nights. */
  unit?: { count: number; noun: string }
  editing?: boolean
  onDraft?: (key: string, value: string) => void
  onRateDraft?: (key: string, value: string) => void
  tone?: 'normal' | 'muted' | 'strong'
  indent?: boolean
}) {
  const given = line ? line.actualPaise - line.discountedPaise : 0
  const charged = unit && unit.count > 0 && line ? Math.round(line.discountedPaise / unit.count) : null
  return (
    // `data-requested` is what the approvals page's jump button aims at when a section is too
    // long for its header and the asked-for row to share a screen.
    <tr
      data-requested={line?.pending || undefined}
      className={cn(tone === 'strong' && 'font-medium', tone === 'muted' && 'text-xs text-muted-foreground')}
    >
      <td className={cn('px-2 py-2 sm:px-3', indent && 'pl-6')}>
        {label}
        {sub}
        {line?.pending && (
          // Violet AND the word, never colour alone — a decision hangs on seeing it (UI conventions).
          <Badge variant="outline" className="ml-2 border-violet-400 text-violet-600 dark:text-violet-400">
            Requested
          </Badge>
        )}
      </td>
      {/* Plain, whether or not something was given (client, 20 Aug 2026): it struck the actual
          price through, and a crossed-out number beside a live one reads as cancelled rather
          than as the price it still is. The Discounted cell carries the emphasis instead. */}
      <td className="px-2 py-2 sm:px-3 text-right tabular-nums">{formatPaise(actualPaise)}</td>
      <td className="px-2 py-2 sm:px-3 text-right tabular-nums">
        {line && editing && onDraft ? (
          <span className="flex flex-wrap items-center justify-end gap-x-2 gap-y-1">
            {/* THE RATE, AND THE TOTAL, EITHER WAY ROUND (client, 26 Aug 2026). Staff negotiate
                per plate and per night — "I'll give it at 750" — and were having to multiply by
                the pax in their head to type a total. Typing in one box fills the other; the
                one just typed is the one that means it. */}
            {unit && unit.count > 0 && onRateDraft && (
              <span className="flex items-center gap-1">
                <span className="text-muted-foreground">₹</span>
                <Input
                  inputMode="decimal"
                  aria-label={`Discounted rate per ${unit.noun} — ${line.label}`}
                  className="h-8 w-16 text-right tabular-nums sm:w-24"
                  value={rateDraft ?? ''}
                  onChange={(e) => onRateDraft(line.key, e.target.value)}
                />
                <span className="text-xs text-muted-foreground">/{unit.noun}</span>
              </span>
            )}
            <span className="flex items-center gap-1">
              <span className="text-muted-foreground">₹</span>
              <Input
                inputMode="decimal"
                aria-label={`Discounted price — ${line.label}`}
                className="h-8 w-20 text-right tabular-nums sm:w-32"
                value={draft ?? ''}
                onChange={(e) => onDraft(line.key, e.target.value)}
              />
            </span>
            {/* Still shown once the box is open: the Authority types over the asked-for price,
                and has to be able to see what he moved it FROM. */}
            {line.requestedPaise != null && (
              <span className="w-full text-xs font-normal text-violet-700 dark:text-violet-400">
                asked for {formatPaise(line.requestedPaise)}
              </span>
            )}
          </span>
        ) : (
          <span className={cn(given > 0 && 'font-medium text-emerald-700 dark:text-emerald-400')}>
            {formatPaise(line ? line.discountedPaise : actualPaise)}
            {/* What the guest is paying per plate or per night, once something has been given.
                On an undiscounted line it is the rate already printed in the label. */}
            {given > 0 && charged != null && (
              <span className="block text-xs font-normal text-muted-foreground">
                {formatPaise(charged)}/{unit!.noun}
              </span>
            )}
            {/* THE NUMBER, not just the badge (client, 8 Sep 2026). A price waiting on the
                Authority used to show as the actual with "Requested" beside the label, so the
                one figure the decision turns on — what the guest was quoted — appeared on no
                screen at all. It is printed under the price in force, which is still what a
                counter collects until he says yes. */}
            {line?.requestedPaise != null && (
              <span className="block text-xs font-medium text-violet-700 dark:text-violet-400">
                Requested {formatPaise(line.requestedPaise)}
              </span>
            )}
          </span>
        )}
      </td>
    </tr>
  )
}

/** Every discountable line of a sheet, in the order they are drawn — the source of the prefill. */
function linesOf(sheet: Sheet): SheetLine[] {
  return [
    ...sheet.functions.flatMap((f) => (f.food ? [f.venue, f.food] : [f.venue])),
    ...sheet.roomGroups.flatMap((g) => g.lines),
  ]
}

/**
 * What one unit of a line is, for the lines that have one: a food line is priced per plate,
 * a room line per room-night. A venue is hired whole and has none, so it keeps the single box.
 */
function unitsOf(sheet: Sheet): Map<string, { count: number; noun: string }> {
  const units = new Map<string, { count: number; noun: string }>()
  for (const f of sheet.functions) {
    if (f.food && f.pax > 0) units.set(f.food.key, { count: f.pax, noun: 'plate' })
  }
  for (const g of sheet.roomGroups) {
    for (const l of g.lines) {
      const n = l.count * l.nights
      if (n > 0) units.set(l.key, { count: n, noun: 'night' })
    }
  }
  return units
}

/**
 * The boxes as they open. The price as it stands — the actual on an undiscounted line, what is
 * already given on a discounted one — EXCEPT for a line waiting on the Authority, where the
 * Authority himself gets the price that was asked for.
 *
 * That exception is the whole point of the redesign (client, 8 Sep 2026): "if he keeps it he
 * can simply save the changes, or if he doesn't then simply change the numbers". Prefilling him
 * with the asked-for figure makes approving-as-requested the do-nothing answer and typing over
 * it the deliberate one. Nobody else is prefilled with it: a Booking Manager who saved the grid
 * unchanged would otherwise re-raise the very request he is waiting on.
 */
function seedDrafts(sheet: Sheet, uncapped: boolean) {
  const units = unitsOf(sheet)
  const draft: Record<string, string> = {}
  const rates: Record<string, string> = {}
  for (const l of linesOf(sheet)) {
    const start = uncapped && l.requestedPaise != null ? l.requestedPaise : l.discountedPaise
    draft[l.key] = rupeeText(start)
    const u = units.get(l.key)
    if (u) rates[l.key] = rupeeText(Math.round(start / u.count))
  }
  return { draft, rates }
}

export function DiscountGrid({
  eventId,
  editable,
  onChanged,
  children,
  reloadKey,
  onDraftChange,
}: {
  eventId: string
  editable: boolean
  /** Called after a successful save, so the page's own totals (quote, ledger) re-fetch. */
  onChanged?: () => void | Promise<void>
  /** Extra total rows — payable, the shown 18%, the advance — rendered under Estimated total. */
  children?: ReactNode
  /** Bump to force a re-fetch when the booking changed elsewhere on the page. */
  reloadKey?: number
  /**
   * CONTROLLED MODE, for the approvals screen. When given, the column is open from the start
   * and this grid saves nothing of its own: every keystroke is reported up and the page commits
   * it with its own button. The Authority answers a price request by typing the price and
   * pressing one "Save & approve", rather than saving the grid and then deciding the ask —
   * two buttons for one decision, which is what he had before (client, 8 Sep 2026).
   *
   * Must be referentially stable (`useCallback`) — it is an effect dependency.
   */
  onDraftChange?: (draft: GridDraft) => void
}) {
  const [sheet, setSheet] = useState<Sheet | null>(null)
  const [lump, setLump] = useState<LumpRow[]>([])
  const [cap, setCap] = useState<Cap | null>(null)
  // Whether the cap binds this user — read from the server rather than assumed, so the Authority
  // is not told his own discount needs his approval.
  const [uncapped, setUncapped] = useState(false)
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState<Record<string, string>>({})
  /** The per-plate / per-night box beside it, as typed. Derived from `draft` unless being typed in. */
  const [rateDraft, setRateDraft] = useState<Record<string, string>>({})
  const [remark, setRemark] = useState('')
  const [busy, setBusy] = useState(false)

  /** The page owns the button; this grid only reports what has been typed. */
  const controlled = Boolean(onDraftChange)

  const load = useCallback(async () => {
    try {
      const d = await api<{ sheet: Sheet; lumpDiscounts: LumpRow[]; cap: Cap; uncapped: boolean }>(`/events/${eventId}/discounts`)
      setSheet(d.sheet)
      setLump(d.lumpDiscounts)
      setCap(d.cap)
      setUncapped(d.uncapped)
      // Controlled mode has no toggle to open the column, so the boxes are seeded on every
      // load — including the reload after the page's own save, which must not leave the
      // previous draft sitting over prices that have moved.
      if (controlled) {
        const seeded = seedDrafts(d.sheet, d.uncapped)
        setDraft(seeded.draft)
        setRateDraft(seeded.rates)
        setRemark('')
        setEditing(true)
      }
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed to load prices')
    }
  }, [eventId, controlled])

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load()
  }, [load, reloadKey])

  const allLines: SheetLine[] = sheet ? linesOf(sheet) : []
  const unitByKey = sheet ? unitsOf(sheet) : new Map<string, { count: number; noun: string }>()

  function startEditing() {
    if (!sheet) return
    const seeded = seedDrafts(sheet, uncapped)
    setDraft(seeded.draft)
    setRateDraft(seeded.rates)
    setRemark('')
    setEditing(true)
  }

  function stopEditing() {
    setEditing(false)
    setDraft({})
    setRateDraft({})
    setRemark('')
  }

  const parsed = allLines.map((l) => {
    const raw = draft[l.key]
    const paise = raw == null || raw.trim() === '' ? null : Math.round(Number(raw) * 100)
    return { line: l, paise: paise != null && Number.isFinite(paise) ? paise : null }
  })
  const badCell = parsed.find((p) => p.paise == null || p.paise < 0 || p.paise > p.line.actualPaise)
  /**
   * Which cells the save carries.
   *
   * Normally: the ones that differ from the price in force. But a line with a REQUEST on it is
   * decided by this save whatever the Authority does with it, so it always travels. Leaving the
   * prefill alone gives the guest the asked-for price; typing the actual back refuses it — and
   * the actual is what the line is charging RIGHT NOW, so "differs from what is in force" is
   * false for exactly the refusal. Sending nothing there would leave the ask to be approved by
   * the decision list a moment later, which is the opposite of what he typed.
   *
   * Only for the Authority, who is the one deciding. A counter's boxes are prefilled with the
   * price in force, and re-sending a colleague's pending line on an unrelated save would
   * silently cancel the request he is waiting on.
   */
  const changed = parsed.filter(
    (p) => p.paise != null && (p.paise !== p.line.discountedPaise || (uncapped && p.line.requestedPaise != null)),
  )
  // What this column comes to, so the manager sees the consequence before saving rather than
  // after. The cap is announced only when it is crossed — a standing headroom figure on a screen
  // read beside the guest tells them there is a bigger discount to push for (client, 11 Aug 2026).
  const draftGivenPaise = editing
    ? parsed.reduce((n, p) => n + (p.paise == null ? 0 : Math.max(0, p.line.actualPaise - p.paise)), 0)
    : 0
  const wouldExceed = Boolean(
    editing && cap && !uncapped && !badCell && draftGivenPaise + (sheet?.lumpDiscountPaise ?? 0) > cap.capPaise,
  )

  // Reported up on every keystroke in controlled mode. `null` for a cell that is not a price,
  // so the page can grey its own Save rather than post a NaN. The signature is a string because
  // `changed` is a fresh array each render and would re-fire the effect for ever.
  const changedSig = changed.map((c) => `${c.line.key}=${c.paise}`).join(',')
  const givenNow = draftGivenPaise + (sheet?.lumpDiscountPaise ?? 0)
  const basePaise = cap?.capBasePaise ?? 0
  useEffect(() => {
    if (!onDraftChange) return
    onDraftChange({
      lines: badCell ? null : changed.map((c) => ({ key: c.line.key, discountedPaise: c.paise! })),
      remark: remark.trim(),
      givenPaise: givenNow,
      basePaise,
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [changedSig, remark, Boolean(badCell), givenNow, basePaise, onDraftChange])

  async function save() {
    if (badCell) {
      toast.error('A discounted price must be a number, and never more than the actual price.')
      return
    }
    setBusy(true)
    try {
      const res = await api<{ deferred: boolean; changed: number }>(`/events/${eventId}/discounts`, {
        method: 'PUT',
        body: JSON.stringify({
          lines: changed.map((c) => ({ key: c.line.key, discounted_paise: c.paise })),
          ...(remark.trim() ? { remark: remark.trim() } : {}),
        }),
      })
      toast[res.deferred ? 'info' : 'success'](
        res.deferred
          ? `Over the ${cap?.capPct ?? 10}% cap — sent to the GM for approval. Prices stay as they are until he decides.`
          : `${res.changed} price${res.changed === 1 ? '' : 's'} updated`,
      )
      stopEditing()
      await load()
      await onChanged?.()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not save')
    } finally {
      setBusy(false)
    }
  }

  /**
   * The two boxes, kept in step. The TOTAL is what gets saved — the rate is a way of arriving
   * at it, and the discount stored underneath is still a flat amount off (migration 0036), so
   * a rate typed today does not survive a pax change on its own. That is the client's decision
   * of 26 Aug 2026, taken so a discount can never grow past the 10% cap without anyone typing.
   *
   * Rounding is honest about itself: a rate that does not divide the total exactly is shown to
   * the paise, and whichever box was typed last is the one that decides the money.
   */
  const onDraft = (key: string, value: string) => {
    setDraft((d) => ({ ...d, [key]: value }))
    const u = unitByKey.get(key)
    if (!u) return
    const paise = toPaise(value)
    setRateDraft((r) => ({ ...r, [key]: paise == null ? '' : rupeeText(Math.round(paise / u.count)) }))
  }

  const onRateDraft = (key: string, value: string) => {
    setRateDraft((r) => ({ ...r, [key]: value }))
    const u = unitByKey.get(key)
    if (!u) return
    const paise = toPaise(value)
    setDraft((d) => ({ ...d, [key]: paise == null ? '' : rupeeText(paise * u.count) }))
  }

  /**
   * What a line is worth right now — the typed figure while the column is open, the saved one
   * otherwise. Only the sub-totals use it. The tax rows, the Estimated total and the payable
   * stay as the server last computed them until Save, because a room's 5%/18% band can move
   * with its price and a guess in the browser is exactly the disagreement this design avoids.
   */
  const liveOf = (l: SheetLine): number => {
    if (!editing) return l.discountedPaise
    const p = parsed.find((x) => x.line.key === l.key)
    return p?.paise != null && p.paise >= 0 && p.paise <= l.actualPaise ? p.paise : l.discountedPaise
  }
  const totalRow = (actualPaise: number, discountedPaise: number): SheetLine => ({
    key: '', label: '', actualPaise, discountedPaise, pending: false, requestedPaise: null,
  })

  /** Clears a lump discount recorded before 20 Aug 2026 — the only kind that can be removed
   *  outright, because the others are prices and a price is changed by typing over it. */
  async function removeLump(id: string) {
    try {
      await api(`/discounts/${id}`, { method: 'DELETE' })
      await load()
      await onChanged?.()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not remove')
    }
  }

  if (!sheet) return <p className="text-sm text-muted-foreground">Pricing…</p>

  const cell = (l: SheetLine) => ({
    line: l,
    draft: draft[l.key],
    rateDraft: rateDraft[l.key],
    unit: unitByKey.get(l.key),
    editing,
    onDraft,
    onRateDraft,
  })

  return (
    <div className="space-y-3">
      {sheet.missing.length > 0 && (
        <p className="rounded-md border border-destructive/40 bg-destructive/5 px-2 py-2 sm:px-3 text-sm text-destructive">
          No rate is defined for: {sheet.missing.map((m) => m.name).join(', ')}. An Authority-approved
          manual rate is needed before this can be confirmed (BR-R1).
        </p>
      )}

      {editable && !controlled && (
        <label className="flex items-center gap-2 text-sm font-medium">
          <Checkbox
            checked={editing}
            onCheckedChange={(v) => (v ? startEditing() : stopEditing())}
            aria-label="Edit the discounted prices"
          />
          Discounted{' '}
          <span className="font-normal text-muted-foreground">— type what the guest is paying</span>
        </label>
      )}

      {/* 21rem is the table's own min-content width when it is being read, so the three columns
          fit a 390px phone without a sideways swipe — the whole point of the screen is comparing
          two of them, and a column you have to go and find is a column you will not check. It
          still scrolls inside this box rather than pushing the page, which is what the extra
          width of the input boxes needs while the column is open. */}
      <div className="overflow-x-auto rounded-lg border">
        <table className="w-full min-w-[21rem] text-sm">
          <thead>
            <tr className="border-b bg-muted/40 text-xs">
              <th className="px-2 py-2 sm:px-3 text-left font-medium">Charge</th>
              <th className="px-2 py-2 sm:px-3 text-right font-medium">Actual</th>
              <th className="px-2 py-2 sm:px-3 text-right font-medium">Discounted</th>
            </tr>
          </thead>
          <tbody className="divide-y">
            {/* Every function spelled out — venue, menu, pax and the arithmetic — so the total
                can be checked line by line rather than taken on trust. */}
            {sheet.functions.map((f) => (
              <Fragment key={f.subEventId}>
                <tr className="bg-muted/40">
                  <td colSpan={3} className="px-2 py-1.5 sm:px-3 text-xs font-semibold">
                    {f.name}
                    <span className="ml-2 font-normal tabular-nums text-muted-foreground">
                      {f.eventDate} · {f.startTime.slice(0, 5)} – {f.endTime.slice(0, 5)} · {f.pax} pax
                    </span>
                  </td>
                </tr>
                <MoneyRow label={f.venue.label} actualPaise={f.venue.actualPaise} {...cell(f.venue)} />
                {f.food ? (
                  <MoneyRow label={f.food.label} actualPaise={f.food.actualPaise} {...cell(f.food)} />
                ) : (
                  <MoneyRow label={`Food — no menu chosen yet (${f.pax} pax)`} actualPaise={0} />
                )}
                {/* The Chef's priced delicacies, charged beside the food line rather than
                    inside the plate rate (client, 27 Aug 2026) — the split the bill and the
                    document both use. No cell: the discount is given on the food line above,
                    and this is charged at the Chef's price either way. It was absent from this
                    screen altogether until 26 Aug, which left the sub-total short. */}
                {f.delicacyPaise > 0 && (
                  <MoneyRow
                    label={`Chef's delicacies — ${f.pax} pax`}
                    actualPaise={f.delicacyPaise}
                  />
                )}
                <MoneyRow
                  label={`${f.name} sub-total`}
                  actualPaise={f.actualSubtotalPaise}
                  line={totalRow(
                    f.actualSubtotalPaise,
                    liveOf(f.venue) + (f.food ? liveOf(f.food) : 0) + f.delicacyPaise,
                  )}
                  tone="muted"
                />
              </Fragment>
            ))}

            {sheet.roomGroups.length > 0 && (
              <>
                <tr className="bg-muted/40">
                  <td colSpan={3} className="px-2 py-1.5 sm:px-3 text-xs font-semibold">Rooms</td>
                </tr>
                {sheet.roomGroups.map((g) => (
                  <Fragment key={g.unitId ?? 'no-lodge'}>
                    <tr>
                      <td colSpan={3} className="px-2 pt-2 pb-1 sm:px-3 text-xs font-medium text-muted-foreground">
                        {g.lodgeName ?? 'Lodge'}
                      </td>
                    </tr>
                    {g.lines.map((l) => (
                      <MoneyRow
                        key={l.key}
                        indent
                        label={l.label}
                        sub={
                          <span className="ml-2 text-xs text-muted-foreground">
                            × {formatPaise(l.ratePaise)}
                            {/* The band beside the rate that decides it — and it is decided by
                                what the night is CHARGED at now, so a discount can move it.
                                The exempt note is not decoration: a dormitory draws no room GST
                                at all (client, 8 Sep 2026), so without it the "Tax on rooms — 5%"
                                below is charged on a base that does not match the rooms above it
                                and reads as an arithmetic error. */}
                            {l.gstRateBp === 1800 && ' · GST 18%'}
                            {l.gstRateBp === 0 && ' · GST exempt'}
                          </span>
                        }
                        actualPaise={l.actualPaise}
                        {...cell(l)}
                      />
                    ))}
                    <MoneyRow
                      indent
                      label={`${g.lodgeName ?? 'Lodge'} sub-total`}
                      actualPaise={g.actualSubtotalPaise}
                      line={totalRow(g.actualSubtotalPaise, g.lines.reduce((n, l) => n + liveOf(l), 0))}
                      tone="muted"
                    />
                  </Fragment>
                ))}
                {/* No cell of its own (client, 20 Aug 2026) — but not frozen either: it is
                    charged on what we collect, so it follows the room lines down. */}
                {/* One line per rate, 5% before 18% (client, 22 Aug 2026), and no word about the
                    threshold that decides them — which band a room falls in is our arithmetic,
                    not something a guest reading the total needs explained. */}
                {sheet.roomsTaxBands.map((b) => (
                  <MoneyRow
                    key={b.gstRateBp}
                    label={`Tax on rooms — ${b.gstRateBp / 100}%`}
                    actualPaise={b.actualPaise}
                    line={totalRow(b.actualPaise, b.discountedPaise)}
                  />
                ))}
              </>
            )}

            <MoneyRow
              label="Estimated total"
              actualPaise={sheet.actualTotalPaise}
              line={totalRow(sheet.actualTotalPaise, sheet.discountedTotalPaise)}
              tone="strong"
            />
            {/* Pre-20-Aug-2026 lump discounts. Kept because they were promised to guests, and
                shown on their own line because they belong to no line above. */}
            {lump
              .filter((d) => d.status === 'effective')
              .map((d) => (
                <tr key={d.id} className="text-emerald-700 dark:text-emerald-400">
                  <td className="px-2 py-2 sm:px-3">
                    Discount recorded earlier — <span className="capitalize">{d.head}</span>
                    {d.remark && <span className="text-muted-foreground"> · {d.remark}</span>}
                  </td>
                  <td />
                  <td className="px-2 py-2 sm:px-3 text-right tabular-nums">
                    <span className="inline-flex items-center gap-2">
                      − {formatPaise(d.amountPaise)}
                      {editable && (
                        <Button size="icon-xs" variant="ghost" onClick={() => removeLump(d.id)} aria-label="Remove this discount">
                          <Trash2 className="size-3" />
                        </Button>
                      )}
                    </span>
                  </td>
                </tr>
              ))}
            {children}
          </tbody>
        </table>
      </div>

      {/* HOW MUCH OF THIS BOOKING IS BEING GIVEN AWAY, as a percentage (client, 8 Sep 2026:
          "it should also show the current total % discounted from total so that GM can get the
          idea how much is discounted on that event").

          The Authority only. The same figures on a counter screen would be a standing headroom
          notice read across the desk from the guest, which is the thing the 11 Aug decision took
          off this component: it tells them there is a bigger discount to push for. He is the one
          person who has to see the whole picture before deciding, and the cap does not bind him
          anyway (FR-11.3a). */}
      {uncapped && cap && cap.capBasePaise > 0 && (
        <div className="rounded-lg border p-3 text-sm">
          <div className="mb-2 font-medium">Discount on this booking</div>
          <table className="w-full">
            <tbody className="[&>tr>td]:py-0.5">
              <tr className="text-muted-foreground">
                <td>Bill at list price</td>
                <td className="text-right tabular-nums">{formatPaise(cap.capBasePaise)}</td>
                <td className="w-16 text-right tabular-nums">100%</td>
              </tr>
              <tr>
                <td>Given, in force now</td>
                <td className="text-right tabular-nums">{formatPaise(cap.usedPaise)}</td>
                <td className="text-right tabular-nums">{pctOf(cap.usedPaise, cap.capBasePaise)}</td>
              </tr>
              {cap.pendingPaise > 0 && (
                <tr className="text-violet-700 dark:text-violet-400">
                  <td>Requested, awaiting you</td>
                  <td className="text-right tabular-nums">{formatPaise(cap.pendingPaise)}</td>
                  <td className="text-right tabular-nums">{pctOf(cap.pendingPaise, cap.capBasePaise)}</td>
                </tr>
              )}
              {editing && !badCell && (
                <tr className="font-medium">
                  <td>If you save this column</td>
                  <td className="text-right tabular-nums">
                    {formatPaise(draftGivenPaise + (sheet.lumpDiscountPaise ?? 0))}
                  </td>
                  <td className="text-right tabular-nums">
                    {pctOf(draftGivenPaise + (sheet.lumpDiscountPaise ?? 0), cap.capBasePaise)}
                  </td>
                </tr>
              )}
              <tr className="text-muted-foreground">
                <td>
                  The cap on everyone else
                  <span className="ml-1 text-xs">— it does not bind you</span>
                </td>
                <td className="text-right tabular-nums">{formatPaise(cap.capPaise)}</td>
                <td className="text-right tabular-nums">{cap.capPct}%</td>
              </tr>
            </tbody>
          </table>
        </div>
      )}

      {editing && (
        <div className="flex flex-wrap items-end gap-2 rounded-lg border p-3">
          {/* basis-48, not bare grow: on a phone the buttons already eat the row, and a
              growing-from-zero remark became a sliver a few characters wide. */}
          <div className="grow basis-48 space-y-1">
            <Label className="text-xs">Remark (optional)</Label>
            <Input value={remark} onChange={(e) => setRemark(e.target.value)} placeholder="e.g. owner's guest" />
          </div>
          {!controlled && (
            <>
              <Button onClick={save} disabled={busy || changed.length === 0 || Boolean(badCell)}>
                Save {changed.length > 0 && `(${changed.length})`}
              </Button>
              <Button variant="ghost" onClick={stopEditing} disabled={busy}>
                Cancel
              </Button>
            </>
          )}
          <p className="w-full text-xs text-muted-foreground">
            Type what the guest is actually paying for each line. The actual price stays beside it.
            Sub-totals follow as you type; the tax and the totals below settle when you save.
            {controlled && ' These prices are saved with the rest of your decision, at the bottom of the page.'}
            {draftGivenPaise > 0 && (
              <span className="ml-1 font-medium text-foreground">Giving {formatPaise(draftGivenPaise)}.</span>
            )}
            {badCell && (
              <span className="ml-1 font-medium text-destructive">
                A discounted price cannot be more than the actual price.
              </span>
            )}
            {wouldExceed && (
              <span className="ml-1 font-medium text-amber-600">
                · over the {cap?.capPct ?? 10}% cap — this goes to the GM for approval, and prices stay
                as they are until he decides.
              </span>
            )}
          </p>
        </div>
      )}
    </div>
  )
}
