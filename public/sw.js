// Minimum service worker for installability (app/manifest.ts explains why).
//
// Chrome will not fire `beforeinstallprompt` unless a service worker with a fetch handler
// is registered. This one caches NOTHING and passes every request straight through: the app
// is entirely database-driven, so a cached shell would show empty screens that read as data
// loss. If offline support is ever wanted it belongs here, deliberately, not by accident.
self.addEventListener('install', () => self.skipWaiting())
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()))
self.addEventListener('fetch', () => {})
