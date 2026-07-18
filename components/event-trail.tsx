'use client'

import { useCallback, useEffect, useState } from 'react'
import { Download, Loader2 } from 'lucide-react'
import { toast } from 'sonner'
import { api } from '@/lib/http'
import { Badge } from '@/components/ui/badge'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'

type TrailRow = { seq: number; at: string; action: string; entity: string; field: string | null; oldValue: string | null; newValue: string | null; userName: string; roleName: string }

const ACTION_STYLE: Record<string, string> = {
  insert: 'text-emerald-600', update: 'text-blue-600', delete: 'text-red-600',
  status: 'text-purple-600', approval: 'text-amber-600', lock: 'text-slate-600',
}

export function EventTrail({ eventId }: { eventId: string }) {
  const [rows, setRows] = useState<TrailRow[] | null>(null)
  const [entities, setEntities] = useState<string[]>([])
  const [entity, setEntity] = useState('')

  const load = useCallback(async () => {
    const r = await api<{ trail: TrailRow[]; entities: string[] }>(`/events/${eventId}/trail${entity ? `?entity=${entity}` : ''}`)
    setRows(r.trail)
    if (r.entities.length) setEntities(r.entities)
  }, [eventId, entity])

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    load().catch((e) => toast.error(e instanceof Error ? e.message : 'Failed to load trail'))
  }, [load])

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="w-52">
          <Select value={entity} onValueChange={(v) => setEntity(v === '__all' ? '' : (v ?? ''))} items={[{ value: '__all', label: 'All entities' }, ...entities.map((e) => ({ value: e, label: e }))]}>
            <SelectTrigger><SelectValue placeholder="All entities" /></SelectTrigger>
            <SelectContent>
              <SelectItem value="__all">All entities</SelectItem>
              {entities.map((e) => (<SelectItem key={e} value={e}>{e}</SelectItem>))}
            </SelectContent>
          </Select>
        </div>
        <a href={`/api/v1/events/${eventId}/trail?export=csv${entity ? `&entity=${entity}` : ''}`} className="inline-flex items-center gap-1 text-sm text-primary hover:underline">
          <Download className="size-3.5" /> Export CSV
        </a>
      </div>

      {!rows ? (
        <div className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="size-4 animate-spin" /> Loading…</div>
      ) : rows.length === 0 ? (
        <p className="text-sm text-muted-foreground">No trail entries.</p>
      ) : (
        <ol className="space-y-1.5">
          {rows.map((r) => (
            <li key={r.seq} className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 border-l-2 pl-3 text-sm" style={{ borderColor: 'var(--border)' }}>
              <span className="text-xs tabular-nums text-muted-foreground">{new Date(r.at).toLocaleString()}</span>
              <Badge variant="outline" className={ACTION_STYLE[r.action] ?? ''}>{r.action}</Badge>
              <span className="text-muted-foreground">{r.entity}{r.field ? `.${r.field}` : ''}</span>
              {(r.oldValue || r.newValue) && (
                <span className="tabular-nums">
                  {r.oldValue != null && <span className="text-red-600 line-through">{r.oldValue}</span>}
                  {r.oldValue != null && r.newValue != null && ' → '}
                  {r.newValue != null && <span className="text-emerald-600">{r.newValue}</span>}
                </span>
              )}
              <span className="text-xs text-muted-foreground">— {r.userName} ({r.roleName.replace(/_/g, ' ')})</span>
            </li>
          ))}
        </ol>
      )}
    </div>
  )
}
