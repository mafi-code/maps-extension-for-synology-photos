// Popup: enable the extension for the NAS address in the current tab.
// Access is requested per host only (optional_host_permissions), and the
// content scripts are registered dynamically for exactly that host.
const $ = (id) => document.getElementById(id);
const hint = (text) => { $('hint').textContent = text; };
const scriptId = (pattern, kind) => `spm-${kind}-${pattern.replace(/[^a-z0-9]/gi, '_')}`;

// UI language: "Auto" = browser language via chrome.i18n, or a language chosen
// here. A chosen language is stored as langPack ({ lang, messages } with $1..$9
// placeholders) in chrome.storage.local; content.js and map.js follow it live.
// localStorage only mirrors it so the popup opens without flashing the wrong language.
let langPack = null;
let stateKey = null; // message key of the status text, redrawn on language change
const msg = (key, ...subs) => {
  const m = langPack && langPack.messages[key];
  if (m) return m.replace(/\$(\d)/g, (_, i) => String(subs[i - 1] ?? ''));
  return chrome.i18n.getMessage(key, subs.map(String)) || key;
};

function applyI18n() {
  document.documentElement.lang = langPack ? langPack.lang : chrome.i18n.getUILanguage();
  document.querySelectorAll('[data-i18n]').forEach((el) => { el.textContent = msg(el.dataset.i18n); });
  document.querySelectorAll('[data-i18n-title]').forEach((el) => { el.title = msg(el.dataset.i18nTitle); });
  if (stateKey) $('state').textContent = msg(stateKey);
  const current = langPack ? langPack.lang : 'auto';
  document.querySelectorAll('.seg [data-lang]').forEach((b) => b.setAttribute('aria-checked', String(b.dataset.lang === current)));
}

/** Builds { lang, messages } from _locales/<lang>/messages.json (named placeholders → $1..$9). */
async function loadLangPack(lang) {
  const raw = await (await fetch(chrome.runtime.getURL(`_locales/${lang}/messages.json`))).json();
  const messages = {};
  for (const [key, { message, placeholders = {} }] of Object.entries(raw)) {
    messages[key] = message.replace(/\$([A-Za-z0-9_]+)\$/g, (_, name) => (placeholders[name.toLowerCase()] || {}).content || '');
  }
  return { lang, messages };
}

try { langPack = JSON.parse(localStorage.getItem('spm-langpack') || 'null'); } catch (_) { /* storage blocked */ }
applyI18n();
let langChosen = false; // a click wins over the stored value that is still loading
chrome.storage.local.get('langPack').then(({ langPack: p }) => {
  if (langChosen) return;
  langPack = p || null;
  applyI18n();
}).catch(() => {});
document.querySelectorAll('.seg [data-lang]').forEach((b) => b.addEventListener('click', async () => {
  langChosen = true;
  const lang = b.dataset.lang;
  langPack = lang === 'auto' ? null : await loadLangPack(lang);
  applyI18n();
  if (langPack) await chrome.storage.local.set({ langPack });
  else await chrome.storage.local.remove('langPack');
  try { localStorage.setItem('spm-langpack', JSON.stringify(langPack)); } catch (_) { /* mirror only */ }
}));

// Theme: cyberpunk (default) or black & white. Stored in chrome.storage.local
// so the button/overlay on the Synology page (content.js) follows it live.
// localStorage only mirrors it so the popup opens without a colour flash.
function applyTheme(mono) {
  document.documentElement.dataset.theme = mono ? 'mono' : '';
  $('theme-toggle').setAttribute('aria-checked', String(mono));
}
try { applyTheme(localStorage.getItem('spm-theme') === 'mono'); } catch (_) { /* storage blocked */ }
chrome.storage.local.get('theme').then(({ theme }) => applyTheme(theme === 'mono')).catch(() => {});
$('theme-toggle').addEventListener('click', () => {
  const mono = document.documentElement.dataset.theme !== 'mono';
  const theme = mono ? 'mono' : 'cyber';
  applyTheme(mono);
  chrome.storage.local.set({ theme }).catch(() => {});
  try { localStorage.setItem('spm-theme', theme); } catch (_) { /* mirror only */ }
});

async function isEnabled(pattern) {
  const [hasPerm, scripts] = await Promise.all([
    chrome.permissions.contains({ origins: [pattern] }),
    chrome.scripting.getRegisteredContentScripts({ ids: [scriptId(pattern, 'hook')] }),
  ]);
  return hasPerm && scripts.length > 0;
}

async function unregister(pattern) {
  const ids = [scriptId(pattern, 'hook'), scriptId(pattern, 'ui')];
  const existing = await chrome.scripting.getRegisteredContentScripts({ ids });
  if (existing.length) await chrome.scripting.unregisterContentScripts({ ids: existing.map((s) => s.id) });
}

async function register(pattern) {
  await unregister(pattern);
  await chrome.scripting.registerContentScripts([
    {
      id: scriptId(pattern, 'hook'),
      matches: [pattern],
      js: ['page-hook.js'],
      world: 'MAIN',
      runAt: 'document_start',
      persistAcrossSessions: true,
    },
    {
      id: scriptId(pattern, 'ui'),
      matches: [pattern],
      js: ['content.js'],
      css: ['content.css'],
      runAt: 'document_idle',
      persistAcrossSessions: true,
    },
  ]);
}

function render(enabled) {
  stateKey = enabled ? 'popupActive' : 'popupInactive';
  $('state').textContent = msg(stateKey);
  $('state').classList.toggle('is-on', enabled);
  $('open').hidden = !enabled;
  $('disable').hidden = !enabled;
  $('enable').hidden = enabled;
}

// Locations + thumbnails are cached for 30 days in the extension's own
// IndexedDB (same origin as this popup), so the popup can wipe it.
$('clear').addEventListener('click', () => {
  const req = indexedDB.deleteDatabase('spm-cache');
  req.onsuccess = () => hint(msg('cacheCleared'));
  req.onerror = () => hint(msg('cacheClearFailed'));
  req.onblocked = () => hint(msg('cacheClearPending'));
});

(async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  let url = null;
  try { url = new URL(tab.url); } catch (_) { /* no URL access */ }

  if (!url || !/^https?:$/.test(url.protocol)) {
    stateKey = 'popupNoPage';
    $('state').textContent = msg(stateKey);
    return;
  }

  // No port in the pattern → matches the host on any port (5000/5001/443 …).
  const pattern = `${url.protocol}//${url.hostname}/*`;
  $('site').textContent = url.host;
  render(await isEnabled(pattern));

  $('enable').addEventListener('click', async () => {
    // permissions.request must run directly in the click handler.
    const granted = await chrome.permissions.request({ origins: [pattern] });
    if (!granted) {
      hint(msg('popupDenied'));
      return;
    }
    try {
      await register(pattern);
      await chrome.tabs.reload(tab.id);
      window.close();
    } catch (e) {
      hint(msg('popupEnableError', e.message));
    }
  });

  $('open').addEventListener('click', async () => {
    try {
      await chrome.tabs.sendMessage(tab.id, { type: 'spm-open' });
      window.close();
    } catch (_) {
      hint(msg('popupReloadFirst'));
    }
  });

  $('disable').addEventListener('click', async () => {
    try {
      await unregister(pattern);
      await chrome.permissions.remove({ origins: [pattern] });
      render(false);
      hint(msg('popupDisabled'));
    } catch (e) {
      hint(msg('popupError', e.message));
    }
  });
})();
