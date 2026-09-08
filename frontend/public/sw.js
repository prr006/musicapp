const CACHE = 'melo-shell-v1'
const SHELL = ['/', '/index.html', '/manifest.webmanifest', '/icons/melo-192.png', '/icons/melo-512.png']

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(SHELL)).then(() => self.skipWaiting()))
})

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key))))
      .then(() => self.clients.claim()),
  )
})

self.addEventListener('fetch', (event) => {
  const request = event.request
  if (request.method !== 'GET') return
  const url = new URL(request.url)
  // Provider/API data and media links are deliberately network-only. Offline
  // support means the app shell can explain connectivity, not fake music.
  if (url.pathname.startsWith('/api/') || url.pathname.includes('/stream/')) return
  if (url.origin !== self.location.origin) return

  if (request.mode === 'navigate') {
    event.respondWith(fetch(request).catch(() => caches.match('/index.html')))
    return
  }
  event.respondWith(
    caches.match(request).then((cached) => cached || fetch(request).then((response) => {
      if (response.ok) {
        const copy = response.clone()
        void caches.open(CACHE).then((cache) => cache.put(request, copy))
      }
      return response
    })),
  )
})
