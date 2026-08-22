'use client'

import { useEffect, useState, useSyncExternalStore } from 'react'
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

/**
 * The two browser facts this component turns on are READ, not stored — through
 * `useSyncExternalStore` rather than useState written from an effect.
 *
 * Both are unknowable on the server, and the old shape (state seeded to a safe default, then
 * corrected in an effect) rendered the sign-in screen twice on every single load: React
 * painted, committed, ran the effect, set two pieces of state and painted again. That is what
 * `react-hooks/set-state-in-effect` is warning about, and it is the documented use for this
 * hook. The server snapshot keeps the old behaviour exactly — assume installed, show nothing —
 * so still nothing flashes before we know which case we are in.
 */
const readStandalone = () =>
  window.matchMedia('(display-mode: standalone)').matches ||
  // iOS predates the media query and reports it here instead.
  (navigator as Navigator & { standalone?: boolean }).standalone === true

function subscribeDisplayMode(onChange: () => void) {
  const mq = window.matchMedia('(display-mode: standalone)')
  mq.addEventListener('change', onChange)
  return () => mq.removeEventListener('change', onChange)
}

const readIOS = () => /iphone|ipad|ipod/i.test(navigator.userAgent)
/** A user agent does not change under a running page, so there is nothing to subscribe to. */
const subscribeNever = () => () => {}

export function InstallApp() {
  const [deferred, setDeferred] = useState<InstallEvent | null>(null)
  /**
   * Installed while this page was open — by our button, or by Chrome's own omnibox entry.
   * Tracked apart from `standalone` because the tab that triggers an install does not itself
   * become standalone, so the media query stays false and the offer would linger.
   */
  const [justInstalled, setJustInstalled] = useState(false)

  const standalone = useSyncExternalStore(subscribeDisplayMode, readStandalone, () => true)
  const isIOS = useSyncExternalStore(subscribeNever, readIOS, () => false)

  useEffect(() => {
    if (standalone) return
    navigator.serviceWorker?.register('/sw.js').catch(() => {
      // No service worker means no install prompt on Chrome, which is a smaller loss than
      // a sign-in screen that throws.
    })

    const onPrompt = (e: Event) => {
      e.preventDefault()
      setDeferred(e as InstallEvent)
    }
    const onInstalled = () => setJustInstalled(true)
    window.addEventListener('beforeinstallprompt', onPrompt)
    window.addEventListener('appinstalled', onInstalled)
    return () => {
      window.removeEventListener('beforeinstallprompt', onPrompt)
      // Left behind before this: only the prompt listener was being removed.
      window.removeEventListener('appinstalled', onInstalled)
    }
  }, [standalone])

  if (standalone || justInstalled) return null

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
        if (outcome === 'accepted') setJustInstalled(true)
        setDeferred(null)
      }}
      className="mt-6 flex w-full items-center justify-center gap-2 rounded-md border border-primary/30 px-4 py-2.5 text-sm font-medium text-primary transition-colors hover:bg-primary/5 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
    >
      <Download className="size-4" aria-hidden />
      Install the app
    </button>
  )
}
