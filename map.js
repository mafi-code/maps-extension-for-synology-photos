// Map UI. Runs as an extension page inside an iframe on the Synology Photos page.
// Receives photo items + thumbnail blobs from content.js via postMessage and
// keeps a 30-day cache (locations + thumbnails) in the extension's IndexedDB.
(() => {
  const parentWin = window.parent;
  // Origin of the embedding page (the NAS). Can't be spoofed by the parent.
  const parentOrigin = (location.ancestorOrigins && location.ancestorOrigins[0]) || '';
  const send = (msg) => parentWin.postMessage({ spm: true, ...msg }, parentOrigin || '*');

  // Theme chosen in the popup (only affects marker badges here).
  if (typeof chrome !== 'undefined' && chrome.storage) {
    const setTheme = (t) => { document.documentElement.dataset.theme = t === 'mono' ? 'mono' : ''; };
    chrome.storage.local.get('theme').then(({ theme }) => setTheme(theme)).catch(() => {});
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area === 'local' && changes.theme) setTheme(changes.theme.newValue);
    });
  }

  // Language: chosen in the popup (langPack) or the browser UI language.
  // Only affects the date format in the photo popup.
  const hasChrome = typeof chrome !== 'undefined' && chrome.i18n && chrome.storage;
  let langPack = null;
  const uiLang = () => (langPack ? langPack.lang : hasChrome ? chrome.i18n.getUILanguage() : navigator.language);
  const applyLang = () => {
    document.documentElement.lang = uiLang();
    const title = langPack ? langPack.messages.mapTitle : hasChrome && chrome.i18n.getMessage('mapTitle');
    if (title) document.title = title;
  };
  applyLang();
  if (hasChrome) {
    chrome.storage.local.get('langPack').then(({ langPack: p }) => { langPack = p || null; applyLang(); }).catch(() => {});
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area === 'local' && changes.langPack) { langPack = changes.langPack.newValue || null; applyLang(); }
    });
  }

  const MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
  const CACHED_THUMB_SIZES = new Set(['sm', 'm']); // xl previews are big – not cached
  let trusted = false;
  let cacheEnabled = false;

  // ---------- IndexedDB cache ----------

  let dbPromise = null;

  function openDb() {
    if (!dbPromise) {
      dbPromise = new Promise((resolve) => {
        const req = indexedDB.open('spm-cache', 1);
        req.onupgradeneeded = () => {
          const db = req.result;
          db.createObjectStore('locations', { keyPath: 'scope' });
          db.createObjectStore('thumbs', { keyPath: 'id' }).createIndex('savedAt', 'savedAt');
        };
        req.onsuccess = () => {
          const db = req.result;
          // Let the popup's "Cache leeren" (deleteDatabase) go through.
          db.onversionchange = () => {
            db.close();
            dbPromise = null;
          };
          resolve(db);
        };
        req.onerror = () => resolve(null);
        req.onblocked = () => resolve(null);
      });
    }
    return dbPromise;
  }

  async function idbRun(storeName, mode, op) {
    if (!cacheEnabled) return null;
    const db = await openDb();
    if (!db) return null;
    return new Promise((resolve) => {
      try {
        const tx = db.transaction(storeName, mode);
        const req = op(tx.objectStore(storeName));
        tx.oncomplete = () => resolve(req ? req.result : null);
        tx.onerror = () => resolve(null);
        tx.onabort = () => resolve(null);
      } catch (_) {
        resolve(null);
      }
    });
  }

  const fresh = (rec) => rec && Date.now() - rec.savedAt < MAX_AGE_MS;
  const scopeFor = (userKey) => `${parentOrigin}|${userKey}`;

  const Cache = {
    async getLocations(userKey) {
      const rec = await idbRun('locations', 'readonly', (s) => s.get(scopeFor(userKey)));
      return fresh(rec) ? rec : null;
    },
    putLocations(userKey, list) {
      return idbRun('locations', 'readwrite', (s) => s.put({ scope: scopeFor(userKey), savedAt: Date.now(), items: list }));
    },
    async getThumb(id) {
      const rec = await idbRun('thumbs', 'readonly', (s) => s.get(id));
      return fresh(rec) ? rec.blob : null;
    },
    putThumb(id, blob) {
      return idbRun('thumbs', 'readwrite', (s) => s.put({ id, blob, savedAt: Date.now() }));
    },
    purgeExpired() {
      const limit = Date.now() - MAX_AGE_MS;
      const sweep = (cursorReq, isExpired) => {
        cursorReq.onsuccess = () => {
          const cur = cursorReq.result;
          if (!cur) return;
          if (isExpired(cur.value)) cur.delete();
          cur.continue();
        };
      };
      idbRun('thumbs', 'readwrite', (s) => {
        sweep(s.index('savedAt').openCursor(IDBKeyRange.upperBound(limit)), () => true);
      });
      idbRun('locations', 'readwrite', (s) => {
        sweep(s.openCursor(), (v) => v.savedAt < limit);
      });
    },
  };

  // ---------- map + tiles ----------

  // maxZoom must be set on the map itself: markercluster needs it, and the
  // tile layer (which would otherwise provide it) is only added at startup.
  const map = L.map('map', { worldCopyJump: true, maxZoom: 19 }).setView([50, 10], 4);

  // tile.openstreetmap.org blocks image requests from extension pages because
  // they carry no Referer. So tiles are fetched by content.js on the Synology
  // page (Referer = NAS address) and handed back here as blobs.
  const pendingTiles = new Map(); // id -> { img, done }
  let tileSeq = 0;

  const ProxyTileLayer = L.TileLayer.extend({
    createTile(coords, done) {
      const img = document.createElement('img');
      img.alt = '';
      img.setAttribute('role', 'presentation');
      const id = ++tileSeq;
      img.dataset.tileId = String(id);
      pendingTiles.set(id, { img, done });
      send({ type: 'tile', id, url: this.getTileUrl(coords) });
      return img;
    },
  });

  const tiles = new ProxyTileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19,
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a>',
  });
  tiles.on('tileunload tileabort', (e) => {
    const id = Number(e.tile.dataset.tileId);
    if (pendingTiles.delete(id)) send({ type: 'tileCancel', id });
  });
  // tiles.addTo(map) happens at startup, once the embedding page is verified.

  function onTile(id, blob) {
    const entry = pendingTiles.get(id);
    if (!entry) return;
    pendingTiles.delete(id);
    const url = URL.createObjectURL(blob);
    entry.img.onload = () => {
      URL.revokeObjectURL(url);
      entry.done(null, entry.img);
    };
    entry.img.onerror = () => {
      URL.revokeObjectURL(url);
      entry.done(new Error('tile decode failed'), entry.img);
    };
    entry.img.src = url;
  }

  function onTileError(id) {
    const entry = pendingTiles.get(id);
    if (!entry) return;
    pendingTiles.delete(id);
    entry.done(new Error('tile load failed'), entry.img);
  }

  const items = new Map();       // key -> item
  const thumbs = new Map();      // "key|size" -> objectURL | 'error'
  const requested = new Set();   // "key|size" currently requested
  let userInteracted = false;
  let fittedOnce = false;

  map.getContainer().addEventListener('pointerdown', () => { userInteracted = true; });
  map.getContainer().addEventListener('wheel', () => { userInteracted = true; }, { passive: true });

  // ---------- thumbnails ----------

  const thumbId = (key, size) => `${key}|${size}`;

  // cache_key changes whenever Synology regenerates a thumbnail,
  // so edited photos automatically get a new cache entry.
  function thumbCacheId(key, size) {
    if (!cacheEnabled || !CACHED_THUMB_SIZES.has(size)) return null;
    const it = items.get(key);
    if (!it || !it.cacheKey) return null;
    return `${parentOrigin}|${it.space}:${it.unitId}|${it.cacheKey}|${size}`;
  }

  function thumbSrc(key, size) {
    const v = thumbs.get(thumbId(key, size));
    return v && v !== 'error' ? v : '';
  }

  function ensureThumb(key, size) {
    const id = thumbId(key, size);
    if (thumbs.has(id) || requested.has(id)) return;
    requested.add(id);
    const cid = thumbCacheId(key, size);
    if (!cid) {
      send({ type: 'thumb', key, size });
      return;
    }
    Cache.getThumb(cid).then((blob) => {
      if (blob) onThumb(key, size, blob, true);
      else send({ type: 'thumb', key, size });
    });
  }

  function applyImg(img) {
    const { thumb: key, size } = img.dataset;
    const src = thumbSrc(key, size);
    const box = img.parentElement;
    if (src) {
      if (img.getAttribute('src') !== src) img.src = src;
      box && box.classList.remove('is-loading');
    } else if (thumbs.get(thumbId(key, size)) === 'error') {
      box && box.classList.remove('is-loading');
      box && box.classList.add('is-broken');
    }
  }

  function hydrate(el) {
    if (!el) return;
    el.querySelectorAll('img[data-thumb]').forEach((img) => {
      applyImg(img);
      if (!thumbSrc(img.dataset.thumb, img.dataset.size)) ensureThumb(img.dataset.thumb, img.dataset.size);
    });
  }

  function imgsFor(key, size) {
    return document.querySelectorAll(`img[data-thumb="${CSS.escape(key)}"][data-size="${size}"]`);
  }

  function onThumb(key, size, blob, fromCache = false) {
    const id = thumbId(key, size);
    requested.delete(id);
    if (!thumbs.has(id)) thumbs.set(id, URL.createObjectURL(blob));
    imgsFor(key, size).forEach(applyImg);
    if (!fromCache) {
      const cid = thumbCacheId(key, size);
      if (cid) Cache.putThumb(cid, blob);
    }
  }

  function onThumbError(key, size) {
    const id = thumbId(key, size);
    requested.delete(id);
    thumbs.set(id, 'error');
    // Large preview missing → fall back to a smaller size.
    const fallback = { xl: 'm', m: 'sm' }[size];
    imgsFor(key, size).forEach((img) => {
      if (fallback) {
        img.dataset.size = fallback;
        if (thumbSrc(key, fallback)) applyImg(img);
        else ensureThumb(key, fallback);
      } else {
        applyImg(img);
      }
    });
  }

  // ---------- markers ----------

  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  function iconHtml(item, count) {
    const src = thumbSrc(item.key, 'sm');
    const badge = count > 1 ? `<span class="spm-count">${count > 9999 ? '9999+' : count}</span>` : '';
    return `<div class="spm-thumb${src ? '' : ' is-loading'}">`
      + `<img data-thumb="${esc(item.key)}" data-size="sm" alt=""${src ? ` src="${src}"` : ''}>`
      + `</div>${badge}`;
  }

  // Newest photo represents a cluster.
  function representative(markers) {
    let best = markers[0].options.item;
    for (const m of markers) if (m.options.item.time > best.time) best = m.options.item;
    return best;
  }

  const cluster = L.markerClusterGroup({
    showCoverageOnHover: false,
    maxClusterRadius: 70,
    spiderfyOnMaxZoom: true,
    chunkedLoading: true,
    iconCreateFunction(c) {
      const rep = representative(c.getAllChildMarkers());
      ensureThumb(rep.key, 'sm');
      return L.divIcon({
        html: iconHtml(rep, c.getChildCount()),
        className: 'spm-icon spm-icon--cluster',
        iconSize: [64, 64],
      });
    },
  });
  map.addLayer(cluster);

  function formatDate(seconds) {
    if (!seconds) return '';
    // Synology stores the capture time as local time encoded as UTC.
    return new Date(seconds * 1000).toLocaleString(uiLang(), {
      timeZone: 'UTC', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit',
    });
  }

  function popupContent(item) {
    const wrap = document.createElement('div');
    wrap.className = 'spm-popup';

    const box = document.createElement('div');
    box.className = 'spm-popup-img is-loading';
    const img = document.createElement('img');
    img.alt = item.name;
    const xl = thumbSrc(item.key, 'xl');
    img.dataset.thumb = item.key;
    img.dataset.size = 'xl';
    if (xl) {
      img.src = xl;
      box.classList.remove('is-loading');
    } else {
      const sm = thumbSrc(item.key, 'sm');
      if (sm) img.src = sm; // instant low-res placeholder
      ensureThumb(item.key, 'xl');
    }
    box.appendChild(img);
    wrap.appendChild(box);

    const meta = document.createElement('div');
    meta.className = 'spm-popup-meta';
    const name = document.createElement('div');
    name.className = 'spm-popup-name';
    name.textContent = item.name;
    meta.appendChild(name);
    const sub = [formatDate(item.time), item.place].filter(Boolean).join(' · ');
    if (sub) {
      const s = document.createElement('div');
      s.className = 'spm-popup-sub';
      s.textContent = sub;
      meta.appendChild(s);
    }
    wrap.appendChild(meta);
    return wrap;
  }

  function makeMarker(item) {
    const m = L.marker([item.lat, item.lng], {
      icon: L.divIcon({ html: iconHtml(item, 1), className: 'spm-icon', iconSize: [52, 52] }),
      title: item.name,
      item,
    });
    m.on('add', () => hydrate(m.getElement()));
    m.bindPopup(() => popupContent(item), { maxWidth: 380, minWidth: 260, className: 'spm-leaflet-popup' });
    return m;
  }

  // Bounds from the item list, not cluster.getBounds(): with chunkedLoading the
  // cluster may not contain all markers yet when "done" arrives.
  function fitAll() {
    if (!items.size) return;
    const b = L.latLngBounds([...items.values()].map((it) => [it.lat, it.lng]));
    if (b.isValid()) map.fitBounds(b, { padding: [40, 40], maxZoom: 14 });
  }

  // ---------- messages from content.js ----------

  window.addEventListener('message', (ev) => {
    if (!trusted || ev.source !== parentWin) return;
    if (parentOrigin && ev.origin !== parentOrigin) return;
    const msg = ev.data;
    if (!msg || !msg.spm) return;
    switch (msg.type) {
      case 'reset':
        cluster.clearLayers();
        items.clear();
        fittedOnce = false;
        userInteracted = false;
        break;
      case 'addItems': {
        const markers = [];
        for (const it of msg.items) {
          if (items.has(it.key)) continue;
          items.set(it.key, it);
          markers.push(makeMarker(it));
        }
        cluster.addLayers(markers);
        if (!fittedOnce && items.size) {
          fittedOnce = true;
          fitAll();
        }
        break;
      }
      case 'done':
        if (items.size && !userInteracted) fitAll();
        if (msg.saveUserKey && items.size) Cache.putLocations(msg.saveUserKey, [...items.values()]);
        break;
      case 'cacheGet':
        Cache.getLocations(msg.userKey).then((rec) => {
          send({ type: 'reply', reqId: msg.reqId, data: rec ? { items: rec.items, savedAt: rec.savedAt } : null });
        });
        break;
      case 'thumb':
        onThumb(msg.key, msg.size, msg.blob);
        break;
      case 'thumbError':
        onThumbError(msg.key, msg.size);
        break;
      case 'thumbDropped':
        requested.delete(thumbId(msg.key, msg.size));
        break;
      case 'tile':
        onTile(msg.id, msg.blob);
        break;
      case 'tileError':
        onTileError(msg.id);
        break;
      default:
        break;
    }
  });

  // ---------- startup ----------
  // Only talk to pages the user enabled the extension for. map.html is
  // web-accessible, so any site could embed it – those get nothing.
  (async () => {
    let allowed = true;
    if (typeof chrome !== 'undefined' && chrome.permissions && parentOrigin) {
      try {
        const u = new URL(parentOrigin);
        allowed = await chrome.permissions.contains({ origins: [`${u.protocol}//${u.hostname}/*`] });
      } catch (_) {
        allowed = false;
      }
      cacheEnabled = allowed && typeof indexedDB !== 'undefined';
    }
    if (!allowed) return;
    trusted = true;
    tiles.addTo(map);
    if (cacheEnabled) Cache.purgeExpired();
    send({ type: 'ready', cache: cacheEnabled });
  })();
})();
