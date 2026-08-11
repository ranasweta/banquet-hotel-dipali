/* eslint-disable no-undef */
/**
 * Service worker for the installed app.
 *
 * WHAT IT DELIBERATELY DOES NOT DO: cache pages or API responses. Every screen here is
 * permission-gated and reads live data — a cached day sheet is a menu that has since changed,
 * a cached booking is an availability answer that is no longer true, and a cached API response
 * could show one user another user's queue after a shared phone changes hands. The offline
 * story for this app is "you are offline", not a stale copy of yesterday.
 *
 * WHAT IT DOES CACHE: `/_next/static/*` only. Those filenames carry a content hash, so a given
 * URL's bytes can never change — it is safe by construction, and it is what makes a cold launch
 * from the home screen feel like an app rather than a page load.
 *
 * The fetch handler also exists because Chrome requires one before it will treat the site as
 * installable at all.
 */

const CACHE = 'dipali-static-v1'

self.addEventListener('install', (event) => {
  // Take over immediately: a half-updated app is worse than a moment's interruption, and
  // there is nothing in flight worth preserving since nothing is cached but static assets.
  event.waitUntil(self.skipWaiting())
})

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const names = await caches.keys()
      await Promise.all(names.filter((n) => n !== CACHE).map((n) => caches.delete(n)))
      await self.clients.claim()
    })(),
  )
})

self.addEventListener('fetch', (event) => {
  const { request } = event
  if (request.method !== 'GET') return

  const url = new URL(request.url)
  const immutable = url.origin === self.location.origin && url.pathname.startsWith('/_next/static/')
  if (!immutable) return // everything else goes to the network, every time

  event.respondWith(
    (async () => {
      const hit = await caches.match(request)
      if (hit) return hit
      const res = await fetch(request)
      if (res.ok) {
        const cache = await caches.open(CACHE)
        cache.put(request, res.clone())
      }
      return res
    })(),
  )
})

/**
 * A push from the server. The payload is written by lib/push.ts and carries only what the
 * banner shows plus where to go — never a guest's details, because a notification is rendered
 * on a locked screen that anyone nearby can read.
 */
self.addEventListener('push', (event) => {
  let payload = {}
  try {
    payload = event.data ? event.data.json() : {}
  } catch {
    payload = {}
  }
  const title = payload.title || 'Hotel Dipali'
  event.waitUntil(
    self.registration.showNotification(title, {
      body: payload.body || '',
      icon: '/icon-192.png',
      badge: '/icon-192.png',
      // Same tag replaces rather than stacks, so five reminders about one booking are one
      // banner rather than a wall the reader swipes away without reading.
      tag: payload.tag || 'dipali',
      data: { href: payload.href || '/' },
    }),
  )
})

self.addEventListener('notificationclick', (event) => {
  event.notification.close()
  const href = (event.notification.data && event.notification.data.href) || '/'
  event.waitUntil(
    (async () => {
      const all = await self.clients.matchAll({ type: 'window', includeUncontrolled: true })
      // Reuse an open window rather than piling up tabs on a phone.
      for (const client of all) {
        if (client.url.includes(self.location.origin)) {
          await client.focus()
          return client.navigate(href)
        }
      }
      return self.clients.openWindow(href)
    })(),
  )
})
