'use client'

import { useEffect, useRef, useState } from 'react'
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { Bell } from 'lucide-react'
import { api } from '@/lib/http'
import { cn } from '@/lib/utils'

type Notification = { id: string; kind: string; message: string; href: string; at: string }

const KIND_DOT: Record<string, string> = {
  approval: 'bg-amber-500', change_request: 'bg-blue-500', payment: 'bg-red-500', stale: 'bg-slate-400',
}

/** Notification bell: the signed-in user's actionable feed (FR-9.1), refreshed on navigation. */
export function NotificationBell() {
  const [items, setItems] = useState<Notification[]>([])
  const [open, setOpen] = useState(false)
  const pathname = usePathname()
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    let active = true
    api<{ notifications: Notification[] }>('/notifications')
      .then((r) => { if (active) setItems(r.notifications) })
      .catch(() => {})
    return () => { active = false }
  }, [pathname])

  useEffect(() => {
    function onClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onClick)
    return () => document.removeEventListener('mousedown', onClick)
  }, [])

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="relative flex size-8 items-center justify-center rounded-md hover:bg-muted"
        aria-label={`Notifications${items.length ? ` (${items.length})` : ''}`}
      >
        <Bell className="size-4" />
        {items.length > 0 && (
          <span className="absolute -right-0.5 -top-0.5 flex min-w-4 items-center justify-center rounded-full bg-red-500 px-1 text-[10px] font-medium text-white tabular-nums">
            {items.length > 9 ? '9+' : items.length}
          </span>
        )}
      </button>

      {open && (
        <div className="absolute right-0 z-20 mt-1 max-h-96 w-80 overflow-auto rounded-lg border bg-popover p-1 shadow-lg">
          {items.length === 0 ? (
            <div className="p-3 text-sm text-muted-foreground">Nothing needs your attention.</div>
          ) : (
            items.map((n) => (
              <Link
                key={n.id}
                href={n.href}
                onClick={() => setOpen(false)}
                className="flex items-start gap-2 rounded-md p-2 text-sm hover:bg-muted"
              >
                <span className={cn('mt-1.5 size-1.5 shrink-0 rounded-full', KIND_DOT[n.kind] ?? 'bg-muted-foreground')} />
                <span>{n.message}</span>
              </Link>
            ))
          )}
        </div>
      )}
    </div>
  )
}
