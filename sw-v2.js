// =====================================================================
//  SNACK TIME Service Worker  —  v1.0.3
//  Strategy:
//    • HTML (index.html)  → Network-first, update cache
//    • Static assets      → Cache-first (versioned filenames bypass cache)
//    • API + dynamic      → Network-only  (never cached)
//    • Manifest           → Network-first
//  Cache Busting:
//    Increment APP_VERSION below EVERY deployment.
//    The new CACHE_NAME triggers the install/activate lifecycle automatically.
// =====================================================================

const APP_VERSION = '1.0.8.1788538828659';
const CACHE_NAME  = `snacktime-static-${APP_VERSION}`;

// Core app shell — only plain paths, no query strings
const APP_SHELL = [
  '/',
  '/index.html',
  '/styles.css',
  '/app.js',
  '/translations.js',
  '/manifest.json',
  '/snacktime-logo.png'
];

// ─── INSTALL ──────────────────────────────────────────────────────────────
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) =>
      cache.addAll(APP_SHELL).catch(() => {
        // Non-fatal: partial cache is still useful offline
      })
    )
  );
  // Take control immediately WITHOUT waiting for old tabs to close.
  // The client-side update banner will handle safe reload.
  self.skipWaiting();
});

// ─── ACTIVATE ─────────────────────────────────────────────────────────────
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys
          .filter((key) => key !== CACHE_NAME)  // Remove ALL old caches
          .map((key) => caches.delete(key))
      )
    ).then(() => self.clients.claim())          // Take control of all pages
      .then(() => {
        // Tell every open tab: "new version is now active, safe to reload"
        return self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      })
      .then((clients) => {
        clients.forEach((client) => {
          client.postMessage({ type: 'SW_ACTIVATED', version: APP_VERSION });
        });
      })
  );
});

// ─── FETCH ────────────────────────────────────────────────────────────────
self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;

  const url = new URL(event.request.url);

  // 1. NEVER intercept API, Socket.io, or cross-origin (Razorpay, fonts, etc.)
  if (
    url.pathname.startsWith('/api/') ||
    url.pathname.startsWith('/socket.io') ||
    event.request.url.includes('socket.io') ||
    url.hostname !== self.location.hostname
  ) {
    return; // Let browser handle it — no cache involvement
  }

  // 2. HTML & manifest — Network-first, fallback to cache
  if (
    url.pathname === '/' ||
    url.pathname.endsWith('.html') ||
    url.pathname === '/manifest.json'
  ) {
    event.respondWith(networkFirstStrategy(event.request));
    return;
  }

  // 3. Static assets (JS, CSS, images, fonts) — Cache-first
  //    Because we bump ?v=XX query params on deploy, new URLs miss the cache
  //    and get fetched fresh; old URLs served from cache remain fast.
  if (
    url.pathname.endsWith('.js') ||
    url.pathname.endsWith('.css') ||
    url.pathname.endsWith('.png') ||
    url.pathname.endsWith('.jpg') ||
    url.pathname.endsWith('.svg') ||
    url.pathname.endsWith('.ico') ||
    url.pathname.endsWith('.woff2') ||
    url.pathname.endsWith('.woff')
  ) {
    event.respondWith(cacheFirstStrategy(event.request));
    return;
  }

  // 4. Everything else — Network-first
  event.respondWith(networkFirstStrategy(event.request));
});

// ─── STRATEGIES ───────────────────────────────────────────────────────────

/** Network-first: try live, fall back to cache. Updates cache on success. */
async function networkFirstStrategy(request) {
  try {
    const networkResponse = await fetch(request, { cache: 'no-cache' });
    if (networkResponse && networkResponse.status === 200) {
      const cache = await caches.open(CACHE_NAME);
      cache.put(request, networkResponse.clone());
    }
    return networkResponse;
  } catch {
    const cached = await caches.match(request);
    return cached || new Response('Offline — please reconnect.', {
      status: 503,
      headers: { 'Content-Type': 'text/plain' }
    });
  }
}

/** Cache-first: serve from cache immediately; refresh cache in background. */
async function cacheFirstStrategy(request) {
  const cached = await caches.match(request);
  if (cached) {
    // Background refresh so next visit is up-to-date
    fetch(request, { cache: 'no-cache' }).then((networkResponse) => {
      if (networkResponse && networkResponse.status === 200) {
        caches.open(CACHE_NAME).then((cache) => cache.put(request, networkResponse));
      }
    }).catch(() => {});
    return cached;
  }
  // Not in cache — fetch live and store
  try {
    const networkResponse = await fetch(request, { cache: 'no-cache' });
    if (networkResponse && networkResponse.status === 200) {
      const cache = await caches.open(CACHE_NAME);
      cache.put(request, networkResponse.clone());
    }
    return networkResponse;
  } catch {
    return new Response('Asset unavailable offline.', { status: 503 });
  }
}

// ─── MESSAGE HANDLER ──────────────────────────────────────────────────────
// Allows pages to send: { type: 'SKIP_WAITING' } to force SW activation
self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});
