// End-to-end test of the extension against a fake Synology Photos (headless Edge).
// Usage: npm test        (VERBOSE=1 shows console output of the extension)
import { createMockSynology, launchBrowser, makeTestExtension, waitFor, sleep } from './harness.mjs';

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok });
  console.log(`  ${ok ? '✔' : '✘'} ${name}${detail ? ` – ${detail}` : ''}`);
};

const item = (id) => {
  const additional = { thumbnail: { cache_key: `${id}_1700000000`, unit_id: id, sm: 'ready', m: 'ready', xl: 'ready' } };
  if (id % 3 !== 0) { // two thirds have a location
    additional.gps = { latitude: 48 + (id % 50) * 0.05, longitude: 11 + (id % 37) * 0.07 };
    additional.address = { city: 'München', country: 'Deutschland' };
  }
  return { id, filename: `IMG_${id}.jpg`, time: 1700000000 + id * 60, type: 'photo', additional };
};
const makeItems = (n) => Array.from({ length: n }, (_, i) => item(i + 1));
const thumb = (id) => `<svg xmlns="http://www.w3.org/2000/svg" width="120" height="120"><rect width="120" height="120" fill="hsl(${(id * 47) % 360},60%,55%)"/></svg>`;
const fmt = (n) => n.toLocaleString('de-DE');

async function scenario(title, { total, flaky = false, port, reload = false, lang = 'de-DE' }, verify) {
  console.log(`\n${title}`);
  const mock = createMockSynology({ items: makeItems(total), thumb, flaky });
  await mock.listen(port);
  const cdp = await launchBrowser({ extDir: makeTestExtension(), port: port + 1000, lang });
  // final states ("done" / "error") come from content.js as data-state – language independent
  const statusOf = (page) => cdp.evaluate(page, `(() => { const s = document.querySelector('.spm-status');
    return s && /^(done|error)$/.test(s.dataset.state || '') ? s.textContent : ''; })()`);
  const openMap = async () => {
    const page = await cdp.openPage(`http://127.0.0.1:${port}/`);
    await waitFor(() => cdp.evaluate(page, `!!document.querySelector('.spm-launcher')`).catch(() => false));
    return page;
  };
  try {
    let page = await openMap();
    await verify.beforeOpen?.(cdp, page);
    await cdp.evaluate(page, `document.querySelector('.spm-launcher').click()`);
    const status = await waitFor(() => statusOf(page), { timeoutMs: 60000 });
    await verify.afterLoad(status, mock, cdp, page);

    if (reload) {
      const listCallsBefore = mock.calls.filter((c) => c.method === 'list').length;
      await cdp.send('Page.reload', {}, page);
      await sleep(1500);
      await waitFor(() => cdp.evaluate(page, `!!document.querySelector('.spm-launcher')`).catch(() => false));
      await cdp.evaluate(page, `document.querySelector('.spm-launcher').click()`);
      const cached = await waitFor(() => statusOf(page));
      const listCallsAfter = mock.calls.filter((c) => c.method === 'list').length;
      await verify.afterReload(cached, listCallsAfter - listCallsBefore);
    }
    check('keine Skriptfehler', cdp.exceptions.length === 0, cdp.exceptions.slice(0, 3).join(' | '));
  } finally {
    await cdp.close();
    await mock.close();
  }
}

await scenario('1) Erstes Laden + Cache nach Neuladen', { total: 1200, port: 8801, reload: true }, {
  async beforeOpen(cdp, page) {
    const token = await waitFor(() => cdp.evaluate(page, 'document.documentElement.dataset.spmToken || ""'));
    check('Button „Karte“ erscheint', await cdp.evaluate(page, `!document.querySelector('.spm-launcher').hidden`));
    check('SynoToken wird mitgelesen', token === 'tok123', token);
  },
  async afterLoad(status, mock) {
    check('alle Fotos geladen', status === `${fmt(800)} von ${fmt(1200)} Fotos haben einen Standort`, status);
    check('API-Aufrufe mit Token', mock.calls.every((c) => c.token === 'tok123'));
  },
  async afterReload(status, newListCalls) {
    check('Standorte kommen aus dem Cache', /800 Fotos mit Standort.*\(Cache\)/.test(status), status);
    check('keine erneuten Listen-Abfragen', newListCalls === 0, `${newListCalls} Abfragen`);
  },
});

await scenario('2) 70.000 Fotos mit NAS-Aussetzer und kurzer Seite', { total: 70000, flaky: true, port: 8802 }, {
  async afterLoad(status) {
    check('trotz Fehler vollständig geladen', status === `${fmt(46667)} von ${fmt(70000)} Fotos haben einen Standort`, status);
  },
});

await scenario('3) Englische Oberfläche (Browser auf en-US)', { total: 30, port: 8803, lang: 'en-US' }, {
  async beforeOpen(cdp, page) {
    const label = await cdp.evaluate(page, `document.querySelector('.spm-launcher span').textContent`);
    check('Button heißt „Map“', label === 'Map', label);
  },
  async afterLoad(status) {
    check('Status auf Englisch', status === '20 of 30 photos have a location', status);
  },
});

await scenario('4) Sprache im Popup umschalten (Browser auf de-DE)', { total: 30, port: 8804 }, {
  async afterLoad(status, mock, cdp, page) {
    const label = () => cdp.evaluate(page, `document.querySelector('.spm-launcher span').textContent`);
    const statusText = () => cdp.evaluate(page, `document.querySelector('.spm-status').textContent`);
    check('startet auf Deutsch', (await label()) === 'Karte' && status === '20 von 30 Fotos haben einen Standort', status);

    const { extOrigin } = await cdp.findMapFrame();
    const popup = await cdp.openPage(`${extOrigin}/popup.html`, { width: 320, height: 500 });
    // wait until popup.js has run (click handlers attached), not just the HTML
    await waitFor(() => cdp.evaluate(popup, `typeof loadLangPack === 'function'`).catch(() => false));
    await cdp.evaluate(popup, `document.querySelector('.seg [data-lang="en"]').click()`);
    const en = await waitFor(async () => ((await label()) === 'Map' ? statusText() : ''));
    check('EN gewählt: Button und Status live auf Englisch', en === '20 of 30 photos have a location', en);
    check('Popup selbst auf Englisch', (await cdp.evaluate(popup, `document.getElementById('clear').textContent`)) === 'Clear cache');

    await cdp.evaluate(popup, `document.querySelector('.seg [data-lang="auto"]').click()`);
    const back = await waitFor(async () => ((await label()) === 'Karte' ? statusText() : ''));
    check('Auto gewählt: zurück zur Browsersprache', back === '20 von 30 Fotos haben einen Standort', back);
  },
});

const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} Prüfungen bestanden`);
process.exit(failed ? 1 : 0);
