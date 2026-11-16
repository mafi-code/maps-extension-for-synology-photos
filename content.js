// Isolated-world content script on the Synology Photos page.
// - adds a floating "Karte" button
// - loads every photo with GPS data through the Synology Photos web API
//   (same origin, same session cookie, same SynoToken as the app itself)
// - shows the map in an extension iframe and feeds it items, thumbnails and
//   map tiles; the iframe keeps a 30-day cache of locations and thumbnails
(() => {
  if (window.__spmContentLoaded) return;
  window.__spmContentLoaded = true;

  const EXT_ORIGIN = new URL(chrome.runtime.getURL('')).origin;
  const root = document.documentElement;
  const PAGE_SIZE = 500;
  const PAGE_RETRIES = 3;
  const THUMB_CONCURRENCY = 6;
  const THUMB_QUEUE_MAX = 400;

  const SPACES = [
    { name: 'personal', browseApi: 'SYNO.Foto.Browse.Item', thumbApi: 'SYNO.Foto.Thumbnail', v2: 'p' },
    { name: 'team', browseApi: 'SYNO.FotoTeam.Browse.Item', thumbApi: 'SYNO.FotoTeam.Thumbnail', v2: 't' },
  ];
  // The "gps" field is not officially documented, so we try a few variants.
  const ADDITIONAL_VARIANTS = [
    ['thumbnail', 'gps', 'address'],
    ['thumbnail', 'gps'],
    ['thumbnail', 'exif'],
  ];
  // Error codes where retrying makes no sense.
  const FATAL_CODES = new Set([102, 103, 105, 106, 107, 119]);

  const state = {
    overlay: null,
    iframe: null,
    statusEl: null,
    diagEl: null,
    frameReady: false,
    cacheAvailable: false,
    userKey: undefined, // undefined = not looked up yet, null = unknown
    items: new Map(),
    samples: [],
    scanned: 0,
    loading: false,
    loaded: false,
    thumbStrategy: null,
  };

  const apiPath = () => root.dataset.spmApiPath || '/webapi/entry.cgi';
  const apiBase = () => apiPath().replace(/\/webapi\/entry\.cgi$/, '');
  const token = () => root.dataset.spmToken || '';
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  // UI texts: language chosen in the popup (langPack in chrome.storage.local,
  // texts with $1..$9 placeholders) or else the browser language via chrome.i18n.
  let langPack = null;
  const msg = (key, ...subs) => {
    const m = langPack && langPack.messages[key];
    if (m) return m.replace(/\$(\d)/g, (_, i) => String(subs[i - 1] ?? ''));
    return chrome.i18n.getMessage(key, subs.map(String)) || key;
  };
  const uiLang = () => (langPack ? langPack.lang : chrome.i18n.getUILanguage());
  const fmtNum = (n) => n.toLocaleString(uiLang());

  class ApiError extends Error {
    constructor(api, code) {
      super(`${api}: error code ${code}`);
      this.code = code;
    }
  }

  async function callApi(api, method, version, params = {}) {
    const body = new URLSearchParams({ api, method, version: String(version) });
    for (const [k, v] of Object.entries(params)) {
      body.set(k, typeof v === 'string' ? v : JSON.stringify(v));
    }
    const headers = { 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8' };
    const t = token();
    if (t) headers['X-SYNO-TOKEN'] = t;
    const res = await fetch(apiPath(), { method: 'POST', credentials: 'same-origin', headers, body });
    if (!res.ok) throw new Error(`HTTP ${res.status} (${api})`);
    const json = await res.json();
    if (!json.success) throw new ApiError(api, json.error && json.error.code);
    return json.data;
  }

  async function withRetry(fn) {
    let lastErr = null;
    for (let attempt = 1; attempt <= PAGE_RETRIES; attempt++) {
      try {
        return await fn();
      } catch (e) {
        lastErr = e;
        if (e instanceof ApiError && FATAL_CODES.has(e.code)) throw e;
        console.warn(`[Kartenansicht] Versuch ${attempt}/${PAGE_RETRIES} fehlgeschlagen:`, e);
        if (attempt < PAGE_RETRIES) await sleep(1000 * attempt);
      }
    }
    throw lastErr;
  }

  function describeError(e) {
    const keys = {
      102: 'errApiMissing',
      105: 'errNoPermission',
      106: 'errSessionExpired',
      107: 'errSessionReplaced',
      119: 'errToken',
    };
    return (e && keys[e.code] && msg(keys[e.code])) || (e && e.message) || String(e);
  }

  // ---------- user identity (cache scope) ----------

  // The location cache is kept per NAS *and* per user, so on a shared
  // computer nobody sees another account's photo locations.
  async function getUserKey() {
    if (state.userKey !== undefined) return state.userKey;
    state.userKey = null;
    try {
      const data = await callApi('SYNO.Foto.UserInfo', 'me', 1);
      const src = (data && (data.user || data)) || {};
      const id = src.id ?? src.uid ?? src.user_id ?? src.name ?? src.username;
      if (id !== undefined && id !== null && id !== '') state.userKey = String(id);
      else console.info('[Kartenansicht] Benutzerkennung nicht gefunden in', Object.keys(src));
    } catch (e) {
      console.info('[Kartenansicht] Benutzer nicht ermittelbar – Standort-Cache aus.', e);
    }
    return state.userKey;
  }

  // ---------- GPS / item parsing ----------

  function extractGps(item) {
    const a = item.additional || {};
    const candidates = [a.gps, a.exif && a.exif.gps, item.gps, a.position];
    for (const c of candidates) {
      if (!c || typeof c !== 'object') continue;
      const lat = Number(c.latitude ?? c.lat ?? c.gps_latitude);
      const lng = Number(c.longitude ?? c.lng ?? c.lon ?? c.gps_longitude);
      if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue;
      if (lat === 0 && lng === 0) continue;
      if (Math.abs(lat) > 90 || Math.abs(lng) > 180) continue;
      return { lat, lng };
    }
    return null;
  }

  function formatAddress(addr) {
    if (!addr || typeof addr !== 'object') return '';
    const city = addr.city || addr.town || addr.village || addr.district || '';
    const parts = [city, addr.country].filter((p) => typeof p === 'string' && p);
    return parts.join(', ');
  }

  function toEntry(space, item, pos) {
    const thumb = (item.additional && item.additional.thumbnail) || {};
    return {
      key: `${space.name}:${item.id}`,
      space: space.name,
      id: item.id,
      unitId: thumb.unit_id ?? item.id,
      cacheKey: thumb.cache_key || '',
      lat: pos.lat,
      lng: pos.lng,
      name: item.filename || '',
      time: item.time || 0,
      type: item.type || 'photo',
      place: formatAddress(item.additional && item.additional.address),
    };
  }

  // ---------- Loading from the NAS ----------

  async function listPage(space, offset, additional) {
    return callApi(space.browseApi, 'list', 1, { offset, limit: PAGE_SIZE, additional });
  }

  // Returns the number of items scanned in this space.
  // Throws an error carrying `.scannedInSpace` if loading broke off midway.
  async function loadSpace(space) {
    let additional = null;
    let offset = 0;
    let scannedInSpace = 0;
    try {
      for (;;) {
        let data;
        if (additional === null) {
          let lastErr = null;
          for (const variant of ADDITIONAL_VARIANTS) {
            try {
              data = await listPage(space, offset, variant);
              additional = variant;
              break;
            } catch (e) {
              lastErr = e;
              if (!(e instanceof ApiError) || FATAL_CODES.has(e.code)) throw e;
            }
          }
          if (additional === null) throw lastErr;
          console.info('[Kartenansicht]', space.name, 'additional =', additional);
        } else {
          const at = offset;
          data = await withRetry(() => listPage(space, at, additional));
        }

        const list = (data && data.list) || [];
        // Only an empty page means "done" – the NAS may return short pages.
        if (list.length === 0) break;

        const batch = [];
        for (const item of list) {
          state.scanned++;
          scannedInSpace++;
          if (state.samples.length < 3) state.samples.push({ space: space.name, item });
          const pos = extractGps(item);
          if (!pos) continue;
          const entry = toEntry(space, item, pos);
          state.items.set(entry.key, entry);
          batch.push(entry);
        }
        if (batch.length) sendToFrame({ type: 'addItems', items: batch });
        setStatus(() => msg('statusProgress', fmtNum(state.scanned), fmtNum(state.items.size)), 'loading');
        offset += list.length;
      }
    } catch (e) {
      e.scannedInSpace = scannedInSpace;
      throw e;
    }
    return scannedInSpace;
  }

  async function loadAll() {
    if (state.loading) return;
    state.loading = true;
    state.loaded = false;
    state.items.clear();
    state.samples = [];
    state.scanned = 0;
    hideDiagnostics();
    sendToFrame({ type: 'reset' });
    setStatus(() => msg('statusLoading'), 'loading');
    const started = performance.now();

    let fatalError = null;   // personal space failed before anything loaded
    let partialError = null; // loading broke off midway → result incomplete
    for (const space of SPACES) {
      try {
        await loadSpace(space);
      } catch (e) {
        console.warn('[Kartenansicht]', space.name, e);
        if (e.scannedInSpace > 0) partialError = partialError || e;
        // An unavailable shared space (fails on the first page) is normal.
        else if (space.name === 'personal') fatalError = e;
      }
    }

    state.loading = false;
    state.loaded = true;
    const complete = !fatalError && !partialError;
    const userKey = complete && state.cacheAvailable ? await getUserKey() : null;
    sendToFrame({ type: 'done', saveUserKey: complete && state.items.size ? userKey : null });

    const n = state.items.size;
    const scanned = state.scanned;
    const secs = ((performance.now() - started) / 1000).toFixed(1);
    console.info(`[Kartenansicht] ${state.scanned} Fotos geprüft, ${n} mit Standort, ${secs}s`);
    if (fatalError && n === 0) {
      setStatus(() => msg('statusError', describeError(fatalError)), 'error');
      showDiagnostics(fatalError);
    } else if (partialError) {
      setStatus(() => msg('statusIncomplete', fmtNum(scanned), describeError(partialError), fmtNum(n)), 'error');
      showDiagnostics(partialError);
    } else if (n === 0) {
      setStatus(() => msg('statusNone', fmtNum(scanned)), 'error');
      showDiagnostics(null);
    } else {
      const noCache = state.cacheAvailable && !userKey;
      setStatus(() => msg('statusDone', fmtNum(n), fmtNum(scanned)) + (noCache ? msg('statusNoCache') : ''), 'done');
    }
  }

  // Show the cached locations if there are any (≤ 30 days old), else load.
  async function start() {
    if (state.loading || state.loaded) return;
    state.loading = true;
    let cached = null;
    try {
      const userKey = state.cacheAvailable ? await getUserKey() : null;
      if (userKey) cached = await requestFromFrame({ type: 'cacheGet', userKey });
    } catch (e) {
      console.warn('[Kartenansicht] Cache nicht lesbar', e);
    }
    state.loading = false;

    if (cached && Array.isArray(cached.items) && cached.items.length) {
      state.items = new Map(cached.items.map((it) => [it.key, it]));
      state.loaded = true;
      sendToFrame({ type: 'reset' });
      sendToFrame({ type: 'addItems', items: cached.items });
      sendToFrame({ type: 'done' });
      const count = cached.items.length;
      setStatus(() => msg('statusCached', fmtNum(count), new Date(cached.savedAt).toLocaleDateString(uiLang())), 'done');
      return;
    }
    await loadAll();
  }

  // ---------- Thumbnails ----------

  const withToken = (url) => {
    const t = token();
    return t ? `${url}&SynoToken=${encodeURIComponent(t)}` : url;
  };

  // Different DSM / Synology Photos versions use different thumbnail URLs.
  // The first strategy that returns an image is remembered.
  const THUMB_STRATEGIES = [
    (it, space, size) => `${apiPath()}?${new URLSearchParams({
      api: space.thumbApi, method: 'get', version: '2',
      id: String(it.unitId), cache_key: it.cacheKey, type: 'unit', size,
    })}`,
    (it, space, size) => `${apiBase()}/synofoto/api/v2/${space.v2}/Thumbnail/get?${new URLSearchParams({
      id: String(it.unitId), cache_key: JSON.stringify(it.cacheKey), type: '"unit"', size: JSON.stringify(size),
    })}`,
    (it, space, size) => `${apiPath()}?${new URLSearchParams({
      api: JSON.stringify(space.thumbApi), method: '"get"', version: '2',
      id: String(it.unitId), cache_key: JSON.stringify(it.cacheKey), type: '"unit"', size: JSON.stringify(size),
    })}`,
  ];

  async function fetchThumb({ key, size }) {
    const it = state.items.get(key);
    if (!it) throw new Error('unknown photo');
    const space = SPACES.find((s) => s.name === it.space);
    if (!space) throw new Error('unknown space');
    const order = state.thumbStrategy === null ? THUMB_STRATEGIES.map((_, i) => i) : [state.thumbStrategy];
    const t = token();
    for (const i of order) {
      const url = withToken(THUMB_STRATEGIES[i](it, space, size));
      try {
        const res = await fetch(url, { credentials: 'same-origin', headers: t ? { 'X-SYNO-TOKEN': t } : {} });
        const ct = res.headers.get('content-type') || '';
        if (res.ok && ct.startsWith('image/')) {
          if (state.thumbStrategy === null) {
            state.thumbStrategy = i;
            console.info('[Kartenansicht] Thumbnail-Variante', i);
          }
          return await res.blob();
        }
      } catch (_) { /* try next strategy */ }
    }
    throw new Error('thumbnail unavailable');
  }

  const thumbQueue = [];
  let thumbActive = 0;

  function requestThumb(key, size) {
    thumbQueue.push({ key, size });
    while (thumbQueue.length > THUMB_QUEUE_MAX) {
      const dropped = thumbQueue.shift();
      sendToFrame({ type: 'thumbDropped', key: dropped.key, size: dropped.size });
    }
    pumpThumbs();
  }

  function pumpThumbs() {
    while (thumbActive < THUMB_CONCURRENCY && thumbQueue.length) {
      // LIFO: what the user looks at right now comes first.
      const job = thumbQueue.pop();
      thumbActive++;
      fetchThumb(job)
        .then((blob) => sendToFrame({ type: 'thumb', key: job.key, size: job.size, blob }))
        .catch(() => sendToFrame({ type: 'thumbError', key: job.key, size: job.size }))
        .finally(() => {
          thumbActive--;
          pumpThumbs();
        });
    }
  }

  // ---------- Map tiles ----------
  // OpenStreetMap blocks tile requests without a Referer (as sent from the
  // extension iframe). Fetched from here, the Referer is the NAS address.

  const TILE_PREFIX = 'https://tile.openstreetmap.org/';
  const TILE_CONCURRENCY = 6;
  const tileQueue = [];
  let tileActive = 0;
  let tileFailures = 0;

  function requestTile(id, url) {
    if (typeof url !== 'string' || !url.startsWith(TILE_PREFIX)) {
      sendToFrame({ type: 'tileError', id });
      return;
    }
    tileQueue.push({ id, url });
    pumpTiles();
  }

  function cancelTile(id) {
    const i = tileQueue.findIndex((job) => job.id === id);
    if (i >= 0) tileQueue.splice(i, 1);
  }

  function pumpTiles() {
    while (tileActive < TILE_CONCURRENCY && tileQueue.length) {
      const job = tileQueue.shift();
      tileActive++;
      fetch(job.url, { mode: 'cors', credentials: 'omit', referrerPolicy: 'strict-origin-when-cross-origin' })
        .then((res) => {
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          return res.blob();
        })
        .then((blob) => sendToFrame({ type: 'tile', id: job.id, blob }))
        .catch((e) => {
          if (++tileFailures === 5) console.warn('[Kartenansicht] Kartenkacheln laden nicht:', e);
          sendToFrame({ type: 'tileError', id: job.id });
        })
        .finally(() => {
          tileActive--;
          pumpTiles();
        });
    }
  }

  // ---------- Frame messaging ----------

  // Tile requests arrive before "ready", so tile replies must not wait for it.
  function sendToFrame(msg) {
    if (!state.iframe || !state.iframe.contentWindow) return;
    if (!state.frameReady && msg.type !== 'tile' && msg.type !== 'tileError') return; // items are re-sent on "ready"
    state.iframe.contentWindow.postMessage({ spm: true, ...msg }, EXT_ORIGIN);
  }

  let reqSeq = 0;
  const pendingReqs = new Map();

  function requestFromFrame(msg, timeoutMs = 8000) {
    return new Promise((resolve) => {
      const reqId = ++reqSeq;
      pendingReqs.set(reqId, resolve);
      sendToFrame({ ...msg, reqId });
      setTimeout(() => {
        if (pendingReqs.delete(reqId)) resolve(null);
      }, timeoutMs);
    });
  }

  window.addEventListener('message', (ev) => {
    if (!state.iframe || ev.source !== state.iframe.contentWindow || ev.origin !== EXT_ORIGIN) return;
    const msg = ev.data;
    if (!msg || !msg.spm) return;
    switch (msg.type) {
      case 'ready':
        state.frameReady = true;
        state.cacheAvailable = Boolean(msg.cache);
        if (state.items.size) {
          sendToFrame({ type: 'reset' });
          sendToFrame({ type: 'addItems', items: [...state.items.values()] });
          if (state.loaded) sendToFrame({ type: 'done' });
        } else if (!state.loading) {
          start();
        }
        break;
      case 'reply': {
        const resolve = pendingReqs.get(msg.reqId);
        if (resolve) {
          pendingReqs.delete(msg.reqId);
          resolve(msg.data);
        }
        break;
      }
      case 'thumb':
        requestThumb(msg.key, msg.size);
        break;
      case 'tile':
        requestTile(msg.id, msg.url);
        break;
      case 'tileCancel':
        cancelTile(msg.id);
        break;
      default:
        break;
    }
  });

  // ---------- UI ----------

  // render: () => text, so the status can be redrawn when the language changes.
  // kind: 'loading' | 'done' | 'error' – also exposed as data-state for tests.
  function setStatus(render, kind) {
    state.statusRender = render;
    state.statusKind = kind;
    drawStatus();
  }

  function drawStatus() {
    if (!state.statusEl || !state.statusRender) return;
    const text = state.statusRender();
    state.statusEl.textContent = text;
    state.statusEl.title = text;
    state.statusEl.dataset.state = state.statusKind;
    state.statusEl.classList.toggle('is-error', state.statusKind === 'error');
  }

  /** (Re)applies all texts of button and overlay – on creation and on language change. */
  function labelUI() {
    const btn = document.querySelector('.spm-launcher');
    if (btn) {
      btn.title = msg('openMapTitle');
      btn.querySelector('span').textContent = msg('mapButton');
    }
    const ov = state.overlay;
    if (ov) {
      ov.setAttribute('aria-label', msg('mapTitle'));
      ov.querySelector('.spm-title').textContent = msg('mapButton');
      ov.querySelector('.spm-reload').textContent = msg('reload');
      ov.querySelector('.spm-close').setAttribute('aria-label', msg('close'));
      ov.querySelector('.spm-close').title = msg('closeEsc');
      ov.querySelector('.spm-diag-title').textContent = msg('diagTitle');
      ov.querySelector('.spm-diag-text').textContent = msg('diagText');
      ov.querySelector('.spm-copy').textContent = msg('copy');
      ov.querySelector('.spm-frame').title = msg('mapTitle');
    }
    drawStatus();
  }

  function showDiagnostics(error) {
    if (!state.diagEl) return;
    const info = {
      hint: msg('diagHint'),
      version: chrome.runtime.getManifest().version,
      apiPath: apiPath(),
      tokenFound: Boolean(token()),
      error: error ? describeError(error) : null,
      errorCode: error && error.code !== undefined ? error.code : null,
      checked: state.scanned,
      withLocation: state.items.size,
      samples: state.samples,
    };
    state.diagEl.querySelector('pre').textContent = JSON.stringify(info, null, 2).slice(0, 8000);
    state.diagEl.hidden = false;
    console.info('[Kartenansicht] Diagnose', info);
  }

  function hideDiagnostics() {
    if (state.diagEl) state.diagEl.hidden = true;
  }

  function ensureOverlay() {
    if (state.overlay) return;
    const ov = document.createElement('div');
    ov.className = 'spm-overlay';
    ov.hidden = true;
    ov.setAttribute('role', 'dialog');
    ov.innerHTML = `
      <div class="spm-bar">
        <strong class="spm-title"></strong>
        <span class="spm-status" aria-live="polite"></span>
        <button type="button" class="spm-btn spm-reload"></button>
        <button type="button" class="spm-btn spm-close">✕</button>
      </div>
      <div class="spm-diag" hidden>
        <strong class="spm-diag-title"></strong> <span class="spm-diag-text"></span>
        <pre></pre>
        <button type="button" class="spm-btn spm-copy"></button>
      </div>
      <iframe class="spm-frame"></iframe>`;
    document.body.appendChild(ov);

    state.overlay = ov;
    state.statusEl = ov.querySelector('.spm-status');
    state.diagEl = ov.querySelector('.spm-diag');
    state.iframe = ov.querySelector('.spm-frame');
    labelUI();

    ov.querySelector('.spm-close').addEventListener('click', closeOverlay);
    ov.querySelector('.spm-reload').addEventListener('click', () => loadAll());
    ov.querySelector('.spm-copy').addEventListener('click', async (e) => {
      try {
        await navigator.clipboard.writeText(state.diagEl.querySelector('pre').textContent);
        e.target.textContent = msg('copied');
      } catch (_) {
        e.target.textContent = msg('copyManual');
      }
    });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && state.overlay && !state.overlay.hidden) closeOverlay();
    });

    state.iframe.src = chrome.runtime.getURL('map.html');
    applyTheme();
  }

  function openOverlay() {
    ensureOverlay();
    state.overlay.hidden = false;
    if (state.frameReady && !state.loaded && !state.loading) start();
  }

  function closeOverlay() {
    if (state.overlay) state.overlay.hidden = true;
  }

  function looksLikePhotos() {
    return /SYNO\.Foto/i.test(location.href)
      || /^\/photo(\/|$)/i.test(location.pathname)
      || /Synology Photos/i.test(document.title);
  }

  function ensureLauncher() {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'spm-launcher';
    btn.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 2a7 7 0 0 0-7 7c0 5.25 7 13 7 13s7-7.75 7-13a7 7 0 0 0-7-7zm0 9.5A2.5 2.5 0 1 1 12 6.5a2.5 2.5 0 0 1 0 5z"/></svg><span></span>';
    btn.addEventListener('click', openOverlay);
    document.body.appendChild(btn);
    labelUI();
    applyTheme();
    const update = () => { btn.hidden = !looksLikePhotos(); };
    update();
    setInterval(update, 2000);
  }

  // ---------- Theme (cyberpunk / black & white, set in the popup) ----------

  let monoTheme = false;
  function applyTheme() {
    document.querySelectorAll('.spm-launcher, .spm-overlay')
      .forEach((el) => el.classList.toggle('spm-mono', monoTheme));
  }
  // Theme and language are chosen in the popup and apply live.
  chrome.storage.local.get(['theme', 'langPack'])
    .then(({ theme, langPack: pack }) => {
      monoTheme = theme === 'mono';
      langPack = pack || null;
      applyTheme();
      labelUI();
    })
    .catch(() => { /* defaults */ });
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    if (changes.theme) {
      monoTheme = changes.theme.newValue === 'mono';
      applyTheme();
    }
    if (changes.langPack) {
      langPack = changes.langPack.newValue || null;
      labelUI();
    }
  });

  chrome.runtime.onMessage.addListener((message, _sender, reply) => {
    if (message && message.type === 'spm-open') {
      openOverlay();
      reply({ ok: true });
    }
  });

  ensureLauncher();
})();
