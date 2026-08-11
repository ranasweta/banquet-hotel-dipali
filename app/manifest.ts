import type { MetadataRoute } from 'next'

/**
 * Makes the app installable to a home screen or desktop (client, 11 Aug 2026).
 *
 * `display: standalone` is what removes the browser chrome once installed, and it is also
 * what `components/install-app.tsx` matches on to decide the prompt has been acted on.
 *
 * Deliberately no offline support. Every screen in this app reads the database, so a cached
 * shell would render empty tables that look like data loss rather than a lost connection.
 * The service worker exists only because Chrome will not offer installation without one.
 */
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: 'Hotel Dipali — Banquet Management',
    short_name: 'Hotel Dipali',
    description: 'Banquet & event management for Hotel Dipali',
    start_url: '/',
    display: 'standalone',
    orientation: 'portrait',
    background_color: '#f5efe1',
    theme_color: '#4a3410',
    icons: [
      { src: '/icon-192.png', sizes: '192x192', type: 'image/png' },
      { src: '/icon-512.png', sizes: '512x512', type: 'image/png' },
      // Android crops icons to its own shape; without a maskable entry it adds a white
      // plate behind the logo instead.
      { src: '/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
    ],
  }
}
