'use client'

import { useEffect, useState } from 'react'
import { Bell, BellOff, Loader2 } from 'lucide-react'
import { toast } from 'sonner'
import { api } from '@/lib/http'
import { Button } from '@/components/ui/button'

/**
 * Registers the service worker, and offers to turn phone notifications on.
 *
 * TWO SEPARATE THINGS, deliberately. Registration happens on mount for everyone, because it
 * is what makes the app installable and what caches the static bundle. Asking for notification
 * permission happens only when the user presses the button: a permission prompt fired on page
 * load is the one people deny reflexively, and a denial is close to permanent — the browser
 * will not ask again, and the only way back is through site settings most staff will never
 * find. So the prompt is spent on a deliberate press.
 */

/** The VAPID public key is base64url; the browser wants raw bytes. */
function urlBase64ToUint8Array(base64: string): Uint8Array {
  const padding = '='.repeat((4 - (base64.length % 4)) % 4)
  const normalised = (base64 + padding).replace(/-/g, '+').replace(/_/g, '/')
  const raw = window.atob(normalised)
  return Uint8Array.from([...raw].map((c) => c.charCodeAt(0)))
}

export function PushSetup({ vapidPublicKey }: { vapidPublicKey: string | null }) {
  const [state, setState] = useState<'loading' | 'unsupported' | 'off' | 'on' | 'denied'>('loading')
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      if (!('serviceWorker' in navigator)) {
        if (!cancelled) setState('unsupported')
        return
      }
      const reg = await navigator.serviceWorker.register('/sw.js', { scope: '/' })
      if (!('PushManager' in window) || !vapidPublicKey) {
        if (!cancelled) setState('unsupported')
        return
      }
      if (Notification.permission === 'denied') {
        if (!cancelled) setState('denied')
        return
      }
      const existing = await reg.pushManager.getSubscription()
      if (!cancelled) setState(existing ? 'on' : 'off')
    })().catch(() => {
      if (!cancelled) setState('unsupported')
    })
    return () => {
      cancelled = true
    }
  }, [vapidPublicKey])

  async function enable() {
    setBusy(true)
    try {
      const permission = await Notification.requestPermission()
      if (permission !== 'granted') {
        setState(permission === 'denied' ? 'denied' : 'off')
        return
      }
      const reg = await navigator.serviceWorker.ready
      const sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(vapidPublicKey!) as BufferSource,
      })
      await api('/push/subscribe', { method: 'POST', body: JSON.stringify(sub.toJSON()) })
      setState('on')
      toast.success('Notifications on for this device')
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not turn notifications on')
    } finally {
      setBusy(false)
    }
  }

  async function disable() {
    setBusy(true)
    try {
      const reg = await navigator.serviceWorker.ready
      const sub = await reg.pushManager.getSubscription()
      if (sub) {
        // Tell the server BEFORE unsubscribing: once the local subscription is gone the
        // endpoint cannot be read back, and the row would be left to be pruned only when a
        // later push bounced off it.
        await api('/push/subscribe', {
          method: 'DELETE',
          body: JSON.stringify({ endpoint: sub.endpoint }),
        }).catch(() => {})
        await sub.unsubscribe()
      }
      setState('off')
      toast.success('Notifications off for this device')
    } finally {
      setBusy(false)
    }
  }

  if (state === 'loading' || state === 'unsupported') return null

  if (state === 'denied') {
    return (
      <p className="text-xs text-muted-foreground">
        Notifications are blocked for this site in your browser settings.
      </p>
    )
  }

  return (
    <Button variant="outline" size="sm" disabled={busy} onClick={state === 'on' ? disable : enable}>
      {busy ? (
        <Loader2 className="size-4 animate-spin" />
      ) : state === 'on' ? (
        <BellOff className="size-4" />
      ) : (
        <Bell className="size-4" />
      )}
      {state === 'on' ? 'Turn off notifications' : 'Notify me on this phone'}
    </Button>
  )
}
