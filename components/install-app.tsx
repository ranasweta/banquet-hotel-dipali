'use client'

import { useEffect, useState } from 'react'
import { Download, Share } from 'lucide-react'

/**
 * "Install this app" on the sign-in screen, shown only to someone who is not already using
 * the installed app (client, 11 Aug 2026).
 *
 * Two paths, because the platforms genuinely differ:
 *
 *   Chrome / Edge / Android   fire `beforeinstallprompt`, which we hold and replay on a tap.
 *                             The browser only fires it when the app qualifies and is not
 *                             already installed, so its absence is itself the "hide" signal.
 *   iOS Safari                never fires it and exposes no install API at all. The only
 *                             route is Share → Add to Home Screen, so iPhone users get those
 *                             words instead of a button that could not work.
 *
 * Anyone already in the installed app matches `display-mode: standalone` and sees nothing —
 * offering to install what you are running is how a login screen looks broken.
 */

// `beforeinstallprompt` is Chromium-only and absent from lib.dom.
type InstallEvent = Event & {
  prompt: () => Promise<void>
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>
}

export function InstallApp() {
  const [deferred, setDeferred] = useState<InstallEvent | null>(null)
  const [installed, setInstalled] = useState(true)
  const [isIOS, setIsIOS] = useState(false)

  useEffect(() => {
    // Starts true so nothing flashes on screen before we know which case we are in.
    const standalone =
      window.matchMedia('(display-mode: standalone)').matches ||
      // iOS predates the media query and reports it here instead.
      (navigator as Navigator & { standalone?: boolean }).standalone === true
    setInstalled(standalone)
    setIsIOS(/iphone|ipad|ipod/i.test(navigator.userAgent))

    if (standalone) return
    navigator.serviceWorker?.register('/sw.js').catch(() => {
      // No service worker means no install prompt on Chrome, which is a smaller loss than
      // a sign-in screen that throws.
    })

    const onPrompt = (e: Event) => {
      e.preventDefault()
      setDeferred(e as InstallEvent)
    }
    window.addEventListener('beforeinstallprompt', onPrompt)
    window.addEventListener('appinstalled', () => setInstalled(true))
    return () => window.removeEventListener('beforeinstallprompt', onPrompt)
  }, [])

  if (installed) return null

  if (isIOS) {
    return (
      <p className="mt-6 flex items-center justify-center gap-1.5 text-center text-xs text-muted-foreground">
        <Share className="size-3.5 shrink-0" aria-hidden />
        <span>
          Add to your Home Screen: tap <strong className="font-semibold">Share</strong>, then{' '}
          <strong className="font-semibold">Add to Home Screen</strong>.
        </span>
      </p>
    )
  }

  if (!deferred) return null

  return (
    <button
      type="button"
      onClick={async () => {
        await deferred.prompt()
        const { outcome } = await deferred.userChoice
        // One prompt per event: a dismissed one cannot be replayed, so drop the button
        // rather than leave it doing nothing.
        if (outcome === 'accepted') setInstalled(true)
        setDeferred(null)
      }}
      className="mt-6 flex w-full items-center justify-center gap-2 rounded-md border border-primary/30 px-4 py-2.5 text-sm font-medium text-primary transition-colors hover:bg-primary/5 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
    >
      <Download className="size-4" aria-hidden />
      Install the app
    </button>
  )
}
