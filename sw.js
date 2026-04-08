/* AuthenticCam Pro · sw.js v9.0
   Strategy: Cache-First for app shell, Network-First for data
   Supports offline usage after first load.                    */

const CACHE_VER  = 'ac-v9';
const SHELL_VER  = 'ac-shell-v9';

// App shell — files cached during install (offline support)
const SHELL_FILES = [
    './',
    './index.html',
    './style.css',
    './script.js',
    './manifest.json',
    './enhance_worker.js'
];

// External CDN assets (cached on first fetch)
const CDN_HOSTS = [
    'fonts.googleapis.com',
    'fonts.gstatic.com',
    'cdnjs.cloudflare.com',
    'cdn.jsdelivr.net'
];

// ─── INSTALL ─────────────────────────────────────────────────────
self.addEventListener('install', event => {
    event.waitUntil(
        caches.open(SHELL_VER)
            .then(cache => cache.addAll(SHELL_FILES))
            .then(() => self.skipWaiting())
            .catch(err => console.warn('[SW] Install partial fail:', err))
    );
});

// ─── ACTIVATE ────────────────────────────────────────────────────
self.addEventListener('activate', event => {
    event.waitUntil(
        caches.keys().then(keys => Promise.all(
            keys
                .filter(k => k !== SHELL_VER && k !== CACHE_VER)
                .map(k => caches.delete(k))
        )).then(() => self.clients.claim())
    );
});

// ─── FETCH ───────────────────────────────────────────────────────
self.addEventListener('fetch', event => {
    const req = event.request;
    const url = new URL(req.url);

    // Only handle GET requests
    if (req.method !== 'GET') return;

    // Block cross-origin requests that aren't CDN assets
    const isSameOrigin = url.origin === self.location.origin;
    const isCDN        = CDN_HOSTS.some(h => url.hostname.includes(h));

    if (!isSameOrigin && !isCDN) return;

    // Strategy: Cache-First for app shell, CDN fonts, and static files
    if (isCDN || isStaticAsset(url.pathname)) {
        event.respondWith(cacheFirst(req));
        return;
    }

    // Strategy: Network-First for everything else (HTML, JS, CSS)
    event.respondWith(networkFirst(req));
});

// ─── CACHE-FIRST ─────────────────────────────────────────────────
async function cacheFirst(req) {
    const cached = await caches.match(req);
    if (cached) return cached;
    try {
        const fresh = await fetch(req);
        if (fresh.ok) {
            const cache = await caches.open(CACHE_VER);
            cache.put(req, fresh.clone());
        }
        return fresh;
    } catch(e) {
        return new Response('Offline', { status: 503, statusText: 'Offline' });
    }
}

// ─── NETWORK-FIRST ───────────────────────────────────────────────
async function networkFirst(req) {
    try {
        const fresh = await fetch(req, { cache: 'no-cache' });
        if (fresh.ok) {
            const cache = await caches.open(SHELL_VER);
            cache.put(req, fresh.clone());
        }
        return fresh;
    } catch(e) {
        const cached = await caches.match(req);
        if (cached) return cached;
        // Offline fallback — return index.html for navigation requests
        if (req.mode === 'navigate') {
            const fallback = await caches.match('./index.html');
            if (fallback) return fallback;
        }
        return new Response('Offline', { status: 503, statusText: 'Offline' });
    }
}

// ─── HELPERS ─────────────────────────────────────────────────────
function isStaticAsset(pathname) {
    return /\.(woff2?|ttf|otf|eot|png|jpg|jpeg|gif|webp|svg|ico)$/i.test(pathname);
}

// ─── MESSAGE HANDLER ─────────────────────────────────────────────
self.addEventListener('message', event => {
    if (event.data === 'skipWaiting') self.skipWaiting();
    if (event.data === 'clearCache') {
        caches.keys().then(keys => Promise.all(keys.map(k => caches.delete(k))));
    }
});
