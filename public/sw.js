const CACHE_PREFIX = 'choture-shell-'
const CACHE_NAME = `${CACHE_PREFIX}v2`
const PRECACHE = ['/', '/offline.html', '/manifest.json', '/icons/icon.svg', '/icons/icon-192.png', '/icons/icon-512.png']
const PRIVATE_PATHS = ['/auth/', '/rest/', '/storage/', '/functions/']
const PREVIOUS_CACHE_PREFIXES = ['mise-shell-']

// FCM shares this root-scoped worker with the app shell. Load the optional
// Firebase handler only when public browser configuration is present.
if (new URL(self.location.href).searchParams.has('firebaseConfig')) {
  importScripts('/firebase-messaging-sw.js')
}

self.addEventListener('install', event => {
  event.waitUntil(caches.open(CACHE_NAME).then(cache => cache.addAll(PRECACHE)).then(() => self.skipWaiting()))
})

self.addEventListener('activate', event => {
  event.waitUntil(caches.keys().then(keys => Promise.all(
    keys.filter(key => (key.startsWith(CACHE_PREFIX) || PREVIOUS_CACHE_PREFIXES.some(prefix => key.startsWith(prefix))) && key !== CACHE_NAME).map(key => caches.delete(key)),
  )).then(() => self.clients.claim()))
})

self.addEventListener('fetch', event => {
  const request = event.request
  if (request.method !== 'GET' || new URL(request.url).origin !== self.location.origin) return
  const url = new URL(request.url)
  if (PRIVATE_PATHS.some(path => url.pathname.startsWith(path))) return

  if (request.mode === 'navigate') {
    event.respondWith(fetch(request).then(response => response).catch(async () =>
      (await caches.match('/offline.html')) || Response.error(),
    ))
    return
  }

  if (!url.pathname.startsWith('/assets/') && !/\.(?:css|js|svg|png|ico|woff2?)$/i.test(url.pathname)) return
  event.respondWith(caches.match(request).then(cached => {
    const network = fetch(request).then(response => {
      if (response.ok && response.type === 'basic') {
        const copy = response.clone()
        void caches.open(CACHE_NAME).then(cache => cache.put(request, copy))
      }
      return response
    }).catch(() => cached || Response.error())
    return cached || network
  }))
})
