// Regenerates docs/screenshots/*.webp with synthetic demo data (no real photos).
// Usage: npm run screenshots [-- <outputDir>]
import fs from 'node:fs';
import path from 'node:path';
import { ROOT, createMockSynology, launchBrowser, makeTestExtension, waitFor, sleep } from './harness.mjs';
import { renderScene } from './demo-photos.mjs';

const OUT = path.resolve(process.argv[2] || path.join(ROOT, 'docs', 'screenshots'));
const PORT = 8766;
const W = 1280;
const H = 800;
fs.mkdirSync(OUT, { recursive: true });

// ---------- deterministic demo data ----------
let seed = 42;
const rnd = () => ((seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296);

const PLACES = [
  // [city, country, lat, lng, count, spread, motif]
  ['Barcelona', 'Spanien', 41.39, 2.17, 420, 0.05, { theme: 'beach' }],
  ['Lissabon', 'Portugal', 38.72, -9.14, 260, 0.04, { theme: 'city', roof: 'terracotta' }],
  ['Rom', 'Italien', 41.90, 12.49, 380, 0.04, { theme: 'city', roof: 'terracotta', dome: true }],
  ['Florenz', 'Italien', 43.77, 11.25, 150, 0.03, { theme: 'city', roof: 'terracotta', dome: true }],
  ['Paris', 'Frankreich', 48.86, 2.35, 300, 0.05, { theme: 'city', roof: 'slate' }],
  ['München', 'Deutschland', 48.14, 11.58, 520, 0.06, { theme: 'city' }],
  ['Garmisch-Partenkirchen', 'Deutschland', 47.49, 11.10, 180, 0.06, { theme: 'alpine' }],
  ['Zermatt', 'Schweiz', 46.02, 7.75, 140, 0.05, { theme: 'alpine', peaky: true }],
  ['Wien', 'Österreich', 48.21, 16.37, 210, 0.04, { theme: 'city' }],
  ['Amsterdam', 'Niederlande', 52.37, 4.90, 190, 0.04, { theme: 'canal' }],
  ['Kopenhagen', 'Dänemark', 55.68, 12.57, 120, 0.04, { theme: 'canal' }],
  ['Split', 'Kroatien', 43.51, 16.44, 230, 0.06, { theme: 'beach' }],
  ['Santorini', 'Griechenland', 36.40, 25.46, 170, 0.06, { theme: 'island' }],
  ['Hamburg', 'Deutschland', 53.55, 9.99, 160, 0.05, { theme: 'canal', brick: true }],
  ['Lofoten', 'Norwegen', 68.15, 13.60, 110, 0.15, { theme: 'fjord' }],
];

const motifs = new Map(); // photo id -> motif
const items = [];
let nextId = 1;
const pad = (n) => String(n).padStart(2, '0');
for (const [city, country, lat, lng, count, spread, motif] of PLACES) {
  const year = 2019 + Math.floor(rnd() * 6);
  const month = 1 + Math.floor(rnd() * 12);
  for (let i = 0; i < count; i++) {
    const id = nextId++;
    const day = 1 + Math.floor(rnd() * 27);
    const hh = 8 + Math.floor(rnd() * 12);
    const mm = Math.floor(rnd() * 60);
    const ts = Date.UTC(year, month - 1, day, hh, mm) / 1000;
    motifs.set(id, motif);
    items.push({
      id,
      filename: `IMG_${year}${pad(month)}${pad(day)}_${pad(hh)}${pad(mm)}${pad(i % 60)}.jpg`,
      time: ts,
      type: 'photo',
      additional: {
        thumbnail: { cache_key: `${id}_${ts}`, unit_id: id, sm: 'ready', m: 'ready', xl: 'ready' },
        gps: { latitude: lat + (rnd() - 0.5) * spread * 2, longitude: lng + (rnd() - 0.5) * spread * 3 },
        address: { city, country },
      },
    });
  }
}
for (let i = 0; i < 900; i++) { // photos without location exist in every library
  const id = nextId++;
  items.push({ id, filename: `IMG_${id}.jpg`, time: 1600000000 + id * 3600, type: 'photo',
    additional: { thumbnail: { cache_key: `${id}_1`, unit_id: id, sm: 'ready', m: 'ready', xl: 'ready' } } });
}

// ---------- photo-like demo images (tools/demo-photos.mjs) ----------
const scene = (id, size) => renderScene(motifs.get(id) || { theme: 'city' }, id, size === 'xl' ? 640 : 240);

// Neutral demo photo grid – deliberately not a copy of the Synology UI.
const page = () => `<!doctype html><html lang="de"><head><meta charset="utf-8"><title>Fotos – Demo</title>
<style>
  body{margin:0;font:14px/1.4 system-ui,-apple-system,"Segoe UI",sans-serif;color:#1f2329;background:#f6f7f9}
  header{display:flex;align-items:center;gap:12px;height:56px;padding:0 24px;background:#fff;border-bottom:1px solid #e3e6ea}
  header b{font-size:17px} header span{color:#6b7480;font-size:13px}
  main{padding:20px 24px} h2{font-size:15px;margin:8px 0 12px;color:#3a424d}
  .grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:4px}
  .grid img{width:100%;aspect-ratio:1;object-fit:cover;display:block;border-radius:2px}
</style></head><body>
<header><b>Fotos</b><span>Demo-Fotobibliothek mit Beispieldaten</span></header>
<main><h2>Juni 2024</h2><div class="grid">${items.filter((_, i) => i % 67 === 5).slice(0, 48).map((it) => `<img src="/thumb/${it.id}" alt="">`).join('')}</div></main>
</body></html>`;

// ---------- capture ----------
const mock = createMockSynology({ items, thumb: scene, page });
await mock.listen(PORT);
const cdp = await launchBrowser({ extDir: makeTestExtension({ demoHook: true }), port: PORT + 1000 });

const shot = async (name, sessionId, clip) => {
  const r = await cdp.send('Page.captureScreenshot', { format: 'webp', quality: 88, ...(clip ? { clip } : {}) }, sessionId);
  const file = path.join(OUT, `${name}.webp`);
  fs.writeFileSync(file, Buffer.from(r.data, 'base64'));
  console.log(`  ${path.relative(ROOT, file)}  ${Math.round(fs.statSync(file).size / 1024)} KB`);
};

try {
  const pageSession = await cdp.openPage(`http://127.0.0.1:${PORT}/photo/`, { width: W, height: H, scale: 2 });
  await waitFor(() => cdp.evaluate(pageSession, `!!document.querySelector('.spm-launcher')`).catch(() => false));
  await sleep(1500); // let the grid thumbnails paint
  await shot('01-button', pageSession);

  await cdp.evaluate(pageSession, `document.querySelector('.spm-launcher').click()`);
  const frame = await cdp.findMapFrame();
  await waitFor(() => cdp.evaluate(pageSession, `/haben einen Standort|Cache/.test(document.querySelector('.spm-status').textContent)`));
  const onMap = (expr) => cdp.evaluate(frame.sessionId, expr);

  // wait until every marker is on the map, then count as "user moved the map"
  // so the extension's automatic fit-to-all does not override the chosen view
  const withGps = items.filter((it) => it.additional.gps).length;
  await waitFor(() => onMap(`window.__spmDemo.cluster.getLayers().length === ${withGps}`), { timeoutMs: 60000 });
  await onMap(`void window.__spmDemo.map.getContainer().dispatchEvent(new PointerEvent('pointerdown'))`);
  await sleep(1000);
  await onMap(`void window.__spmDemo.map.setView([47.2, 10.5], 5, { animate: false })`);
  await sleep(6000);
  console.log('  overview view:', await onMap(`(() => { const m = window.__spmDemo.map; const c = m.getCenter(); return m.getZoom() + ' @ ' + c.lat.toFixed(2) + ',' + c.lng.toFixed(2); })()`));
  await shot('02-overview', pageSession);

  await onMap(`void window.__spmDemo.map.setView([41.392, 2.168], 13, { animate: false })`);
  await sleep(6000);
  await shot('03-city', pageSession);

  await onMap(`new Promise((resolve) => {
    const { map, cluster } = window.__spmDemo;
    map.setView([41.392, 2.168], 16, { animate: false });
    setTimeout(() => {
      let pick = null;
      const c = map.getCenter();
      cluster.eachLayer((m) => {
        if (cluster.getVisibleParent(m) !== m) return;
        const d = m.getLatLng().distanceTo(c);
        if (!pick || d < pick.d) pick = { m, d };
      });
      if (pick) pick.m.openPopup();
      resolve(Boolean(pick));
    }, 1500);
  })`);
  await sleep(1500);
  await onMap(`void window.__spmDemo.map.panBy([0, -150], { animate: false })`);
  await sleep(5000);
  await shot('04-popup', pageSession);

  // extension popup in its "enabled" state
  const popup = await cdp.openPage(`${frame.extOrigin}/popup.html`, { width: 312, height: 400, scale: 2 });
  await waitFor(() => cdp.evaluate(popup, `typeof render === 'function'`).catch(() => false));
  await cdp.evaluate(popup, `$('site').textContent = '192.168.1.10:5001'; render(true); $('hint').textContent = '';`);
  await sleep(300);
  const h = await cdp.evaluate(popup, `Math.ceil(document.body.getBoundingClientRect().height)`);
  await shot('05-popup-ui', popup, { x: 0, y: 0, width: 312, height: h, scale: 1 });
} finally {
  await cdp.close();
  await mock.close();
}
