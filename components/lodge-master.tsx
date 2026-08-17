'use client'

import { useCallback, useEffect, useState } from 'react'
import { Loader2, Pencil, Plus, Trash2 } from 'lucide-react'
import { toast } from 'sonner'
import { api } from '@/lib/http'
import { formatPaise, rupeesToPaise } from '@/lib/money'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Badge } from '@/components/ui/badge'
import { titleCase } from '@/lib/text'

/**
 * The lodge master (client, 13 Aug 2026) — the venue master's counterpart for rooms.
 *
 * A lodge is a list of CATEGORIES, each with how many rooms of it there are and what one costs
 * a night. That is the shape the hotel thinks in, and the shape that cannot drift: every room
 * of a category already carries the same rate.
 *
 * The screen has to be honest about three things the venue master does not have to say:
 *
 *  - **Re-pricing moves enquiries, not confirmed bookings.** A room's rate is frozen onto the
 *    booking at confirmation (migration 0032), so a guest who has been promised a price keeps
 *    it; an enquiry is still a quote and re-prices with the category.
 *  - **Rooms already promised are a floor.** The count shows how many of a category are
 *    committed on the busiest night, so the Auditor can see WHY a reduction will be refused
 *    before attempting it.
 *  - **The rate and the name decide the guest's GST.** Over ₹7,500 a night is 18% instead of
 *    5% (rule 11), and a dormitory is exempt by its name, so the band is shown per category —
 *    this is the screen where both inputs are typed.
 */

type Category = {
  roomType: string
  rooms: number
  ratePaise: number
  beds: number
  committedPeak: number
  /** 500 or 1800 — computed server-side in lib/tax.ts, never re-derived here. */
  gstRateBp: number
}
type Lodge = { id: string; name: string; categories: Category[] }

export function LodgeMaster({ canEdit, canDelete }: { canEdit: boolean; canDelete: boolean }) {
  const [lodges, setLodges] = useState<Lodge[] | null>(null)
  const [busy, setBusy] = useState(false)
  const [newLodge, setNewLodge] = useState('')
  const [addingTo, setAddingTo] = useState<string | null>(null)

  const load = useCallback(async () => {
    const r = await api<{ lodges: Lodge[] }>('/lodge-master')
    setLodges(r.lodges)
  }, [])

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    load().catch((e: Error) => toast.error(e.message))
  }, [load])

  const run = useCallback(
    async (fn: () => Promise<unknown>, done: string) => {
      setBusy(true)
      try {
        await fn()
        await load()
        toast.success(done)
        return true
      } catch (e) {
        toast.error(e instanceof Error ? e.message : 'That did not work')
        return false
      } finally {
        setBusy(false)
      }
    },
    [load],
  )

  if (!lodges) {
    return (
      <p className="flex items-center gap-2 p-4 text-sm text-muted-foreground">
        <Loader2 className="size-4 animate-spin" aria-hidden /> Loading the lodges…
      </p>
    )
  }

  return (
    <div className="space-y-4">
      <p className="rounded-md border bg-muted/40 p-3 text-sm text-muted-foreground">
        <b className="text-foreground">A new rate applies to enquiries, not to confirmed bookings.</b>{' '}
        A room&rsquo;s rate is frozen onto the booking when it is confirmed, so a guest who has been
        quoted a price keeps it. Enquiries are still quotes and re-price with the category. Editing a
        confirmed booking&rsquo;s rooms re-prices them at today&rsquo;s rate, as a venue change does.
      </p>
      <p className="rounded-md border bg-muted/40 p-3 text-sm text-muted-foreground">
        <b className="text-foreground">The rate sets the guest&rsquo;s GST.</b> Above ₹7,500 a night a
        room is taxed at 18% instead of 5%, and both are collected. A dormitory is exempt whatever it
        costs — its rate buys the room, not a bed — and that is recognised from the word
        &ldquo;dormitory&rdquo; in the category name, so renaming it away from that moves it into 18%.
        Each category shows the band it is in.
      </p>

      {canEdit && (
        <div className="flex flex-wrap items-end gap-2">
          <Input
            placeholder="New lodge name…"
            value={newLodge}
            onChange={(e) => setNewLodge(e.target.value)}
            className="h-9 w-56"
          />
          <Button
            size="sm"
            variant="outline"
            disabled={busy || !newLodge.trim()}
            onClick={async () => {
              const done = await run(
                () => api('/lodge-master/lodges', { method: 'POST', body: JSON.stringify({ name: newLodge.trim() }) }),
                `${newLodge.trim()} added — give it some categories`,
              )
              if (done) setNewLodge('')
            }}
          >
            <Plus className="size-4" /> Add lodge
          </Button>
        </div>
      )}

      {lodges.map((l) => (
        <section key={l.id} className="rounded-lg border bg-card">
          <header className="flex items-center justify-between gap-2 border-b px-4 py-2">
            <span className="font-medium">{l.name}</span>
            <span className="text-xs text-muted-foreground">
              {l.categories.reduce((n, c) => n + c.rooms, 0)} rooms across {l.categories.length} categor
              {l.categories.length === 1 ? 'y' : 'ies'}
            </span>
          </header>

          <ul className="divide-y">
            {l.categories.length === 0 && (
              <li className="px-4 py-3 text-sm text-muted-foreground">No categories yet.</li>
            )}
            {l.categories.map((c) => (
              <CategoryRow
                key={c.roomType}
                unitId={l.id}
                cat={c}
                canEdit={canEdit}
                canDelete={canDelete}
                busy={busy}
                run={run}
              />
            ))}
          </ul>

          {canEdit && (
            <div className="border-t px-4 py-2">
              {addingTo === l.id ? (
                <NewCategoryForm
                  busy={busy}
                  onCancel={() => setAddingTo(null)}
                  onSubmit={async (body) => {
                    const done = await run(
                      () =>
                        api('/lodge-master/categories', {
                          method: 'POST',
                          body: JSON.stringify({ unit_id: l.id, ...body }),
                        }),
                      `${titleCase(body.room_type)} added to ${l.name}`,
                    )
                    if (done) setAddingTo(null)
                  }}
                />
              ) : (
                <Button size="xs" variant="ghost" disabled={busy} onClick={() => setAddingTo(l.id)}>
                  <Plus className="size-3" /> Add a category
                </Button>
              )}
            </div>
          )}
        </section>
      ))}
    </div>
  )
}

