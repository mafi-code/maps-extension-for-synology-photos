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

async function scenario(title, { total, flaky = false, port, reload = false }, verify) {
  console.log(`\n${title}`);
  const mock = createMockSynology({ items: makeItems(total), thumb, flaky });
  await mock.listen(port);
  const cdp = await launchBrowser({ extDir: makeTestExtension(), port: port + 1000 });
  const statusOf = (page) => cdp.evaluate(page, `(document.querySelector('.spm-status')||{}).textContent||''`);
  const openMap = async () => {
    const page = await cdp.openPage(`http://127.0.0.1:${port}/`);
    await waitFor(() => cdp.evaluate(page, `!!document.querySelector('.spm-launcher')`).catch(() => false));
    return page;
  };
  try {
    let page = await openMap();
    await verify.beforeOpen?.(cdp, page);
    await cdp.evaluate(page, `document.querySelector('.spm-launcher').click()`);
    const status = await waitFor(async () => {
      const s = await statusOf(page);
      // final states only – "Lade … X mit Standort" is still in progress
      return /haben einen Standort|Fehler|Unvollständig|Keine Fotos/.test(s) ? s : '';
    }, { timeoutMs: 60000 });
    await verify.afterLoad(status, mock);

    if (reload) {
      const listCallsBefore = mock.calls.filter((c) => c.method === 'list').length;
      await cdp.send('Page.reload', {}, page);
      await sleep(1500);
      await waitFor(() => cdp.evaluate(page, `!!document.querySelector('.spm-launcher')`).catch(() => false));
      await cdp.evaluate(page, `document.querySelector('.spm-launcher').click()`);
      const cached = await waitFor(async () => {
        const s = await statusOf(page);
        return /Standort/.test(s) ? s : '';
      });
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

const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} Prüfungen bestanden`);
process.exit(failed ? 1 : 0);
