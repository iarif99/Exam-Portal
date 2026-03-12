/* ═══════════════════════════════════════════════════════════════
   Pro Exam Portal — Service Worker v6
   • Full offline-first (Cache-First strategy)
   • Fonts, assets, navigation — সব cache হবে
   • Exam result offline queue → online হলে auto-send (Background Sync)
   • message 'SYNC_NOW' → manual flush trigger
   • message 'SKIP_WAITING' → instant update
═══════════════════════════════════════════════════════════════ */

const CACHE_NAME    = 'ep-v6';
const SYNC_TAG      = 'ep-result-sync';
const SYNC_DB_NAME  = 'ep_sw_sync';
const SYNC_STORE    = 'queue';

/* Shell URLs — these are pre-cached on install.
   Add your HTML filename here if it's not index.html */
const SHELL_URLS = [
  './',
  './index.html',
  './ExamPortal.html',
  './manifest.json'
];

/* ── IndexedDB helpers (inside SW scope) ── */
function _swIDB() {
  return new Promise((res, rej) => {
    const r = indexedDB.open(SYNC_DB_NAME, 1);
    r.onupgradeneeded = e => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains(SYNC_STORE)) {
        db.createObjectStore(SYNC_STORE, { autoIncrement: true, keyPath: '_id' });
      }
    };
    r.onsuccess  = e => res(e.target.result);
    r.onerror    = () => rej(new Error('IDB open failed'));
  });
}

function _queueAdd(payload) {
  return _swIDB().then(db => new Promise((res, rej) => {
    const tx  = db.transaction(SYNC_STORE, 'readwrite');
    const req = tx.objectStore(SYNC_STORE).add(payload);
    tx.oncomplete = () => res(req.result);
    tx.onerror    = rej;
  }));
}

function _queueGetAll() {
  return _swIDB().then(db => new Promise((res, rej) => {
    const tx  = db.transaction(SYNC_STORE, 'readonly');
    const req = tx.objectStore(SYNC_STORE).getAll();
    req.onsuccess = () => res(req.result || []);
    req.onerror   = rej;
  }));
}

function _queueDeleteKey(key) {
  return _swIDB().then(db => new Promise((res, rej) => {
    const tx = db.transaction(SYNC_STORE, 'readwrite');
    tx.objectStore(SYNC_STORE).delete(key);
    tx.oncomplete = res;
    tx.onerror    = rej;
  }));
}

/* ── Flush queue → send all pending results ── */
async function _flushQueue() {
  const items = await _queueGetAll();
  if (!items.length) return { sent: 0 };

  let sent = 0;
  for (const item of items) {
    try {
      const res = await fetch(item.url, {
        method:  'POST',
        mode:    'no-cors',
        headers: { 'Content-Type': 'text/plain' },
        body:    item.body
      });
      /* no-cors → opaque response, treat as success */
      await _queueDeleteKey(item._id);
      sent++;
    } catch (err) {
      /* Still offline — stop, leave rest in queue */
      break;
    }
  }

  /* Notify all open clients */
  const clients = await self.clients.matchAll({ type: 'window' });
  clients.forEach(c => c.postMessage({
    type: 'SYNC_DONE',
    sent,
    remaining: items.length - sent
  }));

  return { sent, remaining: items.length - sent };
}

/* ════════════════════════════
   INSTALL — pre-cache shell
════════════════════════════ */
self.addEventListener('install', e => {
  self.skipWaiting();
  e.waitUntil(
    caches.open(CACHE_NAME).then(cache =>
      Promise.allSettled(
        SHELL_URLS.map(url =>
          cache.add(url).catch(() => {/* ignore 404 for optional URLs */})
        )
      )
    )
  );
});

/* ════════════════════════════
   ACTIVATE — prune old caches
════════════════════════════ */
self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys =>
        Promise.all(
          keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k))
        )
      )
      .then(() => clients.claim())
  );
});