function CategoryRow({
  unitId, cat, canEdit, canDelete, busy, run,
}: {
  unitId: string
  cat: Category
  canEdit: boolean
  canDelete: boolean
  busy: boolean
  run: (fn: () => Promise<unknown>, done: string) => Promise<boolean>
}) {
  const [editing, setEditing] = useState(false)
  const [name, setName] = useState(cat.roomType.replace(/_/g, ' '))
  const [rooms, setRooms] = useState(String(cat.rooms))
  const [rate, setRate] = useState(String(cat.ratePaise / 100))
  const label = titleCase(cat.roomType.replace(/_/g, ' '))

  return (
    <li className="flex flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3 text-sm">
      {/* The name is a field while editing, not a fixed label: a category typed wrong had no
          way back short of retiring it and building it again (client, 17 Aug 2026). */}
      {!editing && <span className="w-40 shrink-0 font-medium">{label}</span>}

      {editing ? (
        <>
          <label className="flex items-center gap-1">
            <span className="text-xs text-muted-foreground">Category</span>
            <Input value={name} onChange={(e) => setName(e.target.value)} className="h-7 w-36" />
          </label>
          <label className="flex items-center gap-1">
            <span className="text-xs text-muted-foreground">Rooms</span>
            <Input inputMode="numeric" value={rooms} onChange={(e) => setRooms(e.target.value)} className="h-7 w-20" />
          </label>
          <label className="flex items-center gap-1">
            <span className="text-xs text-muted-foreground">₹ / night</span>
            <Input inputMode="decimal" value={rate} onChange={(e) => setRate(e.target.value)} className="h-7 w-28" />
          </label>
          <Button
            size="xs"
            disabled={busy || !name.trim() || !(Number(rooms) >= 0) || !(Number(rate) > 0)}
            onClick={async () => {
              // The name goes only when it actually changed, so an ordinary re-price does not
              // put a rename — and its cascade over every booking — through the audit trail.
              const renamed = name.trim().toLowerCase().replace(/\s+/g, '_') !== cat.roomType
              const done = await run(
                () =>
                  api('/lodge-master/categories', {
                    method: 'PUT',
                    body: JSON.stringify({
                      unit_id: unitId,
                      room_type: cat.roomType,
                      ...(renamed ? { next_room_type: name.trim() } : {}),
                      rooms: Number(rooms),
                      rate_paise: rupeesToPaise(Number(rate)),
                    }),
                  }),
                renamed ? `${label} renamed to ${titleCase(name.trim())}` : `${label} updated`,
              )
              if (done) setEditing(false)
            }}
          >
            Save
          </Button>
          <Button size="xs" variant="ghost" disabled={busy} onClick={() => setEditing(false)}>Cancel</Button>
        </>
      ) : (
        <>
          <span className="tabular-nums">
            {cat.rooms} room{cat.rooms === 1 ? '' : 's'}
          </span>
          <span className="tabular-nums">{formatPaise(cat.ratePaise)} / night</span>
          {/* The band the rate and the name land this category in, shown where they are typed
              rather than discovered later on a guest's bill. */}
          <span className="text-xs text-muted-foreground">GST {cat.gstRateBp / 100}%</span>
          <span className="text-xs text-muted-foreground">{cat.beds} bed{cat.beds === 1 ? '' : 's'}</span>
          {/* Why a reduction will be refused, before it is attempted. */}
          {cat.committedPeak > 0 && (
            <Badge variant="outline" className="text-muted-foreground">
              {cat.committedPeak} promised on the busiest night
            </Badge>
          )}
          {canEdit && (
            <Button size="icon-xs" variant="ghost" className="ml-auto" disabled={busy} title="Change the name, rooms or rate"
              onClick={() => {
                setName(cat.roomType.replace(/_/g, ' '))
                setRooms(String(cat.rooms))
                setRate(String(cat.ratePaise / 100))
                setEditing(true)
              }}
            >
              <Pencil className="size-3" />
            </Button>
          )}
          {canDelete && (
            <Button
              size="icon-xs"
              variant="ghost"
              className="text-destructive"
              disabled={busy}
              title={`Retire the ${label} category`}
              onClick={() =>
                run(
                  () =>
                    api('/lodge-master/categories', {
                      method: 'DELETE',
                      body: JSON.stringify({ unit_id: unitId, room_type: cat.roomType }),
                    }),
                  `${label} retired`,
                )
              }
            >
              <Trash2 className="size-3" />
            </Button>
          )}
        </>
      )}
    </li>
  )
}

