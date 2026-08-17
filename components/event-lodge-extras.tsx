'use client'

import { useCallback, useEffect, useState } from 'react'
import { BedDouble, Loader2, Lock, Plus, Trash2, UtensilsCrossed } from 'lucide-react'
import { toast } from 'sonner'
import { api } from '@/lib/http'
import { formatPaise, rupeesToPaise } from '@/lib/money'
import { titleCase } from '@/lib/text'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Badge } from '@/components/ui/badge'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'

type RoomLine = {
  id: string
  unitId: string | null
  lodge: string
  roomType: string
  count: number
  nights: number
  ratePaise: number
  amountPaise: number
  remarks: string | null
  /** 500 or 1800 — the band this room's nightly rate puts it in. Both are collected. */
  gstRateBp: number
}
type Option = { unitId: string; unitName: string; roomType: string; ratePaise: number }
type View = {
  closed: boolean
  rooms: RoomLine[]
  roomsPaise: number
  roomsTaxPaise: number
  inRoomDiningPaise: number
  totalPaise: number
  options: Option[]
}

/**
 * The Lodge Manager's extras panel (client, 15 Aug 2026): rooms given out beyond the booking,
 * and the in-room dining total.
 *
 * Both totals are shown together and the tax is shown on its own line, because the 5% on an
 * extra room is money the hotel collects while the 18% elsewhere is not (rule 11) — a single
 * headline figure here would be the one number the desk quotes at checkout.
 */