/* ════════════════════════════
   FETCH — smart routing
════════════════════════════ */
self.addEventListener('fetch', e => {
  const req = e.request;
  const url = req.url;

  /* ── 1. Intercept POST to Google Apps Script (exam result) ── */
  if (req.method === 'POST' && url.includes('script.google.com')) {
    e.respondWith(
      (async () => {
        /* Clone body before consuming */
        let body = '';
        try { body = await req.clone().text(); } catch (_) {}

        try {
          /* Try sending live */
          const resp = await fetch(req.clone());
          return resp;
        } catch (_) {
          /* Offline → queue it */
          await _queueAdd({ url, body, ts: Date.now() }).catch(() => {});

          /* Register Background Sync (Chrome/Android) */
          try {
            await self.registration.sync.register(SYNC_TAG);
          } catch (_) { /* iOS/Firefox: no BackgroundSync — manual trigger used instead */ }

          /* Return 202 Accepted so the page doesn't show error */
          return new Response(JSON.stringify({ queued: true, offline: true }), {
            status:  202,
            headers: { 'Content-Type': 'application/json' }
          });
        }
      })()
    );
    return;
  }

  /* ── 2. Skip non-GET ── */
  if (req.method !== 'GET') return;

  /* ── 3. Skip cross-origin except Google Fonts ── */
  const isCrossOrigin = !url.startsWith(self.location.origin);
  const isFont = url.startsWith('https://fonts.googleapis.com') ||
                 url.startsWith('https://fonts.gstatic.com');
  if (isCrossOrigin && !isFont) return;

  /* ── 4. Navigation (HTML page) → network-first, fall to cache ── */
  if (req.mode === 'navigate') {
    e.respondWith(
      fetch(req)
        .then(res => {
          if (res.ok) {
            caches.open(CACHE_NAME).then(c => c.put(req, res.clone()));
          }
          return res;
        })
        .catch(async () => {
          const cached = await caches.match(req);
          return cached || caches.match('./') || caches.match('./index.html');
        })
    );
    return;
  }

  /* ── 5. Fonts → cache-first (never re-download) ── */
  if (isFont) {
    e.respondWith(
      caches.match(req).then(cached => {
        if (cached) return cached;
        return fetch(req).then(res => {
          if (res.ok) {
            caches.open(CACHE_NAME).then(c => c.put(req, res.clone()));
          }
          return res;
        }).catch(() => new Response('', { status: 408 }));
      })
    );
    return;
  }

  /* ── 6. All other assets → stale-while-revalidate ── */
  e.respondWith(
    caches.open(CACHE_NAME).then(cache =>
      cache.match(req).then(cached => {
        const networkFetch = fetch(req).then(res => {
          if (res && res.status === 200 && res.type !== 'opaque') {
            cache.put(req, res.clone());
          }
          return res;
        }).catch(() => cached || new Response('', { status: 408 }));

        /* Return cache immediately if available, update in background */
        return cached || networkFetch;
      })
    )
  );
});

/* ════════════════════════════
   BACKGROUND SYNC
   Chrome/Android: fires automatically when back online
════════════════════════════ */
self.addEventListener('sync', e => {
  if (e.tag === SYNC_TAG) {
    e.waitUntil(_flushQueue());
  }
});

/* ════════════════════════════
   MESSAGE HANDLER
   Page can send messages to control the SW
════════════════════════════ */
self.addEventListener('message', e => {
  /* Manual sync trigger — used when BackgroundSync not supported (iOS/Firefox) */
  if (e.data === 'SYNC_NOW') {
    _flushQueue().catch(() => {});
    return;
  }

  /* Force-update service worker */
  if (e.data === 'SKIP_WAITING') {
    self.skipWaiting();
    return;
  }

  /* Check queue count — page can ask how many pending */
  if (e.data === 'QUEUE_STATUS') {
    _queueGetAll().then(items => {
      if (e.source) {
        e.source.postMessage({ type: 'QUEUE_STATUS', count: items.length });
      }
    }).catch(() => {});
    return;
  }
});