function NewCategoryForm({
  busy, onCancel, onSubmit,
}: {
  busy: boolean
  onCancel: () => void
  onSubmit: (body: { room_type: string; rooms: number; rate_paise: number; beds: number }) => void | Promise<void>
}) {
  const [name, setName] = useState('')
  const [rooms, setRooms] = useState('1')
  const [rate, setRate] = useState('')
  const [beds, setBeds] = useState('2')

  return (
    <div className="flex flex-wrap items-end gap-2">
      <label className="text-sm">
        <span className="block text-xs text-muted-foreground">Category</span>
        <Input
          placeholder="e.g. semi suite"
          value={name}
          onChange={(e) => setName(e.target.value)}
          className="h-9 w-44"
        />
      </label>
      <label className="text-sm">
        <span className="block text-xs text-muted-foreground">Rooms</span>
        <Input inputMode="numeric" value={rooms} onChange={(e) => setRooms(e.target.value)} className="h-9 w-20" />
      </label>
      <label className="text-sm">
        <span className="block text-xs text-muted-foreground">₹ / night</span>
        <Input inputMode="decimal" value={rate} onChange={(e) => setRate(e.target.value)} className="h-9 w-28" />
      </label>
      <label className="text-sm">
        <span className="block text-xs text-muted-foreground">Beds</span>
        <Input inputMode="numeric" value={beds} onChange={(e) => setBeds(e.target.value)} className="h-9 w-16" />
      </label>
      <Button
        size="sm"
        disabled={busy || !name.trim() || !(Number(rooms) > 0) || !(Number(rate) > 0) || !(Number(beds) > 0)}
        onClick={() =>
          onSubmit({
            room_type: name.trim(),
            rooms: Number(rooms),
            rate_paise: rupeesToPaise(Number(rate)),
            beds: Number(beds),
          })
        }
      >
        Add
      </Button>
      <Button size="sm" variant="ghost" onClick={onCancel} disabled={busy}>Cancel</Button>
    </div>
  )
}
