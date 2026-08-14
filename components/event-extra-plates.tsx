'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { Camera, ImageIcon, Loader2, Lock, Plus, Trash2, UtensilsCrossed } from 'lucide-react'
import { toast } from 'sonner'
import { api } from '@/lib/http'
import { formatPaise } from '@/lib/money'
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

type PlateLine = {
  id: string
  subEventId: string
  functionName: string
  eventDate: string
  plates: number
  ratePaise: number
  amountPaise: number
  remarks: string | null
  createdBy: string
}
type FunctionOption = {
  subEventId: string
  name: string
  eventDate: string
  tierName: string | null
  ratePaise: number | null
}
type View = { closed: boolean; entries: PlateLine[]; totalPaise: number; functions: FunctionOption[] }

/**
 * Extra plates (client, 15 Aug 2026) — the Utensil Manager's panel.
 *
 * Every row links to its photograph, because that is what the Auditor and the Higher Authority
 * are here to look at. The rate is the function's own per-plate price and is never typed.
 */
export function EventExtraPlates({ eventId, editable }: { eventId: string; editable: boolean }) {
  const [view, setView] = useState<View | null>(null)
  const load = useCallback(async () => setView(await api<View>(`/events/${eventId}/extra-plates`)), [eventId])
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    load().catch((e) => toast.error(e instanceof Error ? e.message : 'Failed to load extra plates'))
  }, [load])

  if (!view) {
    return (
      <div className="flex items-center gap-2 p-2 text-sm text-muted-foreground">
        <Loader2 className="size-4 animate-spin" /> Loading…
      </div>
    )
  }

  const canEdit = editable && !view.closed

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="text-sm text-muted-foreground">
          Extra plates:{' '}
          <span className="font-medium tabular-nums text-foreground">
            {view.entries.reduce((n, e) => n + e.plates, 0)}
          </span>{' '}
          · <span className="font-medium tabular-nums text-foreground">{formatPaise(view.totalPaise)}</span>
          {view.closed && (
            <Badge variant="outline" className="ml-2 text-muted-foreground">
              <Lock className="mr-1 size-3" /> closed
            </Badge>
          )}
        </div>
        {canEdit && view.entries.length > 0 && <CloseButton eventId={eventId} onDone={load} />}
      </div>

      {view.entries.length > 0 && (
        <div className="overflow-x-auto rounded-lg border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Function</TableHead>
                <TableHead className="text-right">Plates</TableHead>
                <TableHead className="text-right">Rate / plate</TableHead>
                <TableHead className="text-right">Amount</TableHead>
                <TableHead>Photo</TableHead>
                {canEdit && <TableHead />}
              </TableRow>
            </TableHeader>
            <TableBody>
              {view.entries.map((e) => (
                <TableRow key={e.id}>
                  <TableCell>
                    {e.functionName}
                    <span className="block text-xs text-muted-foreground">
                      {e.eventDate} · logged by {e.createdBy}
                      {e.remarks ? ` · ${e.remarks}` : ''}
                    </span>
                  </TableCell>
                  <TableCell className="text-right tabular-nums">{e.plates}</TableCell>
                  <TableCell className="text-right tabular-nums">{formatPaise(e.ratePaise)}</TableCell>
                  <TableCell className="text-right font-medium tabular-nums">{formatPaise(e.amountPaise)}</TableCell>
                  <TableCell>
                    {/* Always present — the column cannot be empty, because an entry without a
                        photo cannot be saved. */}
                    <a
                      href={`/api/v1/extra-plates/${e.id}/photo`}
                      target="_blank"
                      rel="noreferrer"
                      className="inline-flex items-center gap-1 text-primary hover:underline"
                    >
                      <ImageIcon className="size-3" /> view
                    </a>
                  </TableCell>
                  {canEdit && (
                    <TableCell className="text-right">
                      <Button
                        size="icon-xs"
                        variant="ghost"
                        onClick={async () => {
                          try {
                            await api(`/extra-plates/${e.id}`, { method: 'DELETE' })
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

      {canEdit ? (
        <AddPlates eventId={eventId} functions={view.functions} onAdded={load} />
      ) : (
        !view.closed && (
          <p className="text-sm text-muted-foreground">
            Extra plates can be logged while the event is In Progress or Completed.
          </p>
        )
      )}
    </div>
  )
}

function AddPlates({
  eventId,
  functions,
  onAdded,
}: {
  eventId: string
  functions: FunctionOption[]
  onAdded: () => Promise<void>
}) {
  const [subEventId, setSubEventId] = useState('')
  const [plates, setPlates] = useState('')
  const [remarks, setRemarks] = useState('')
  const [photo, setPhoto] = useState<File | null>(null)
  const [busy, setBusy] = useState(false)
  // Two inputs, not one: `capture` opens the camera straight away on a phone, which is what
  // the client asked for, and a plain picker is the fallback for a photo already taken.
  const cameraRef = useRef<HTMLInputElement>(null)
  const galleryRef = useRef<HTMLInputElement>(null)

  // Only functions with a saved menu can be charged — the rest have no per-plate price.
  const priced = functions.filter((f) => f.ratePaise !== null)
  const chosen = priced.find((f) => f.subEventId === subEventId)
  const n = Number(plates)
  const preview = chosen && Number.isInteger(n) && n > 0 ? chosen.ratePaise! * n : null

  async function add() {
    if (!subEventId) {
      toast.error('Pick the function the plates went to')
      return
    }
    if (!Number.isInteger(n) || n < 1) {
      toast.error('Enter how many plates, as a whole number')
      return
    }
    if (!photo) {
      toast.error('A photo of the plates is required')
      return
    }
    setBusy(true)
    try {
      const fd = new FormData()
      fd.set('sub_event_id', subEventId)
      fd.set('plates', String(n))
      if (remarks.trim()) fd.set('remarks', remarks.trim())
      fd.set('photo', photo)
      const res = await fetch(`/api/v1/events/${eventId}/extra-plates`, { method: 'POST', body: fd })
      if (!res.ok) throw new Error((await res.json().catch(() => ({})))?.error?.message ?? 'Failed')
      setPlates('')
      setRemarks('')
      setPhoto(null)
      if (cameraRef.current) cameraRef.current.value = ''
      if (galleryRef.current) galleryRef.current.value = ''
      await onAdded()
      toast.success('Extra plates logged')
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not log')
    } finally {
      setBusy(false)
    }
  }

  if (functions.length === 0) {
    return <p className="text-sm text-muted-foreground">This booking has no functions to charge plates against.</p>
  }
  if (priced.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        No function on this booking has a saved menu yet, so a plate has no price. The Booking
        Manager saves the menu first.
      </p>
    )
  }

  return (
    <div className="rounded-lg border border-dashed p-3">
      <div className="mb-2 flex items-center gap-2 text-sm font-medium">
        <UtensilsCrossed className="size-4 text-muted-foreground" aria-hidden /> Log extra plates
      </div>
      <div className="flex flex-wrap items-end gap-2">
        <div className="grow space-y-1">
          <Label className="text-xs">Function</Label>
          <Select
            items={priced.map((f) => ({
              value: f.subEventId,
              label: `${f.name} — ${f.tierName ?? 'menu'} ${formatPaise(f.ratePaise!)}`,
            }))}
            value={subEventId}
            onValueChange={(v) => setSubEventId(v ?? '')}
          >
            <SelectTrigger className="min-w-56">
              <SelectValue placeholder="Which function?" />
            </SelectTrigger>
            <SelectContent>
              {priced.map((f) => (
                <SelectItem key={f.subEventId} value={f.subEventId}>
                  {f.name} — {f.tierName ?? 'menu'} {formatPaise(f.ratePaise!)}/plate
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="w-28 space-y-1">
          <Label className="text-xs" htmlFor="xp-plates">
            Plates
          </Label>
          <Input id="xp-plates" inputMode="numeric" placeholder="100" value={plates} onChange={(e) => setPlates(e.target.value)} />
        </div>
        <div className="grow space-y-1">
          <Label className="text-xs" htmlFor="xp-remarks">
            Remark
          </Label>
          <Input
            id="xp-remarks"
            placeholder="guests over the catered count"
            value={remarks}
            onChange={(e) => setRemarks(e.target.value)}
          />
        </div>
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-2">
        {/* `capture="environment"` asks a phone for the rear camera directly. On a desktop
            browser it degrades to an ordinary file picker, which is why the gallery button
            exists beside it rather than instead of it. */}
        <input
          ref={cameraRef}
          type="file"
          accept="image/*"
          capture="environment"
          className="hidden"
          onChange={(e) => setPhoto(e.target.files?.[0] ?? null)}
        />
        <input
          ref={galleryRef}
          type="file"
          accept="image/*"
          className="hidden"
          onChange={(e) => setPhoto(e.target.files?.[0] ?? null)}
        />
        <Button type="button" variant="outline" size="sm" onClick={() => cameraRef.current?.click()}>
          <Camera className="size-4" /> Camera
        </Button>
        <Button type="button" variant="outline" size="sm" onClick={() => galleryRef.current?.click()}>
          <ImageIcon className="size-4" /> Gallery
        </Button>
        <span className={photo ? 'text-xs text-emerald-600' : 'text-xs text-muted-foreground'}>
          {photo ? `${photo.name} ready` : 'A photo of the plates is required'}
        </span>
        <Button className="ml-auto" onClick={add} disabled={busy}>
          {busy ? <Loader2 className="size-4 animate-spin" /> : <Plus className="size-4" />} Add
        </Button>
      </div>

      {preview !== null && (
        <p className="mt-2 text-xs text-muted-foreground tabular-nums">
          {n} × {formatPaise(chosen!.ratePaise!)} ={' '}
          <span className="font-medium text-foreground">{formatPaise(preview)}</span>
        </p>
      )}
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
          await api(`/events/${eventId}/extra-plates/close`, { method: 'POST' })
          await onDone()
          toast.success('Extra plates closed')
        } catch (e) {
          toast.error(e instanceof Error ? e.message : 'Failed')
        } finally {
          setBusy(false)
        }
      }}
    >
      <Lock className="size-3.5" /> Close extra plates
    </Button>
  )
}
