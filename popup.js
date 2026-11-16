// Popup: enable the extension for the NAS address in the current tab.
// Access is requested per host only (optional_host_permissions), and the
// content scripts are registered dynamically for exactly that host.
const $ = (id) => document.getElementById(id);
const hint = (text) => { $('hint').textContent = text; };
const scriptId = (pattern, kind) => `spm-${kind}-${pattern.replace(/[^a-z0-9]/gi, '_')}`;

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
  $('state').textContent = enabled
    ? 'Aktiv – unten rechts erscheint in Synology Photos der Button „Karte“.'
    : 'Für diese Adresse noch nicht aktiviert.';
  $('state').classList.toggle('is-on', enabled);
  $('open').hidden = !enabled;
  $('disable').hidden = !enabled;
  $('enable').hidden = enabled;
}

// Locations + thumbnails are cached for 30 days in the extension's own
// IndexedDB (same origin as this popup), so the popup can wipe it.
$('clear').addEventListener('click', () => {
  const req = indexedDB.deleteDatabase('spm-cache');
  req.onsuccess = () => hint('Cache geleert. Beim nächsten Öffnen wird alles neu von der NAS geladen.');
  req.onerror = () => hint('Cache konnte nicht geleert werden.');
  req.onblocked = () => hint('Cache wird geleert, sobald die Karte geschlossen bzw. der Tab neu geladen ist.');
});

(async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  let url = null;
  try { url = new URL(tab.url); } catch (_) { /* no URL access */ }

  if (!url || !/^https?:$/.test(url.protocol)) {
    $('state').textContent = 'Öffne zuerst Synology Photos in diesem Tab und klicke dann erneut auf die Erweiterung.';
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
      hint('Zugriff wurde nicht erlaubt.');
      return;
    }
    try {
      await register(pattern);
      await chrome.tabs.reload(tab.id);
      window.close();
    } catch (e) {
      hint(`Fehler beim Aktivieren: ${e.message}`);
    }
  });

  $('open').addEventListener('click', async () => {
    try {
      await chrome.tabs.sendMessage(tab.id, { type: 'spm-open' });
      window.close();
    } catch (_) {
      hint('Die Seite kennt die Erweiterung noch nicht – bitte einmal neu laden (F5).');
    }
  });

  $('disable').addEventListener('click', async () => {
    try {
      await unregister(pattern);
      await chrome.permissions.remove({ origins: [pattern] });
      render(false);
      hint('Deaktiviert. Seite neu laden, damit der Button verschwindet.');
    } catch (e) {
      hint(`Fehler: ${e.message}`);
    }
  });
})();
