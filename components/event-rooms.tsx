'use client'

import { useCallback, useEffect, useState } from 'react'
import { Loader2, Plus, Trash2 } from 'lucide-react'
import { toast } from 'sonner'
import { api } from '@/lib/http'
import { formatPaise } from '@/lib/money'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'

/**
 * Rooms on a booking. Bulk only: lodge + category + how many + which dates. That IS the
 * booking (client, 21 Jul 2026) — which actual room a guest gets is the reception desk's
 * call and is deliberately not recorded here.
 *
 * This replaces the room-by-room allocation panel, which picked specific room numbers and
 * no longer had anything to write to. Rooms stay editable until the event locks, because a
 * guest's lodging keeps changing after the booking is confirmed.
 */

type Unit = { id: string; name: string }
type RoomRate = { unitId: string; roomType: string; rackRatePaise: number }
type Requirement = {
  unit_id: string
  room_type: string
  count: number
  check_in: string
  check_out: string
}

const label = (t: string) => t.replace(/_/g, ' ')
const keyOf = (r: { unit_id: string; room_type: string; check_in: string; check_out: string; count: number }) =>
  `${r.unit_id}|${r.room_type}|${r.check_in}|${r.check_out}|${r.count}`

/** `date` shifted by whole days, staying in YYYY-MM-DD. UTC so a timezone cannot shift it. */
function addDays(date: string, n: number): string {
  const d = new Date(`${date}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + n)
  return d.toISOString().slice(0, 10)
}

function nights(checkIn: string, checkOut: string): number {
  if (!checkIn || !checkOut) return 0
  const [ay, am, ad] = checkIn.split('-').map(Number)
  const [by, bm, bd] = checkOut.split('-').map(Number)
  const d = Math.round((Date.UTC(by, bm - 1, bd) - Date.UTC(ay, am - 1, ad)) / 86_400_000)
  return d > 0 ? d : 0
}

export function EventRooms({ eventId, editable }: { eventId: string; editable: boolean }) {
  const [rows, setRows] = useState<Requirement[] | null>(null)
  const [units, setUnits] = useState<Unit[]>([])
  // Only `roomRates` is kept: it carries which categories each lodge actually holds, and the
  // flat `roomTypes` list it replaces let a manager book a category the lodge has never had.
  const [rates, setRates] = useState<RoomRate[]>([])
  const [busy, setBusy] = useState(false)
  // The span rooms may be held for, and what each lodge has free over the chosen nights.
  // Both mirror what the save enforces, so a manager is stopped at the input instead of
  // discovering it in an error toast.
  const [win, setWin] = useState<{ firstDate: string | null; lastDate: string | null; latestCheckOut: string | null }>({
    firstDate: null, lastDate: null, latestCheckOut: null,
  })
  // Keyed by ROW INDEX: two lines can share a shape (same lodge, category, dates) yet each
  // holds real rooms, so a shared string key would collide and hide one.
  const [free, setFree] = useState<Record<number, { available: number; total: number }>>({})

  const load = useCallback(async () => {
    const [reqs, opts] = await Promise.all([
      api<{ requirements: Requirement[]; window: typeof win }>(`/events/${eventId}/room-requirements`),
      api<{ lodgingUnits?: Unit[]; roomRates: RoomRate[] }>('/booking-options'),
    ])
    setRows(reqs.requirements)
    setWin(reqs.window)
    setUnits(opts.lodgingUnits ?? [])
    setRates(opts.roomRates ?? [])
  }, [eventId])

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    load().catch((e) => toast.error(e instanceof Error ? e.message : 'Failed to load rooms'))
  }, [load])

  const complete = (rows ?? []).map((r, i) => ({ r, i })).filter(({ r }) => r.unit_id && r.room_type && r.check_in && r.check_out)
  const signature = complete.map(({ r }) => keyOf(r)).join(',')
  useEffect(() => {
    if (!complete.length) return
    const t = setTimeout(() => {
      api<{ lines: { available: number; total: number }[] }>('/rooms/availability', {
        method: 'POST',
        body: JSON.stringify({
          event_id: eventId,
          // Counts ride along so sibling lines of the same category compete (client, 22 Jul 2026).
          lines: complete.map(({ r }) => ({
            unit_id: r.unit_id, room_type: r.room_type,
            count: Number.isInteger(r.count) && r.count > 0 ? r.count : 0,
            check_in: r.check_in, check_out: r.check_out,
          })),
        }),
      })
        .then((res) => {
          const next: Record<number, { available: number; total: number }> = {}
          complete.forEach(({ i }, k) => {
            const l = res.lines[k]
            if (l) next[i] = { available: l.available, total: l.total }
          })
          setFree(next)
        })
        // A failed lookup must not block the form — the save still enforces the cap.
        .catch(() => setFree({}))
    }, 400)
    return () => clearTimeout(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signature, eventId])

  if (!rows) {
    return (
      <div className="flex items-center gap-2 p-2 text-sm text-muted-foreground">
        <Loader2 className="size-4 animate-spin" /> Loading rooms…
      </div>
    )
  }

  /** Does this line ask for more than the lodge has free over its nights? Keyed by row index. */
  const overOn = (i: number, r: Requirement) => {
    const a = free[i]
    return a != null && r.count > a.available
  }

  const rateOf = (r: Requirement) =>
    rates.find((x) => x.unitId === r.unit_id && x.roomType === r.room_type)?.rackRatePaise ?? 0
  const lineOf = (r: Requirement) => rateOf(r) * Math.max(0, r.count) * nights(r.check_in, r.check_out)
  const roomsTotal = rows.reduce((n, r) => n + lineOf(r), 0)
  const totalRooms = rows.reduce((n, r) => n + Math.max(0, r.count), 0)

  const update = (i: number, patch: Partial<Requirement>) =>
    setRows(rows.map((r, j) => (j === i ? { ...r, ...patch } : r)))

  /** The categories this lodge actually holds — Residency has no dormitory, Palace no semi-deluxe. */
  const typesFor = (unitId: string) =>
    [...new Set(rates.filter((x) => x.unitId === unitId).map((x) => x.roomType))].sort()

  /** Changing lodge re-points the category, since the old one may not exist at the new lodge. */
  const changeUnit = (i: number, unitId: string) => {
    const types = typesFor(unitId)
    const cur = rows[i]!.room_type
    update(i, { unit_id: unitId, room_type: types.includes(cur) ? cur : (types[0] ?? '') })
  }

  const add = () => {
    const unitId = units[0]?.id ?? ''
    setRows([
      ...rows,
      { unit_id: unitId, room_type: typesFor(unitId)[0] ?? '', count: 1, check_in: '', check_out: '' },
    ])
  }
  const remove = (i: number) => setRows(rows.filter((_, j) => j !== i))

  async function save() {
    for (const r of rows!) {
      if (!r.unit_id || !r.room_type) return toast.error('Every line needs a lodge and a category')
      if (nights(r.check_in, r.check_out) === 0) {
        return toast.error('Check-out must be after check-in on every line')
      }
    }
    setBusy(true)
    try {
      const res = await api<{ totalRooms: number; deferred: boolean }>(
        `/events/${eventId}/room-requirements`,
        { method: 'POST', body: JSON.stringify({ requirements: rows }) },
      )
      toast[res.deferred ? 'info' : 'success'](
        res.deferred
          ? `${res.totalRooms} rooms — sent to the GM for approval (35 or more).`
          : 'Rooms saved',
      )
      await load()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not save rooms')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="space-y-4">
      {rows.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          No rooms on this booking. Add a line if the guest needs lodging.
        </p>
      ) : (
        <div className="overflow-x-auto rounded-lg border">
          <table className="w-full min-w-[720px] text-sm">
            <thead>
              <tr className="border-b text-left text-[10px] uppercase tracking-[0.12em] text-muted-foreground">
                <th className="px-3 py-2.5 font-semibold">Lodge</th>
                <th className="px-3 py-2.5 font-semibold">Category</th>
                <th className="px-3 py-2.5 font-semibold">Rooms</th>
                <th className="px-3 py-2.5 font-semibold">Check-in</th>
                <th className="px-3 py-2.5 font-semibold">Check-out</th>
                <th className="px-3 py-2.5 text-right font-semibold">Estimate</th>
                <th className="px-3 py-2.5" />
              </tr>
            </thead>
            <tbody className="divide-y">
              {rows.map((r, i) => (
                <tr key={i}>
                  <td className="px-3 py-2">
                    <Select
                      items={units.map((u) => ({ value: u.id, label: u.name }))}
                      value={r.unit_id}
                      onValueChange={(v) => changeUnit(i, v ?? '')}
                      disabled={!editable}
                    >
                      <SelectTrigger className="min-w-32"><SelectValue placeholder="Lodge" /></SelectTrigger>
                      <SelectContent>
                        {units.map((u) => <SelectItem key={u.id} value={u.id}>{u.name}</SelectItem>)}
                      </SelectContent>
                    </Select>
                  </td>
                  <td className="px-3 py-2">
                    {/* Only this lodge's categories — see typesFor. */}
                    <Select
                      items={typesFor(r.unit_id).map((t) => ({ value: t, label: label(t) }))}
                      value={r.room_type}
                      onValueChange={(v) => update(i, { room_type: v ?? '' })}
                      disabled={!editable}
                    >
                      <SelectTrigger className="min-w-36 capitalize"><SelectValue /></SelectTrigger>
                      <SelectContent>
                        {typesFor(r.unit_id).map((t) => (
                          <SelectItem key={t} value={t} className="capitalize">{label(t)}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </td>
                  <td className="px-3 py-2">
                    <Input
                      type="number"
                      min={1}
                      max={free[i]?.available || undefined}
                      className={cn('w-20', overOn(i, r) && 'border-destructive')}
                      value={r.count}
                      disabled={!editable}
                      aria-invalid={overOn(i, r) || undefined}
                      onChange={(e) => update(i, { count: Number(e.target.value) })}
                    />
                  </td>
                  <td className="px-3 py-2">
                    {/* Bounded by the event: check-in cannot precede the first function. */}
                    <Input
                      type="date"
                      min={win.firstDate ?? undefined}
                      max={win.lastDate ?? undefined}
                      value={r.check_in}
                      disabled={!editable}
                      onChange={(e) => update(i, { check_in: e.target.value })}
                    />
                  </td>
                  <td className="px-3 py-2">
                    {/* Check-out reaches at most the morning after the last function. */}
                    <Input
                      type="date"
                      min={r.check_in ? addDays(r.check_in, 1) : win.firstDate ?? undefined}
                      max={win.latestCheckOut ?? undefined}
                      value={r.check_out}
                      disabled={!editable}
                      onChange={(e) => update(i, { check_out: e.target.value })}
                    />
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums">
                    {nights(r.check_in, r.check_out) > 0 ? formatPaise(lineOf(r)) : '—'}
                  </td>
                  <td className="px-3 py-2">
                    {editable && (
                      <Button variant="ghost" size="icon" onClick={() => remove(i)} aria-label="Remove line">
                        <Trash2 className="size-4" />
                      </Button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {rows.length > 0 && (
        <div className="ml-auto max-w-xs space-y-1 text-sm">
          <div className="flex justify-between">
            <span className="text-muted-foreground">{totalRooms} room(s), rack-rate estimate</span>
            <span className="tabular-nums">{formatPaise(roomsTotal)}</span>
          </div>
          {totalRooms >= 35 && (
            <p className="text-xs text-amber-600">
              35 or more rooms — saving sends this to the Higher Authority (BR-L2).
            </p>
          )}
        </div>
      )}

      {editable && (
        <div className="flex flex-wrap items-center gap-2">
          <Button variant="outline" size="sm" onClick={add}>
            <Plus className="size-4" /> Add rooms
          </Button>
          <Button size="sm" onClick={save} disabled={busy}>
            {busy ? 'Saving…' : 'Save rooms'}
          </Button>
          <p className="text-xs text-muted-foreground">
            Room numbers are assigned at reception — this records the lodge, category and dates only.
          </p>
        </div>
      )}
    </div>
  )
}
