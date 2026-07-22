'use client'

import { useEffect, useState } from 'react'
import { cn } from '@/lib/utils'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'

/**
 * 12-hour AM/PM time entry (client, 22 Jul 2026). The native <input type="time"> renders in
 * whatever clock each browser's locale uses — so staff saw 24-hour on some machines; this
 * always reads and writes AM/PM. Value in/out is the stored 24-hour 'HH:MM', so nothing
 * downstream changes. An overnight window (end ≤ start, e.g. 8 PM → 1 AM) is decided by the
 * booking logic (lib/occupancy), not here — you just pick the two clock times.
 */

const HOURS = Array.from({ length: 12 }, (_, i) => String(i + 1))
const MINUTES = Array.from({ length: 60 }, (_, i) => String(i).padStart(2, '0'))
const MERIDIEMS = ['AM', 'PM']

function split(value: string): { h: string; m: string; p: string } {
  const [hStr, mStr] = (value ?? '').split(':')
  const h = Number(hStr)
  const m = Number(mStr)
  if (Number.isNaN(h) || Number.isNaN(m)) return { h: '', m: '', p: '' }
  return { h: String(h % 12 || 12), m: String(m).padStart(2, '0'), p: h >= 12 ? 'PM' : 'AM' }
}
function join(h: string, m: string, p: string): string {
  if (!h || !m || !p) return ''
  const hh = (Number(h) % 12) + (p === 'PM' ? 12 : 0)
  return `${String(hh).padStart(2, '0')}:${m}`
}

export function TimePicker12({
  value,
  onChange,
  disabled,
  className,
}: {
  value: string
  onChange: (v: string) => void
  disabled?: boolean
  className?: string
}) {
  const [h, setH] = useState('')
  const [m, setM] = useState('')
  const [p, setP] = useState('')

  // Seed / re-seed from an externally set value (e.g. the wizard carrying the last end time
  // over as the next start) without clobbering an in-progress local selection. Guarded so it
  // fires only on a genuine external change, never in a cascade.
  useEffect(() => {
    if (join(h, m, p) === value) return
    const s = split(value)
    /* eslint-disable react-hooks/set-state-in-effect */
    setH(s.h)
    setM(s.m)
    setP(s.p)
    /* eslint-enable react-hooks/set-state-in-effect */
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value])

  const emit = (nh: string, nm: string, np: string) => {
    setH(nh)
    setM(nm)
    setP(np)
    onChange(join(nh, nm, np))
  }

  const box = (items: string[], val: string, onPick: (v: string) => void, placeholder: string) => (
    <Select items={items.map((x) => ({ value: x, label: x }))} value={val} onValueChange={(v) => onPick(v ?? '')} disabled={disabled}>
      <SelectTrigger className="w-16 justify-center tabular-nums"><SelectValue placeholder={placeholder} /></SelectTrigger>
      <SelectContent>{items.map((x) => <SelectItem key={x} value={x}>{x}</SelectItem>)}</SelectContent>
    </Select>
  )

  return (
    <div className={cn('flex items-center gap-1', className)}>
      {box(HOURS, h, (v) => emit(v, m, p), 'Hr')}
      <span className="text-muted-foreground">:</span>
      {box(MINUTES, m, (v) => emit(h, v, p), 'Min')}
      {box(MERIDIEMS, p, (v) => emit(h, m, v), 'AM')}
    </div>
  )
}
