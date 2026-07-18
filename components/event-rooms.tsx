'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { Loader2, Trash2 } from 'lucide-react'
import { toast } from 'sonner'
import { api } from '@/lib/http'
import { formatPaise, rupeesToPaise } from '@/lib/money'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Badge } from '@/components/ui/badge'
import { Checkbox } from '@/components/ui/checkbox'
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

type Unit = { id: string; name: string; roomCount: number }
type BoardRoom = {
  id: string
  roomNo: string
  block: string | null
  roomType: string
  beds: number
  rackRatePaise: number
  allocations: { id: string; code: string; guestName: string; checkIn: string; checkOut: string }[]
}
type Reconciliation = {
  byType: { roomType: string; promised: number; allocated: number; occupied: number; variance: number }[]
  totals: { promised: number; allocated: number; occupied: number; variance: number }
  allocations: {
    id: string; roomNo: string; unitName: string; roomType: string
    checkIn: string; checkOut: string; ratePaise: number; discountPaise: number; overrideNote: string | null
  }[]
}

const label = (t: string) => t.replace(/_/g, ' ')

export function EventRooms({
  eventId,
  editable,
}: {
  eventId: string
  editable: boolean
}) {
  const [rec, setRec] = useState<Reconciliation | null>(null)
  const [units, setUnits] = useState<Unit[]>([])

  const loadRec = useCallback(async () => {
    const r = await api<Reconciliation>(`/events/${eventId}/rooms/reconciliation`)
    setRec(r)
  }, [eventId])

  const loadAll = useCallback(async () => {
    const [r, u] = await Promise.all([
      api<Reconciliation>(`/events/${eventId}/rooms/reconciliation`),
      api<{ units: Unit[] }>('/rooms/units'),
    ])
    setRec(r)
    setUnits(u.units)
  }, [eventId])

  useEffect(() => {
    // Async fetch seeds state after the await; the rule can't see past the promise.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    loadAll().catch((e) => toast.error(e instanceof Error ? e.message : 'Failed to load rooms'))
  }, [loadAll])

  if (!rec) {
    return (
      <div className="flex items-center gap-2 p-2 text-sm text-muted-foreground">
        <Loader2 className="size-4 animate-spin" /> Loading rooms…
      </div>
    )
  }

  return (
    <div className="space-y-6">
      {/* Reconciliation (FR-4.5) */}
      <div>
        <h3 className="mb-2 text-sm font-medium">Reconciliation — promised vs allocated</h3>
        {rec.byType.length === 0 ? (
          <p className="text-sm text-muted-foreground">No room requirements or allocations yet.</p>
        ) : (
          <div className="overflow-x-auto rounded-lg border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Room type</TableHead>
                  <TableHead className="text-right">Promised</TableHead>
                  <TableHead className="text-right">Allocated</TableHead>
                  <TableHead className="text-right">Occupied</TableHead>
                  <TableHead className="text-right">Variance</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rec.byType.map((r) => (
                  <TableRow key={r.roomType}>
                    <TableCell className="capitalize">{label(r.roomType)}</TableCell>
                    <TableCell className="text-right tabular-nums">{r.promised}</TableCell>
                    <TableCell className="text-right tabular-nums">{r.allocated}</TableCell>
                    <TableCell className="text-right tabular-nums">{r.occupied}</TableCell>
                    <TableCell className="text-right tabular-nums">
                      {r.variance === 0 ? (
                        <span className="text-emerald-600">0</span>
                      ) : (
                        <span className="text-amber-600">{r.variance > 0 ? `+${r.variance}` : r.variance}</span>
                      )}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
        {rec.totals.variance !== 0 && (
          <p className="mt-1 text-xs text-amber-600">
            Variance outstanding — this blocks the Lodge Manager’s lock sign-off (FR-4.5).
          </p>
        )}
      </div>

      {/* Current allocations */}
      {rec.allocations.length > 0 && (
        <div>
          <h3 className="mb-2 text-sm font-medium">Allocated rooms</h3>
          <div className="overflow-x-auto rounded-lg border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Room</TableHead>
                  <TableHead>Type</TableHead>
                  <TableHead>Stay</TableHead>
                  <TableHead className="text-right">Rate</TableHead>
                  <TableHead className="text-right">Disc.</TableHead>
                  {editable && <TableHead />}
                </TableRow>
              </TableHeader>
              <TableBody>
                {rec.allocations.map((a) => (
                  <TableRow key={a.id}>
                    <TableCell className="font-medium">
                      {a.unitName} {a.roomNo}
                      {a.overrideNote && (
                        <Badge variant="outline" className="ml-2 text-amber-600" title={a.overrideNote}>override</Badge>
                      )}
                    </TableCell>
                    <TableCell className="capitalize">{label(a.roomType)}</TableCell>
                    <TableCell className="tabular-nums text-muted-foreground">{a.checkIn} → {a.checkOut}</TableCell>
                    <TableCell className="text-right tabular-nums">{formatPaise(a.ratePaise)}</TableCell>
                    <TableCell className="text-right tabular-nums">{a.discountPaise ? `−${formatPaise(a.discountPaise)}` : '—'}</TableCell>
                    {editable && (
                      <TableCell className="text-right">
                        <DeleteAllocation id={a.id} onDone={loadRec} />
                      </TableCell>
                    )}
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </div>
      )}

      {editable && <AllocateForm eventId={eventId} units={units} onAllocated={loadRec} />}
    </div>
  )
}

function DeleteAllocation({ id, onDone }: { id: string; onDone: () => Promise<void> }) {
  const [busy, setBusy] = useState(false)
  return (
    <Button
      size="icon-xs"
      variant="ghost"
      disabled={busy}
      onClick={async () => {
        setBusy(true)
        try {
          await api(`/room-allocations/${id}`, { method: 'DELETE' })
          await onDone()
        } catch (e) {
          toast.error(e instanceof Error ? e.message : 'Could not remove')
        } finally {
          setBusy(false)
        }
      }}
    >
      <Trash2 className="size-3" />
    </Button>
  )
}

function AllocateForm({
  eventId,
  units,
  onAllocated,
}: {
  eventId: string
  units: Unit[]
  onAllocated: () => Promise<void>
}) {
  const [unitId, setUnitId] = useState('')
  const [checkIn, setCheckIn] = useState('')
  const [checkOut, setCheckOut] = useState('')
  const [discount, setDiscount] = useState('')
  const [note, setNote] = useState('')
  const [board, setBoard] = useState<BoardRoom[] | null>(null)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [busy, setBusy] = useState(false)

  const canLoad = Boolean(unitId && checkIn && checkOut && checkOut > checkIn)

  async function loadBoard() {
    if (!canLoad) return
    setBusy(true)
    try {
      const b = await api<{ rooms: BoardRoom[] }>(
        `/rooms/board?unit_id=${unitId}&from=${checkIn}&to=${checkOut}`,
      )
      setBoard(b.rooms)
      setSelected(new Set())
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not load rooms')
    } finally {
      setBusy(false)
    }
  }

  function toggle(id: string, on: boolean) {
    setSelected((prev) => {
      const s = new Set(prev)
      if (on) s.add(id)
      else s.delete(id)
      return s
    })
  }

  async function allocate() {
    if (selected.size === 0) return
    setBusy(true)
    try {
      const discountPaise = discount.trim() ? rupeesToPaise(Number(discount)) : undefined
      const res = await api<{ deferred: boolean }>(`/events/${eventId}/room-allocations`, {
        method: 'POST',
        body: JSON.stringify({
          allocations: [...selected].map((room_id) => ({
            room_id,
            check_in: checkIn,
            check_out: checkOut,
            discount_paise: discountPaise,
            override_note: note.trim() || undefined,
          })),
        }),
      })
      if (res.deferred) {
        toast.info('35+ rooms — sent to the GM for approval; nothing is booked until approved.')
      } else {
        toast.success(`${selected.size} room(s) allocated`)
      }
      setBoard(null)
      setSelected(new Set())
      setDiscount('')
      setNote('')
      await onAllocated()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Allocation failed')
    } finally {
      setBusy(false)
    }
  }

  const freeRooms = useMemo(() => board?.filter((r) => r.allocations.length === 0) ?? [], [board])
  const takenCount = (board?.length ?? 0) - freeRooms.length

  return (
    <div className="rounded-lg border border-dashed p-4">
      <h3 className="mb-3 text-sm font-medium">Allocate rooms</h3>
      <div className="flex flex-wrap items-end gap-3">
        <div className="w-48 space-y-1.5">
          <Label className="text-xs">Lodging unit</Label>
          <Select value={unitId} onValueChange={(v) => { if (v) setUnitId(v) }} items={units.map((u) => ({ value: u.id, label: u.name }))}>
            <SelectTrigger><SelectValue placeholder="Choose a unit" /></SelectTrigger>
            <SelectContent>
              {units.map((u) => (
                <SelectItem key={u.id} value={u.id}>{u.name} ({u.roomCount})</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1.5">
          <Label className="text-xs">Check-in</Label>
          <Input type="date" value={checkIn} onChange={(e) => setCheckIn(e.target.value)} className="w-40" />
        </div>
        <div className="space-y-1.5">
          <Label className="text-xs">Check-out</Label>
          <Input type="date" value={checkOut} onChange={(e) => setCheckOut(e.target.value)} className="w-40" />
        </div>
        <Button variant="outline" onClick={loadBoard} disabled={!canLoad || busy}>
          {busy && <Loader2 className="size-4 animate-spin" />} Show free rooms
        </Button>
      </div>

      {board && (
        <div className="mt-4 space-y-3">
          {freeRooms.length === 0 ? (
            <p className="text-sm text-muted-foreground">No free rooms in this unit for these dates.</p>
          ) : (
            <>
              <div className="text-xs text-muted-foreground">
                {freeRooms.length} free{takenCount > 0 ? ` · ${takenCount} already booked (hidden)` : ''}
              </div>
              <div className="grid grid-cols-2 gap-1.5 sm:grid-cols-3 md:grid-cols-4">
                {freeRooms.map((r) => (
                  <label key={r.id} className="flex cursor-pointer items-center gap-2 rounded-md border px-2 py-1.5 text-sm hover:bg-muted/50">
                    <Checkbox checked={selected.has(r.id)} onCheckedChange={(v) => toggle(r.id, Boolean(v))} />
                    <span className="flex-1">
                      <span className="font-medium">{r.roomNo}</span>
                      <span className="block text-xs capitalize text-muted-foreground">{label(r.roomType)} · {formatPaise(r.rackRatePaise)}</span>
                    </span>
                  </label>
                ))}
              </div>
              <div className="flex flex-wrap items-end gap-3">
                <div className="space-y-1.5">
                  <Label className="text-xs">Discount / room (₹, optional)</Label>
                  <Input inputMode="decimal" placeholder="0" value={discount} onChange={(e) => setDiscount(e.target.value)} className="w-36" />
                </div>
                <div className="grow space-y-1.5">
                  <Label className="text-xs">Override note (if not the preferred unit)</Label>
                  <Input placeholder="Reason for a non-preferred unit…" value={note} onChange={(e) => setNote(e.target.value)} />
                </div>
                <Button onClick={allocate} disabled={busy || selected.size === 0}>
                  {busy && <Loader2 className="size-4 animate-spin" />} Allocate {selected.size || ''}
                </Button>
              </div>
              <p className="text-xs text-muted-foreground">
                Caps: ₹500/room, ₹1,000 for suites. 35+ rooms in total need GM approval.
              </p>
            </>
          )}
        </div>
      )}
    </div>
  )
}
