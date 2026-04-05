const V = 'ac-pro-v4';
const FILES = ['./', './index.html', './style.css', './script.js', './manifest.json'];

self.addEventListener('install', e => {
    e.waitUntil(caches.open(V).then(c => c.addAll(FILES)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
    e.waitUntil(caches.keys().then(ks =>
        Promise.all(ks.filter(k => k !== V).map(k => caches.delete(k)))
    ).then(() => self.clients.claim()));
});
self.addEventListener('fetch', e => {
    if (!e.request.url.startsWith(self.location.origin)) return;
    e.respondWith(
        fetch(e.request).then(r => {
            caches.open(V).then(c => c.put(e.request, r.clone()));
            return r;
        }).catch(() => caches.match(e.request))
    );
});
