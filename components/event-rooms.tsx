'use client'

import { useCallback, useEffect, useState } from 'react'
import { Loader2, Plus, Trash2 } from 'lucide-react'
import { toast } from 'sonner'
import { api } from '@/lib/http'
import { formatPaise } from '@/lib/money'
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
  const [roomTypes, setRoomTypes] = useState<string[]>([])
  const [rates, setRates] = useState<RoomRate[]>([])
  const [busy, setBusy] = useState(false)

  const load = useCallback(async () => {
    const [reqs, opts] = await Promise.all([
      api<{ requirements: Requirement[] }>(`/events/${eventId}/room-requirements`),
      api<{ lodgingUnits?: Unit[]; roomTypes: string[]; roomRates: RoomRate[] }>('/booking-options'),
    ])
    setRows(reqs.requirements)
    setUnits(opts.lodgingUnits ?? [])
    setRoomTypes(opts.roomTypes)
    setRates(opts.roomRates ?? [])
  }, [eventId])

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    load().catch((e) => toast.error(e instanceof Error ? e.message : 'Failed to load rooms'))
  }, [load])

  if (!rows) {
    return (
      <div className="flex items-center gap-2 p-2 text-sm text-muted-foreground">
        <Loader2 className="size-4 animate-spin" /> Loading rooms…
      </div>
    )
  }

  const rateOf = (r: Requirement) =>
    rates.find((x) => x.unitId === r.unit_id && x.roomType === r.room_type)?.rackRatePaise ?? 0
  const lineOf = (r: Requirement) => rateOf(r) * Math.max(0, r.count) * nights(r.check_in, r.check_out)
  const roomsTotal = rows.reduce((n, r) => n + lineOf(r), 0)
  const totalRooms = rows.reduce((n, r) => n + Math.max(0, r.count), 0)

  const update = (i: number, patch: Partial<Requirement>) =>
    setRows(rows.map((r, j) => (j === i ? { ...r, ...patch } : r)))
  const add = () =>
    setRows([
      ...rows,
      { unit_id: units[0]?.id ?? '', room_type: roomTypes[0] ?? 'deluxe', count: 1, check_in: '', check_out: '' },
    ])
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
                      onValueChange={(v) => update(i, { unit_id: v ?? '' })}
                      disabled={!editable}
                    >
                      <SelectTrigger className="min-w-32"><SelectValue placeholder="Lodge" /></SelectTrigger>
                      <SelectContent>
                        {units.map((u) => <SelectItem key={u.id} value={u.id}>{u.name}</SelectItem>)}
                      </SelectContent>
                    </Select>
                  </td>
                  <td className="px-3 py-2">
                    <Select
                      items={roomTypes.map((t) => ({ value: t, label: label(t) }))}
                      value={r.room_type}
                      onValueChange={(v) => update(i, { room_type: v ?? '' })}
                      disabled={!editable}
                    >
                      <SelectTrigger className="min-w-36 capitalize"><SelectValue /></SelectTrigger>
                      <SelectContent>
                        {roomTypes.map((t) => (
                          <SelectItem key={t} value={t} className="capitalize">{label(t)}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </td>
                  <td className="px-3 py-2">
                    <Input
                      type="number"
                      min={1}
                      className="w-20"
                      value={r.count}
                      disabled={!editable}
                      onChange={(e) => update(i, { count: Number(e.target.value) })}
                    />
                  </td>
                  <td className="px-3 py-2">
                    <Input
                      type="date"
                      value={r.check_in}
                      disabled={!editable}
                      onChange={(e) => update(i, { check_in: e.target.value })}
                    />
                  </td>
                  <td className="px-3 py-2">
                    <Input
                      type="date"
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
