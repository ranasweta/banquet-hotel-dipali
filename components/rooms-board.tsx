'use client'

import { useCallback, useEffect, useState } from 'react'
import { Loader2 } from 'lucide-react'
import { toast } from 'sonner'
import { api } from '@/lib/http'
import { formatPaise } from '@/lib/money'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { cn } from '@/lib/utils'

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

const label = (t: string) => t.replace(/_/g, ' ')

export function RoomsBoard({ initialUnits }: { initialUnits: Unit[] }) {
  const today = '2026-07-18' // seed base date; the user can change the window
  const [unitId, setUnitId] = useState(initialUnits[0]?.id ?? '')
  const [from, setFrom] = useState(today)
  const [to, setTo] = useState('2026-07-25')
  const [rooms, setRooms] = useState<BoardRoom[] | null>(null)
  const [busy, setBusy] = useState(false)

  const load = useCallback(async () => {
    if (!unitId || to <= from) return
    setBusy(true)
    try {
      const b = await api<{ rooms: BoardRoom[] }>(`/rooms/board?unit_id=${unitId}&from=${from}&to=${to}`)
      setRooms(b.rooms)
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed to load board')
    } finally {
      setBusy(false)
    }
  }, [unitId, from, to])

  useEffect(() => {
    // Async fetch seeds state after the await; the rule can't see past the promise.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    load()
  }, [load])

  const free = rooms?.filter((r) => r.allocations.length === 0).length ?? 0

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-end gap-3">
        <div className="w-52 space-y-1.5">
          <Label className="text-xs">Lodging unit</Label>
          <Select value={unitId} onValueChange={(v) => { if (v) setUnitId(v) }} items={initialUnits.map((u) => ({ value: u.id, label: u.name }))}>
            <SelectTrigger><SelectValue placeholder="Choose a unit" /></SelectTrigger>
            <SelectContent>
              {initialUnits.map((u) => (
                <SelectItem key={u.id} value={u.id}>{u.name} ({u.roomCount})</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1.5">
          <Label className="text-xs">From</Label>
          <Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} className="w-40" />
        </div>
        <div className="space-y-1.5">
          <Label className="text-xs">To</Label>
          <Input type="date" value={to} onChange={(e) => setTo(e.target.value)} className="w-40" />
        </div>
        {busy && <Loader2 className="mb-2 size-4 animate-spin text-muted-foreground" />}
      </div>

      {rooms && (
        <>
          <div className="text-sm text-muted-foreground">
            <span className="font-medium text-foreground">{free}</span> free of {rooms.length} rooms in this window
          </div>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5">
            {rooms.map((r) => {
              const taken = r.allocations.length > 0
              return (
                <div
                  key={r.id}
                  className={cn(
                    'rounded-lg border p-2.5 text-sm',
                    taken
                      ? 'border-blue-200 bg-blue-50 dark:border-blue-900 dark:bg-blue-950/40'
                      : 'border-emerald-200 bg-emerald-50 dark:border-emerald-900 dark:bg-emerald-950/30',
                  )}
                >
                  <div className="flex items-center justify-between">
                    <span className="font-medium">{r.roomNo}</span>
                    {r.block && <span className="text-xs text-muted-foreground">blk {r.block}</span>}
                  </div>
                  <div className="text-xs capitalize text-muted-foreground">{label(r.roomType)} · {formatPaise(r.rackRatePaise)}</div>
                  {taken ? (
                    <div className="mt-1 space-y-0.5">
                      {r.allocations.map((a) => (
                        <div key={a.id} className="text-xs text-blue-800 dark:text-blue-200 tabular-nums">
                          {a.code} · {a.checkIn}→{a.checkOut}
                        </div>
                      ))}
                    </div>
                  ) : (
                    <div className="mt-1 text-xs text-emerald-700 dark:text-emerald-300">free</div>
                  )}
                </div>
              )
            })}
          </div>
        </>
      )}
      {!rooms && !busy && <Button variant="outline" onClick={load}>Load board</Button>}
    </div>
  )
}
