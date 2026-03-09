self.addEventListener('install', (e) => e.waitUntil(self.skipWaiting()));

self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));

self.addEventListener('fetch', (e) => {
  e.respondWith(
    fetch(e.request).catch(() => new Response('Offline Mode Active. Please connect to the internet.'))
  );
});