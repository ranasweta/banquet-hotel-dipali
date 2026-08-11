import type { MetadataRoute } from 'next'

/**
 * The installable-app definition. Serving this from a metadata route rather than a static
 * file keeps it beside the layout's `metadata`, so the app's name lives in one place.
 *
 * The point of installing is that it is the SAME deployment: there is no bundle to ship and
 * no version to skew. Every permission check, the venue exclusion constraint and the discount
 * cap are enforced server-side, so a phone that had a stale client would be a real hazard —
 * here it cannot happen, because the phone is loading the site it is a shortcut to.
 *
 * `start_url` is the dashboard rather than the last page visited; a shortcut opened cold
 * should land somewhere the reader can orient themselves, and the auth guard redirects to
 * /login when the session has lapsed.
 */
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: 'Hotel Dipali — Banquet Management',
    short_name: 'Hotel Dipali',
    description: 'Banquet & event management for Hotel Dipali',
    start_url: '/',
    scope: '/',
    display: 'standalone',
    orientation: 'portrait',
    // Matches the app shell's cream so the splash does not flash white before paint.
    background_color: '#F5EFE1',
    theme_color: '#6B5B2E',
    icons: [
      { src: '/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
      { src: '/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
      // Android crops a launcher icon to the platform's own shape. The maskable pair carries
      // the mark inside a safe zone so the crop takes padding rather than the logo.
      { src: '/icon-maskable-192.png', sizes: '192x192', type: 'image/png', purpose: 'maskable' },
      { src: '/icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
    ],
  }
}
