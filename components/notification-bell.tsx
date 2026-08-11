'use client'

import { useEffect, useRef, useState } from 'react'
import { useRouter, usePathname } from 'next/navigation'
import { Bell, Check } from 'lucide-react'
import { toast } from 'sonner'
import { api } from '@/lib/http'
import { cn } from '@/lib/utils'

type Notification = { id: string; kind: string; message: string; href: string; at: string }

const KIND_DOT: Record<string, string> = {
  approval: 'bg-amber-500',
  change_request: 'bg-[var(--chart-2)]',
  chef: 'bg-primary',
  maintenance: 'bg-orange-500',
  payment: 'bg-red-500',
  stale: 'bg-muted-foreground',
}

/** Where each kind sends you — shown on the row so it's obvious before you click. */
const KIND_TARGET: Record<string, string> = {
  approval: 'Approvals',
  change_request: 'Change requests',
  chef: 'Chef requests',
  maintenance: 'Maintenance',
  payment: 'Booking',
  stale: 'Booking',
}

/**
 * Notification bell: the signed-in user's actionable feed (FR-9.1), refreshed on navigation.
 *
 * Clicking an item marks it read and takes the user to the screen where they can act on it, so
 * a thing they've dealt with stops following them around. The panel opens to the RIGHT of the
 * bell: the bell sits in a 240px sidebar, so a right-aligned panel would hang off the left edge
 * of the window. It is also width- and height-capped against the viewport, and long messages
 * wrap, so the feed can never push the window sideways.
 */
export function NotificationBell() {
  const [items, setItems] = useState<Notification[]>([])
  // Distinct from "no notifications": a swallowed fetch error used to leave the list empty,
  // and an empty list reads as the reassuring "All clear" — so during the outage on 10 Aug
  // this bell would have told every user nothing needed them while the database was refusing
  // connections. Failure must never be indistinguishable from good news.
  const [failed, setFailed] = useState(false)
  const [open, setOpen] = useState(false)
  const pathname = usePathname()
  const router = useRouter()
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    let active = true
    api<{ notifications: Notification[] }>('/notifications')
      .then((r) => { if (active) { setItems(r.notifications); setFailed(false) } })
      .catch(() => { if (active) setFailed(true) })
    return () => { active = false }
  }, [pathname])

  useEffect(() => {
    function onClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', onClick)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onClick)
      document.removeEventListener('keydown', onKey)
    }
  }, [])

  async function dismiss(ids: string[]) {
    // Drop it locally first so the row goes the moment it's touched; the write follows.
    // If the write fails, put the rows BACK: they were not marked read, and leaving them
    // hidden would quietly lose work the user still has to do — they would reappear on the
    // next page load with no explanation for why they returned.
    const previous = items
    setItems((prev) => prev.filter((n) => !ids.includes(n.id)))
    try {
      await api('/notifications/read', { method: 'POST', body: JSON.stringify({ ids }) })
    } catch {
      setItems(previous)
      toast.error('Could not mark that as read — it is still waiting for you.')
    }
  }

  async function openItem(n: Notification) {
    setOpen(false)
    await dismiss([n.id])
    router.push(n.href)
  }

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
        // The panel opens away from whichever edge the bell is against, or it opens off-screen.
        // At lg+ the bell is in the 240px sidebar, so it opens rightward into the page; below lg
        // the bell is the last item in the top bar, flush to the right edge, so it must open
        // leftward instead. Capped to the viewport in both directions on top of that.
        <div className="absolute right-0 z-30 mt-1 w-[min(22rem,calc(100vw-2rem))] max-h-[min(24rem,70vh)] overflow-y-auto overscroll-contain rounded-lg border bg-popover shadow-lg lg:left-0 lg:right-auto">
          <div className="flex items-center justify-between gap-2 border-b px-3 py-2">
            <span className="text-xs font-medium">
              {failed
                ? 'Couldn’t load'
                : items.length === 0
                  ? 'All clear'
                  : `${items.length} need${items.length === 1 ? 's' : ''} you`}
            </span>
            {items.length > 0 && (
              <button
                type="button"
                onClick={() => dismiss(items.map((n) => n.id))}
                className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
              >
                <Check className="size-3" /> Mark all read
              </button>
            )}
          </div>

          {failed ? (
            <div className="p-3 text-sm text-muted-foreground">
              Couldn&apos;t load your notifications. This does <strong>not</strong> mean there are
              none — reload the page to try again.
            </div>
          ) : items.length === 0 ? (
            <div className="p-3 text-sm text-muted-foreground">Nothing needs your attention.</div>
          ) : (
            <ul className="p-1">
              {items.map((n) => (
                <li key={n.id}>
                  <button
                    type="button"
                    onClick={() => openItem(n)}
                    className="flex w-full items-start gap-2 rounded-md p-2 text-left text-sm hover:bg-muted"
                  >
                    <span className={cn('mt-1.5 size-1.5 shrink-0 rounded-full', KIND_DOT[n.kind] ?? 'bg-muted-foreground')} />
                    <span className="min-w-0 flex-1">
                      <span className="block break-words">{n.message}</span>
                      <span className="mt-0.5 block text-xs text-muted-foreground">
                        Go to {KIND_TARGET[n.kind] ?? 'the page'} →
                      </span>
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  )
}