export function EventLodgeExtras({ eventId, editable }: { eventId: string; editable: boolean }) {
  const [view, setView] = useState<View | null>(null)
  const load = useCallback(async () => setView(await api<View>(`/events/${eventId}/lodge-extras`)), [eventId])
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    load().catch((e) => toast.error(e instanceof Error ? e.message : 'Failed to load lodge extras'))
  }, [load])

  if (!view) {
    return (
      <div className="flex items-center gap-2 p-2 text-sm text-muted-foreground">
        <Loader2 className="size-4 animate-spin" /> Loading…
      </div>
    )
  }

  const canEdit = editable && !view.closed
  const hasAnything = view.rooms.length > 0 || view.inRoomDiningPaise > 0

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="text-sm text-muted-foreground">
          Extras total:{' '}
          <span className="font-medium tabular-nums text-foreground">{formatPaise(view.totalPaise)}</span>
          {/* 5% at or under ₹7,500 a night, 18% above it — both collected (client, 17 Aug
              2026). The GST column in the table below says which room took which. */}
          {view.roomsTaxPaise > 0 && (
            <span className="ml-1">(incl. {formatPaise(view.roomsTaxPaise)} GST on rooms)</span>
          )}
          {view.closed && (
            <Badge variant="outline" className="ml-2 text-muted-foreground">
              <Lock className="mr-1 size-3" /> closed
            </Badge>
          )}
        </div>
        {canEdit && hasAnything && <CloseButton eventId={eventId} onDone={load} />}
      </div>

      {view.rooms.length > 0 && (
        <div className="overflow-x-auto rounded-lg border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Extra rooms</TableHead>
                <TableHead className="text-right">Rooms</TableHead>
                <TableHead className="text-right">Nights</TableHead>
                <TableHead className="text-right">Rate / night</TableHead>
                {/* The band, per line — a room over ₹7,500 a night is charged 18% and the
                    rest 5%, and the desk has to be able to see which is which. */}
                <TableHead className="text-right">GST</TableHead>
                <TableHead className="text-right">Amount</TableHead>
                {canEdit && <TableHead />}
              </TableRow>
            </TableHeader>
            <TableBody>
              {view.rooms.map((r) => (
                <TableRow key={r.id}>
                  <TableCell>
                    {r.lodge} — {titleCase(r.roomType.replace(/_/g, ' '))}
                    {r.remarks && <span className="block text-xs text-muted-foreground">{r.remarks}</span>}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">{r.count}</TableCell>
                  <TableCell className="text-right tabular-nums">{r.nights}</TableCell>
                  <TableCell className="text-right tabular-nums">{formatPaise(r.ratePaise)}</TableCell>
                  <TableCell className="text-right tabular-nums text-muted-foreground">
                    {(r.gstRateBp / 100).toFixed(0)}%
                  </TableCell>
                  <TableCell className="text-right font-medium tabular-nums">{formatPaise(r.amountPaise)}</TableCell>
                  {canEdit && (
                    <TableCell className="text-right">
                      <Button
                        size="icon-xs"
                        variant="ghost"
                        onClick={async () => {
                          try {
                            await api(`/additional-rooms/${r.id}`, { method: 'DELETE' })
                            await load()
                          } catch (err) {
                            toast.error(err instanceof Error ? err.message : 'Failed')
                          }
                        }}
                      >
                        <Trash2 className="size-3" />
                      </Button>
                    </TableCell>
                  )}
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}

      {canEdit && <AddRooms eventId={eventId} options={view.options} onAdded={load} />}

      {/* Keyed on the saved figure so a reload remounts the box with it. The server is the
          source of truth for a field two people can edit; without the key, a stale draft in
          the input would sit on top of what was actually saved. */}
      <DiningBox
        key={view.inRoomDiningPaise}
        eventId={eventId}
        amountPaise={view.inRoomDiningPaise}
        editable={canEdit}
        onSaved={load}
      />

      {!canEdit && !view.closed && (
        <p className="text-sm text-muted-foreground">
          Lodge extras can be logged while the event is In Progress or Completed.
        </p>
      )}
    </div>
  )
}

function AddRooms({
  eventId,
  options,
  onAdded,
}: {
  eventId: string
  options: Option[]
  onAdded: () => Promise<void>
}) {
  const [unitId, setUnitId] = useState('')
  const [roomType, setRoomType] = useState('')
  const [count, setCount] = useState('1')
  const [nights, setNights] = useState('1')
  const [remarks, setRemarks] = useState('')
  const [busy, setBusy] = useState(false)

  const lodges = [...new Map(options.map((o) => [o.unitId, o.unitName])).entries()]
  const categories = options.filter((o) => o.unitId === unitId)
  const chosen = categories.find((o) => o.roomType === roomType)
  const c = Number(count)
  const n = Number(nights)
  // What the line will cost, before it is saved — the desk should never press Add to find out.
  const preview = chosen && c > 0 && n > 0 ? chosen.ratePaise * c * n : null

  async function add() {
    if (!unitId || !roomType) {
      toast.error('Pick a lodge and a category')
      return
    }
    if (!Number.isInteger(c) || c < 1 || !Number.isInteger(n) || n < 1) {
      toast.error('Rooms and nights must be whole numbers, at least one each')
      return
    }
    setBusy(true)
    try {
      await api(`/events/${eventId}/lodge-extras/rooms`, {
        method: 'POST',
        body: JSON.stringify({
          unit_id: unitId,
          room_type: roomType,
          count: c,
          nights: n,
          ...(remarks.trim() ? { remarks: remarks.trim() } : {}),
        }),
      })
      setCount('1')
      setNights('1')
      setRemarks('')
      await onAdded()
      toast.success('Extra rooms added')
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not add')
    } finally {
      setBusy(false)
    }
  }

  if (options.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        No lodge has a priced room category yet — the Auditor sets those in the lodge master.
      </p>
    )
  }

  return (
    <div className="rounded-lg border border-dashed p-3">
      <div className="mb-2 flex items-center gap-2 text-sm font-medium">
        <BedDouble className="size-4 text-muted-foreground" aria-hidden /> Add extra rooms
      </div>
      <div className="flex flex-wrap items-end gap-2">
        <div className="grow space-y-1">
          <Label className="text-xs">Lodge</Label>
          <Select
            items={lodges.map(([id, name]) => ({ value: id, label: name }))}
            value={unitId}
            onValueChange={(v) => {
              setUnitId(v ?? '')
              // The rate is per lodge, so a category chosen against the old one is meaningless.
              setRoomType('')
            }}
          >
            <SelectTrigger className="min-w-36">
              <SelectValue placeholder="Lodge" />
            </SelectTrigger>
            <SelectContent>
              {lodges.map(([id, name]) => (
                <SelectItem key={id} value={id}>
                  {name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="grow space-y-1">
          <Label className="text-xs">Category</Label>
          <Select
            items={categories.map((o) => ({
              value: o.roomType,
              label: `${titleCase(o.roomType.replace(/_/g, ' '))} — ${formatPaise(o.ratePaise)}/night`,
            }))}
            value={roomType}
            onValueChange={(v) => setRoomType(v ?? '')}
            disabled={!unitId}
          >
            <SelectTrigger className="min-w-48">
              <SelectValue placeholder="Category" />
            </SelectTrigger>
            <SelectContent>
              {categories.map((o) => (
                <SelectItem key={o.roomType} value={o.roomType}>
                  {titleCase(o.roomType.replace(/_/g, ' '))} — {formatPaise(o.ratePaise)}/night
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="w-24 space-y-1">
          <Label className="text-xs" htmlFor="lx-count">
            How many
          </Label>
          <Input id="lx-count" inputMode="numeric" value={count} onChange={(e) => setCount(e.target.value)} />
        </div>
        <div className="w-24 space-y-1">
          <Label className="text-xs" htmlFor="lx-nights">
            Nights
          </Label>
          <Input id="lx-nights" inputMode="numeric" value={nights} onChange={(e) => setNights(e.target.value)} />
        </div>
        <div className="grow space-y-1">
          <Label className="text-xs" htmlFor="lx-remarks">
            Remark
          </Label>
          <Input
            id="lx-remarks"
            placeholder="extra baraatis"
            value={remarks}
            onChange={(e) => setRemarks(e.target.value)}
          />
        </div>
        <Button onClick={add} disabled={busy}>
          {busy ? <Loader2 className="size-4 animate-spin" /> : <Plus className="size-4" />} Add
        </Button>
      </div>
      {preview !== null && (
        <p className="mt-2 text-xs text-muted-foreground tabular-nums">
          {c} × {n} night{n === 1 ? '' : 's'} × {formatPaise(chosen!.ratePaise)} ={' '}
          <span className="font-medium text-foreground">{formatPaise(preview)}</span> + 5% GST
        </p>
      )}
    </div>
  )
}

/**
 * One box for the whole stay (client's choice, 15 Aug 2026) — the kitchen's dockets are the
 * itemisation. Saving replaces the figure; the audit trail keeps what it was.
 */
function DiningBox({
  eventId,
  amountPaise,
  editable,
  onSaved,
}: {
  eventId: string
  amountPaise: number
  editable: boolean
  onSaved: () => Promise<void>
}) {
  const [rupees, setRupees] = useState(String(amountPaise / 100))
  const [busy, setBusy] = useState(false)

  if (!editable) {
    return (
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <UtensilsCrossed className="size-4" aria-hidden /> In-room dining:{' '}
        <span className="font-medium tabular-nums text-foreground">{formatPaise(amountPaise)}</span>
      </div>
    )
  }

  async function save() {
    const r = Number(rupees)
    if (!Number.isFinite(r) || r < 0) {
      toast.error('Enter an amount in rupees')
      return
    }
    setBusy(true)
    try {
      await api(`/events/${eventId}/lodge-extras/dining`, {
        method: 'PUT',
        body: JSON.stringify({ amount_paise: rupeesToPaise(r) }),
      })
      await onSaved()
      toast.success('In-room dining saved')
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not save')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="rounded-lg border border-dashed p-3">
      <div className="mb-2 flex items-center gap-2 text-sm font-medium">
        <UtensilsCrossed className="size-4 text-muted-foreground" aria-hidden /> In-room dining
      </div>
      <div className="flex flex-wrap items-end gap-2">
        <div className="w-40 space-y-1">
          <Label className="text-xs" htmlFor="lx-dining">
            Total ₹
          </Label>
          <Input id="lx-dining" inputMode="decimal" value={rupees} onChange={(e) => setRupees(e.target.value)} />
        </div>
        <Button variant="outline" onClick={save} disabled={busy}>
          {busy ? <Loader2 className="size-4 animate-spin" /> : null} Save
        </Button>
        <p className="text-xs text-muted-foreground">
          One total for the whole stay. It replaces the last figure rather than adding to it.
        </p>
      </div>
    </div>
  )
}

function CloseButton({ eventId, onDone }: { eventId: string; onDone: () => Promise<void> }) {
  const [busy, setBusy] = useState(false)
  return (
    <Button
      variant="outline"
      size="sm"
      disabled={busy}
      onClick={async () => {
        setBusy(true)
        try {
          await api(`/events/${eventId}/lodge-extras/close`, { method: 'POST' })
          await onDone()
          toast.success('Lodge extras closed')
        } catch (e) {
          toast.error(e instanceof Error ? e.message : 'Failed')
        } finally {
          setBusy(false)
        }
      }}
    >
      <Lock className="size-3.5" /> Close lodge extras
    </Button>
  )
}
