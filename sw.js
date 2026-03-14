const CACHE_NAME = 'ep-v6';
const SYNC_TAG   = 'ep-result-sync';
const SYNC_DB    = 'ep_sw_sync';
const SYNC_STORE = 'queue';

function _idb() {
  return new Promise(function(res, rej) {
    var r = indexedDB.open(SYNC_DB, 1);
    r.onupgradeneeded = function(e) {
      var db = e.target.result;
      if (!db.objectStoreNames.contains(SYNC_STORE))
        db.createObjectStore(SYNC_STORE, { autoIncrement: true, keyPath: '_id' });
    };
    r.onsuccess = function(e) { res(e.target.result); };
    r.onerror   = function()  { rej(); };
  });
}
function _qAdd(payload) {
  return _idb().then(function(db) {
    return new Promise(function(res, rej) {
      var tx = db.transaction(SYNC_STORE, 'readwrite');
      tx.objectStore(SYNC_STORE).add(payload);
      tx.oncomplete = res; tx.onerror = rej;
    });
  });
}
function _qAll() {
  return _idb().then(function(db) {
    return new Promise(function(res, rej) {
      var tx  = db.transaction(SYNC_STORE, 'readonly');
      var req = tx.objectStore(SYNC_STORE).getAll();
      req.onsuccess = function() { res(req.result || []); };
      req.onerror   = rej;
    });
  });
}
function _qDel(key) {
  return _idb().then(function(db) {
    return new Promise(function(res, rej) {
      var tx = db.transaction(SYNC_STORE, 'readwrite');
      tx.objectStore(SYNC_STORE).delete(key);
      tx.oncomplete = res; tx.onerror = rej;
    });
  });
}
function _flush() {
  return _qAll().then(function(items) {
    if (!items.length) return;
    var chain = Promise.resolve();
    items.forEach(function(item) {
      chain = chain.then(function() {
        return fetch(item.url, {
          method: 'POST', mode: 'no-cors',
          headers: { 'Content-Type': 'text/plain' },
          body: item.body
        }).then(function() { return _qDel(item._id); });
      });
    });
    return chain.then(function() {
      return self.clients.matchAll({ type: 'window' }).then(function(cs) {
        cs.forEach(function(c) { c.postMessage({ type: 'SYNC_DONE', sent: items.length }); });
      });
    });
  }).catch(function(){});
}

self.addEventListener('install', function(e) {
  self.skipWaiting();
  e.waitUntil(
    caches.open(CACHE_NAME).then(function(cache) {
      return Promise.allSettled
        ? Promise.allSettled(['./','./index.html','./ExamPortal.html','./manifest.json'].map(function(u){return cache.add(u).catch(function(){});}))
        : cache.addAll(['./','./index.html']).catch(function(){});
    })
  );
});

self.addEventListener('activate', function(e) {
  e.waitUntil(
    caches.keys().then(function(keys) {
      return Promise.all(keys.filter(function(k){return k!==CACHE_NAME;}).map(function(k){return caches.delete(k);}));
    }).then(function() { return clients.claim(); })
  );
});

self.addEventListener('fetch', function(e) {
  var req = e.request;
  var url = req.url;
  if (req.method === 'POST' && url.indexOf('script.google.com') !== -1) {
    e.respondWith(
      req.clone().text().then(function(body) {
        return fetch(req.clone()).catch(function() {
          return _qAdd({ url: url, body: body, ts: Date.now() }).then(function() {
            try { self.registration.sync.register(SYNC_TAG).catch(function(){}); } catch(x){}
            return new Response(JSON.stringify({ queued: true }), {
              status: 202, headers: { 'Content-Type': 'application/json' }
            });
          });
        });
      })
    );
    return;
  }
  if (req.method !== 'GET') return;
  var isFont = url.indexOf('fonts.googleapis.com') !== -1 || url.indexOf('fonts.gstatic.com') !== -1;
  var isSameOrigin = url.indexOf(self.location.origin) === 0;
  if (!isSameOrigin && !isFont) return;
  if (req.mode === 'navigate') {
    e.respondWith(
      fetch(req).then(function(res) {
        if (res.ok) caches.open(CACHE_NAME).then(function(c){c.put(req,res.clone());});
        return res;
      }).catch(function() {
        return caches.match(req).then(function(r) {
          return r || caches.match('./') || caches.match('./index.html');
        });
      })
    );
    return;
  }
  e.respondWith(
    caches.open(CACHE_NAME).then(function(cache) {
      return cache.match(req).then(function(cached) {
        var fresh = fetch(req).then(function(res) {
          if (res && res.status === 200 && res.type !== 'opaque') cache.put(req, res.clone());
          return res;
        }).catch(function() { return cached || new Response('', {status:408}); });
        return cached || fresh;
      });
    })
  );
});

self.addEventListener('sync', function(e) {
  if (e.tag === SYNC_TAG) e.waitUntil(_flush());
});

self.addEventListener('message', function(e) {
  if (e.data === 'SYNC_NOW')     { _flush(); return; }
  if (e.data === 'SKIP_WAITING') { self.skipWaiting(); return; }
  if (e.data === 'QUEUE_STATUS') {
    _qAll().then(function(items) {
      if (e.source) e.source.postMessage({ type: 'QUEUE_STATUS', count: items.length });
    }).catch(function(){});
  }
});
