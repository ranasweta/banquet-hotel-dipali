'use client'

import { useCallback, useEffect, useState } from 'react'
import { Loader2, Printer, Users } from 'lucide-react'
import { toast } from 'sonner'
import { api } from '@/lib/http'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Badge } from '@/components/ui/badge'

type Fn = {
  subEventId: string
  eventCode: string
  guestName: string
  eventType: string
  name: string
  startTime: string
  endTime: string
  pax: number
  paxOverrideNote: string | null
  venueName: string | null
  menu: { tierName: string; perPlatePaise: number; complete: boolean; categories: { name: string; items: string[] }[] } | null
  addons: { description: string; qty: number; ratePaise: number }[]
}

export function DaySheetView({ initialDate }: { initialDate: string }) {
  const [date, setDate] = useState(initialDate)
  const [functions, setFunctions] = useState<Fn[] | null>(null)
  const [busy, setBusy] = useState(false)

  const load = useCallback(async (d: string) => {
    setBusy(true)
    try {
      const r = await api<{ functions: Fn[] }>(`/calendar/day-sheet/${d}`)
      setFunctions(r.functions)
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed to load day sheet')
    } finally {
      setBusy(false)
    }
  }, [])

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    load(date)
  }, [date, load])

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-end justify-between gap-3 print:hidden">
        <div className="space-y-1.5">
          <label className="text-xs font-medium text-muted-foreground">Date</label>
          <Input type="date" value={date} onChange={(e) => setDate(e.target.value)} className="w-44" />
        </div>
        <div className="flex items-center gap-2">
          {busy && <Loader2 className="size-4 animate-spin text-muted-foreground" />}
          <Button variant="outline" onClick={() => window.print()}>
            <Printer className="size-4" /> Print
          </Button>
        </div>
      </div>

      <div className="hidden print:block">
        <h1 className="text-xl font-semibold">Day sheet — {date}</h1>
      </div>

      {!functions ? null : functions.length === 0 ? (
        <p className="text-sm text-muted-foreground">No functions scheduled for {date}.</p>
      ) : (
        <div className="space-y-4">
          {functions.map((f) => (
            <div key={f.subEventId} className="rounded-lg border p-4">
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <div>
                  <span className="text-lg font-semibold">{f.name}</span>
                  <span className="ml-2 text-sm text-muted-foreground tabular-nums">
                    {f.startTime.slice(0, 5)}–{f.endTime.slice(0, 5)} · {f.venueName ?? '—'}
                  </span>
                </div>
                <div className="text-sm text-muted-foreground tabular-nums">
                  <span className="font-medium text-foreground">{f.eventCode}</span> · {f.guestName} · <span className="capitalize">{f.eventType.replace(/_/g, ' ')}</span>
                </div>
              </div>

              <div className="mt-1 flex items-center gap-2 text-sm">
                <Users className="size-3.5 text-muted-foreground" />
                <span className="tabular-nums">{f.pax} pax</span>
                {f.paxOverrideNote && <Badge variant="outline" className="text-amber-600">{f.paxOverrideNote}</Badge>}
              </div>

              {f.menu ? (
                <div className="mt-3">
                  <div className="mb-1 flex items-center gap-2 text-sm font-medium">
                    Menu: {f.menu.tierName}
                    {!f.menu.complete && <Badge variant="outline" className="text-amber-600">incomplete</Badge>}
                  </div>
                  <div className="grid gap-x-6 gap-y-1 sm:grid-cols-2">
                    {f.menu.categories.map((c) => (
                      <div key={c.name} className="text-sm">
                        <span className="text-muted-foreground">{c.name}:</span> {c.items.join(', ') || '—'}
                      </div>
                    ))}
                  </div>
                </div>
              ) : (
                <div className="mt-3 text-sm text-muted-foreground">No menu selected yet.</div>
              )}

              {f.addons.length > 0 && (
                <div className="mt-2 text-sm">
                  <span className="font-medium">Add-ons:</span> {f.addons.map((a) => `${a.description} × ${a.qty}`).join(', ')}
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
